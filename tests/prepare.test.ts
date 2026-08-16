import { describe, expect, it } from "vitest";
import { prepareDraft } from "../src/providers/tistory/prepare.js";

const base = {
  provider: "tistory" as const,
  connectionId: "default" as const,
  title: "Title",
  markdown: "**body**",
  tags: ["one", "two"],
  categoryId: 1,
};

describe("prepareDraft", () => {
  it("is deterministic and normalizes duplicate tags", () => {
    const first = prepareDraft({ ...base, tags: ["one", " one ", "two"] });
    const second = prepareDraft(base);
    expect(first.draftHash).toBe(second.draftHash);
    expect(first.tags).toEqual(["one", "two"]);
    expect(first.renderedHtml).toContain("<strong>body</strong>");
  });

  it("changes the approval hash for any effective draft change", () => {
    expect(prepareDraft(base).draftHash).not.toBe(
      prepareDraft({ ...base, categoryId: 2 }).draftHash,
    );
  });
});
