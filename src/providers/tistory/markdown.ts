import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const IMAGE_SUBSTITUTION_RE = /\[##_Image\|[\s\S]*?_##\]/g;

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "div",
    "span",
    "br",
    "hr",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "sub",
    "sup",
    "small",
    "blockquote",
    "q",
    "cite",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "pre",
    "code",
    "kbd",
    "samp",
    "var",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
    "a",
    "img",
    "figure",
    "figcaption",
    "picture",
    "source",
    "iframe",
    "abbr",
    "address",
    "time",
    "details",
    "summary",
  ],
  allowedAttributes: {
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
    a: ["href", "name", "target", "rel", "title"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    source: ["src", "srcset", "type", "media"],
    span: ["style", "class"],
    div: ["class", "style", "data-*"],
    p: ["class", "style", "data-ke-size", "data-*"],
    figure: ["class", "data-*"],
    figcaption: ["class"],
    blockquote: ["class", "cite", "data-*"],
    pre: ["class"],
    code: ["class"],
    table: ["class", "style"],
    th: ["colspan", "rowspan", "scope", "style"],
    td: ["colspan", "rowspan", "style"],
    col: ["span", "style"],
    iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen", "title"],
    time: ["datetime"],
    abbr: ["title"],
    ol: ["start", "type"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  disallowedTagsMode: "discard",
};

function placeholder(index: number): string {
  return `TISTORYIMAGEPLACEHOLDER${index}TISTORYIMAGEPLACEHOLDER`;
}

export function markdownToTistoryHtml(markdown: string): string {
  const substitutions: string[] = [];
  const protectedMarkdown = markdown.replace(IMAGE_SUBSTITUTION_RE, (value) => {
    substitutions.push(value);
    return placeholder(substitutions.length - 1);
  });
  const rendered = marked.parse(protectedMarkdown, { gfm: true, breaks: true }) as string;
  let safe = sanitizeHtml(rendered, sanitizeOptions);
  substitutions.forEach((substitution, index) => {
    safe = safe.split(placeholder(index)).join(substitution);
  });
  return safe;
}
