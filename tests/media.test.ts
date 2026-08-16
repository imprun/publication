import { describe, expect, it } from "vitest";
import {
  buildAttachmentRef,
  buildImageSubstitution,
  decodeImage,
  parseImageDimensions,
} from "../src/providers/tistory/media.js";

describe("Tistory media", () => {
  it("parses PNG dimensions without decoding the image", () => {
    const bytes = Buffer.alloc(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
    bytes.writeUInt32BE(640, 16);
    bytes.writeUInt32BE(360, 20);
    expect(parseImageDimensions(bytes)).toEqual({ width: 640, height: 360 });
  });

  it("uses one signed attachment identity in substitution", () => {
    const ref = buildAttachmentRef({
      name: "cover.png",
      filename: "cover.png",
      key: "abc/def",
      size: 10,
      url: "https://blog.kakaocdn.net/dna/abc/cover.png?credential=x&expires=9",
    });
    expect(ref).toBe("kage@abc/def/cover.png?credential=x&amp;expires=9");
    expect(buildImageSubstitution(ref, { width: 640, height: 360 })).toContain(ref);
  });

  it("rejects unsupported or malformed base64", () => {
    expect(() => decodeImage("%%%%", "image/png")).toThrow("base64");
    expect(() => decodeImage("AA==", "image/svg+xml")).toThrow("unsupported");
  });
});
