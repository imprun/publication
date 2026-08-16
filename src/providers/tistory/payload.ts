import type { DraftFields, UploadedMedia } from "../../contracts.js";
import { markdownToTistoryHtml } from "./markdown.js";

export type TistoryVisibility = 0 | 20;

export interface TistoryPostBody {
  id: string;
  title: string;
  content: string;
  slogan: string;
  visibility: TistoryVisibility;
  category: number;
  tag: string;
  published: 1;
  password: string;
  uselessMarginForEntry: 1;
  cclCommercial: 0;
  cclDerive: 0;
  type: "post";
  attachments: string[];
  thumbnail: string;
  recaptchaValue: string;
  draftSequence: null;
  totalWritingTimeMs: 0;
}

export function buildTistoryPostBody(
  draft: DraftFields,
  visibility: "private" | "public",
  representativeImage?: UploadedMedia,
  postId = "0",
): TistoryPostBody {
  const bodyHtml = markdownToTistoryHtml(draft.markdown);
  const content = representativeImage
    ? `${representativeImage.substitution}\n${bodyHtml}`
    : bodyHtml;
  return {
    id: postId,
    title: draft.title.trim(),
    content,
    slogan: "",
    visibility: visibility === "public" ? 20 : 0,
    category: draft.categoryId,
    tag: normalizeTags(draft.tags).join(","),
    published: 1,
    password: "",
    uselessMarginForEntry: 1,
    cclCommercial: 0,
    cclDerive: 0,
    type: "post",
    attachments: representativeImage ? [representativeImage.attachmentRef] : [],
    // Tistory includes this field in the captured publish contract. The same signed
    // attachment reference keeps the representative image and attachment identity aligned.
    thumbnail: representativeImage?.attachmentRef ?? "",
    recaptchaValue: "",
    draftSequence: null,
    totalWritingTimeMs: 0,
  };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
