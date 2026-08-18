import { describe, expect, it } from "vitest";
import { renderTistoryContent } from "../src/providers/tistory/content.js";

describe("renderTistoryContent", () => {
  it("renders GFM Markdown and removes executable HTML", () => {
    const html = renderTistoryContent({
      format: "markdown",
      body: "# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>",
    });
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script");
  });

  it("sanitizes HTML without parsing it as Markdown", () => {
    const html = renderTistoryContent({
      format: "html",
      body: '<h2>HTML body</h2><img src="https://example.com/a.png" onerror="alert(1)"><script>alert(2)</script>',
    });
    expect(html).toContain("<h2>HTML body</h2>");
    expect(html).toContain('<img src="https://example.com/a.png" />');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("preserves Tistory image substitutions byte-for-byte", () => {
    const substitution =
      '[##_Image|kage@key/file.png?credential=a&amp;expires=1|CDM|1.3|{"originWidth":10,"originHeight":20,"style":"alignCenter"}_##]';
    expect(
      renderTistoryContent({ format: "markdown", body: `${substitution}\n\n**body**` }),
    ).toContain(substitution);
  });
});
