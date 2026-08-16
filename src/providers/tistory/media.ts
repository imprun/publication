import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from "../../config.js";

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface TistoryUploadResponse {
  name: string;
  url: string;
  key: string;
  filename: string;
  size: number;
}

export function decodeImage(contentBase64: string, mimeType: string): Uint8Array {
  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error(`unsupported image MIME type: ${mimeType}`);
  }
  const normalized = contentBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("contentBase64 is not valid base64");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
  }
  if (buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("contentBase64 is not valid base64");
  }
  return buffer;
}

export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return parseWebpDimensions(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return parseJpegDimensions(buffer);
  }
  return null;
}

function parseWebpDimensions(buffer: Buffer): ImageDimensions | null {
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8 " && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b0 = buffer[21] ?? 0;
    const b1 = buffer[22] ?? 0;
    const b2 = buffer[23] ?? 0;
    const b3 = buffer[24] ?? 0;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (format === "VP8X" && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  return null;
}

function parseJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

export function buildAttachmentRef(upload: TistoryUploadResponse): string {
  const query = new URL(upload.url).search.replace(/&/g, "&amp;");
  return `kage@${upload.key}/${upload.filename}${query}`;
}

export function buildImageSubstitution(attachmentRef: string, dimensions: ImageDimensions): string {
  const metadata = JSON.stringify({
    originWidth: dimensions.width,
    originHeight: dimensions.height,
    style: "alignCenter",
  });
  return `[##_Image|${attachmentRef}|CDM|1.3|${metadata}_##]`;
}
