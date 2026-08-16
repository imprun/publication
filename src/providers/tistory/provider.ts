import type { WindforceContext } from "windforce-client";
import type {
  DraftFields,
  PostDeleteInput,
  PostPublishInput,
  PostUpdateInput,
  UploadedMedia,
} from "../../contracts.js";
import { uploadedMediaSchema } from "../../contracts.js";
import { loadTistoryConnection } from "../../session.js";
import type { DeletedPost, PublicationProvider, PublishedPost } from "../provider.js";
import { TistoryClient, uploadImage } from "./client.js";
import {
  buildAttachmentRef,
  buildImageSubstitution,
  decodeImage,
  parseImageDimensions,
} from "./media.js";
import { buildTistoryPostBody } from "./payload.js";
import { prepareDraft } from "./prepare.js";

interface ApprovalValue {
  approved: boolean;
}

interface PostResponse {
  entryUrl: string;
}

export class TistoryProvider implements PublicationProvider {
  prepare(input: DraftFields) {
    return prepareDraft(input);
  }

  async upload(
    input: { filename: string; mimeType: string; contentBase64: string },
    ctx: WindforceContext,
  ): Promise<UploadedMedia> {
    const bytes = decodeImage(input.contentBase64, input.mimeType);
    const dimensions = parseImageDimensions(bytes);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      throw new Error("image dimensions could not be determined");
    }
    const client = await clientFromContext(ctx);
    const upload = await uploadImage(client, bytes, input.filename, input.mimeType);
    const attachmentRef = buildAttachmentRef(upload);
    return uploadedMediaSchema.parse({
      provider: "tistory",
      connectionId: "default",
      filename: upload.filename,
      mimeType: input.mimeType,
      size: upload.size,
      width: dimensions.width,
      height: dimensions.height,
      attachmentRef,
      substitution: buildImageSubstitution(attachmentRef, dimensions),
    });
  }

  async publish(input: PostPublishInput, ctx: WindforceContext): Promise<PublishedPost> {
    assertDraftHash(input);
    await requirePostApproval(ctx, "publish", input);
    const client = await clientFromContext(ctx);
    const body = buildTistoryPostBody(input, input.visibility, input.representativeImage);
    const response = await client.requestJson<PostResponse>("/manage/post.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const { entryUrl, postId } = validateEntryUrl(client.host, response.entryUrl);
    return {
      provider: "tistory",
      connectionId: "default",
      postId,
      entryUrl,
      visibility: input.visibility,
      representativeImageApplied: Boolean(input.representativeImage),
    };
  }

  async update(input: PostUpdateInput, ctx: WindforceContext): Promise<PublishedPost> {
    assertDraftHash(input);
    await requirePostApproval(ctx, "update", input);
    const client = await clientFromContext(ctx);
    const body = buildTistoryPostBody(
      input,
      input.visibility,
      input.representativeImage,
      input.postId,
    );
    const response = await client.requestJson<PostResponse>(`/manage/post/${input.postId}.json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const { entryUrl, postId } = validateEntryUrl(client.host, response.entryUrl);
    if (postId !== input.postId) throw new Error("Tistory updated an unexpected post ID");
    return {
      provider: "tistory",
      connectionId: "default",
      postId,
      entryUrl,
      visibility: input.visibility,
      representativeImageApplied: Boolean(input.representativeImage),
    };
  }

  async delete(input: PostDeleteInput, ctx: WindforceContext): Promise<DeletedPost> {
    const decision = await ctx.human.wait<ApprovalValue>({
      key: "tistory-delete-approval",
      kind: "form",
      title: `티스토리 글 ${input.postId} 삭제 승인`,
      description: `삭제 대상 제목 확인: ${input.expectedTitle}`,
      inputSchema: approvalSchema(),
      privateContext: { provider: "tistory", postId: input.postId },
      timeoutMs: 5 * 60 * 1000,
    });
    assertApproved(decision.outcome, decision.value);
    const client = await clientFromContext(ctx);
    await client.requestJson(`/manage/post/${input.postId}.json`, { method: "DELETE" });
    return { provider: "tistory", connectionId: "default", postId: input.postId, deleted: true };
  }
}

async function clientFromContext(ctx: WindforceContext): Promise<TistoryClient> {
  const { connection, session } = await loadTistoryConnection(ctx);
  return new TistoryClient(ctx.http.fetch.bind(ctx.http), connection, session);
}

function assertDraftHash(input: PostPublishInput | PostUpdateInput): void {
  const current = prepareDraft(input).draftHash;
  if (input.draftHash !== current) {
    throw new Error("draftHash does not match the effective title, Markdown, tags, or category");
  }
}

async function requirePostApproval(
  ctx: WindforceContext,
  operation: "publish" | "update",
  input: PostPublishInput | PostUpdateInput,
): Promise<void> {
  const visibilityLabel = input.visibility === "public" ? "공개" : "비공개";
  const operationLabel = operation === "publish" ? "게시" : "수정";
  const decision = await ctx.human.wait<ApprovalValue>({
    key: `tistory-${operation}-approval`,
    kind: "form",
    title: `${visibilityLabel} ${operationLabel} 승인`,
    description: [
      `제목: ${input.title.trim()}`,
      `카테고리 ID: ${input.categoryId}`,
      `태그: ${input.tags.join(", ") || "없음"}`,
      `대표 이미지: ${input.representativeImage?.filename ?? "없음"}`,
    ].join("\n"),
    inputSchema: approvalSchema(),
    privateContext: {
      provider: "tistory",
      operation,
      draftHash: input.draftHash,
      visibility: input.visibility,
    },
    timeoutMs: 5 * 60 * 1000,
  });
  assertApproved(decision.outcome, decision.value);
}

function approvalSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["approved"],
    properties: {
      approved: { type: "boolean", const: true, title: "이 작업을 승인합니다" },
    },
  };
}

function assertApproved(outcome: "submit" | "cancel", value?: ApprovalValue): void {
  if (outcome !== "submit" || value?.approved !== true)
    throw new Error("operation was not approved");
}

export function validateEntryUrl(host: string, rawEntryUrl: string) {
  const url = new URL(rawEntryUrl, `https://${host}`);
  if (url.protocol !== "https:" || url.hostname !== host) {
    throw new Error("Tistory returned an entry URL outside the connected blog");
  }
  const postId = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!/^\d+$/.test(postId)) throw new Error("Tistory returned an invalid post URL");
  return { entryUrl: url.toString(), postId };
}
