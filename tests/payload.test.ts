import { describe, expect, it } from "vitest";
import type { DraftFields, UploadedMedia } from "../src/contracts.js";
import { buildTistoryPostBody } from "../src/providers/tistory/payload.js";

const draft: DraftFields = {
  provider: "tistory",
  connectionId: "default",
  title: " A title ",
  markdown: "# Body",
  tags: ["alpha", " alpha ", "beta"],
  categoryId: 7,
};

const representativeImage: UploadedMedia = {
  provider: "tistory",
  connectionId: "default",
  filename: "cover.png",
  mimeType: "image/png",
  size: 100,
  width: 640,
  height: 360,
  attachmentRef: "kage@abc/cover.png?credential=x&amp;expires=9",
  substitution:
    '[##_Image|kage@abc/cover.png?credential=x&amp;expires=9|CDM|1.3|{"originWidth":640,"originHeight":360,"style":"alignCenter"}_##]',
};

describe("buildTistoryPostBody", () => {
  it("maps private and public visibility to captured integer values", () => {
    expect(buildTistoryPostBody(draft, "private").visibility).toBe(0);
    expect(buildTistoryPostBody(draft, "public").visibility).toBe(20);
  });

  it("keeps representative image fields on one attachment reference", () => {
    const body = buildTistoryPostBody(draft, "private", representativeImage);
    expect(body.title).toBe("A title");
    expect(body.tag).toBe("alpha,beta");
    expect(body.attachments).toEqual([representativeImage.attachmentRef]);
    expect(body.thumbnail).toBe(representativeImage.attachmentRef);
    expect(body.content.startsWith(representativeImage.substitution)).toBe(true);
  });
});
