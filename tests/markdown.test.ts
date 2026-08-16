import { describe, expect, it } from "vitest";
import { markdownToTistoryHtml } from "../src/providers/tistory/markdown.js";

describe("markdownToTistoryHtml", () => {
  it("renders GFM Markdown and removes executable HTML", () => {
    const html = markdownToTistoryHtml(
      "# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>",
    );
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script");
  });

  it("preserves Tistory image substitutions byte-for-byte", () => {
    const substitution =
      '[##_Image|kage@key/file.png?credential=a&amp;expires=1|CDM|1.3|{"originWidth":10,"originHeight":20,"style":"alignCenter"}_##]';
    expect(markdownToTistoryHtml(`${substitution}\n\n**body**`)).toContain(substitution);
  });
});
