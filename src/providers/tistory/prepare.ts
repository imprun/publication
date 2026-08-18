import { createHash } from "node:crypto";
import type { DraftFields } from "../../contracts.js";
import type { PreparedDraft } from "../provider.js";
import { renderTistoryContent } from "./content.js";
import { normalizeTags } from "./payload.js";

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function prepareDraft(input: DraftFields): PreparedDraft {
  const title = input.title.trim();
  const tags = normalizeTags(input.tags);
  const renderedHtml = renderTistoryContent(input.content);
  const canonical = JSON.stringify({
    provider: input.provider,
    connectionId: input.connectionId,
    title,
    content: input.content,
    tags,
    categoryId: input.categoryId,
  });
  return {
    provider: "tistory",
    connectionId: "default",
    title,
    categoryId: input.categoryId,
    tags,
    sourceFormat: input.content.format,
    sourceHash: sha256(input.content.body),
    renderedHtmlHash: sha256(renderedHtml),
    draftHash: sha256(canonical),
    renderedHtml,
  };
}
