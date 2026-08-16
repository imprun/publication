import type { WindforceContext } from "@imprun/app-sdk";
import type {
  DraftFields,
  PostDeleteInput,
  PostPublishInput,
  PostUpdateInput,
  UploadedMedia,
} from "../contracts.js";

export interface PreparedDraft {
  provider: "tistory";
  connectionId: "default";
  title: string;
  categoryId: number;
  tags: string[];
  markdownHash: string;
  renderedHtmlHash: string;
  draftHash: string;
  renderedHtml: string;
}

export interface PublicationProvider {
  prepare(input: DraftFields): PreparedDraft;
  publish(input: PostPublishInput, ctx: WindforceContext): Promise<PublishedPost>;
  update(input: PostUpdateInput, ctx: WindforceContext): Promise<PublishedPost>;
  delete(input: PostDeleteInput, ctx: WindforceContext): Promise<DeletedPost>;
  upload(
    input: { filename: string; mimeType: string; contentBase64: string },
    ctx: WindforceContext,
  ): Promise<UploadedMedia>;
}

export interface PublishedPost {
  provider: "tistory";
  connectionId: "default";
  postId: string;
  entryUrl: string;
  visibility: "private" | "public";
  representativeImageApplied: boolean;
}

export interface DeletedPost {
  provider: "tistory";
  connectionId: "default";
  postId: string;
  deleted: true;
}
