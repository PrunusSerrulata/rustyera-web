export interface ImageMetadata {
  width: number;
  height: number;
  format: "png" | "bmp" | "gif" | "jpeg" | "webp";
  animated: boolean;
}

export function decodeImageMetadata(data: Uint8Array): ImageMetadata {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const [width, height] = pngSize(data);
    return metadata(width, height, "png", pngIsAnimated(data));
  }
  if (ascii(data, 0, 2) === "BM") {
    const [width, height] = bmpSize(data);
    return metadata(width, height, "bmp", false);
  }
  const gifHeader = ascii(data, 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    const [width, height] = gifSize(data);
    return metadata(width, height, "gif", includesAscii(data, "NETSCAPE2.0"));
  }
  if (startsWith(data, [0xff, 0xd8])) {
    const [width, height] = jpegSize(data);
    return metadata(width, height, "jpeg", false);
  }
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    const [width, height, animated] = webpSize(data);
    return metadata(width, height, "webp", animated);
  }
  throw new Error("unsupported or malformed image resource");
}

function metadata(
  width: number,
  height: number,
  format: ImageMetadata["format"],
  animated: boolean,
): ImageMetadata {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error("image dimensions are out of range");
  return { width, height, format, animated };
}

function pngSize(data: Uint8Array): [number, number] {
  if (data.length < 24 || ascii(data, 12, 4) !== "IHDR") throw new Error("malformed PNG header");
  const view = viewOf(data);
  return [view.getUint32(16), view.getUint32(20)];
}

function pngIsAnimated(data: Uint8Array): boolean {
  const view = viewOf(data);
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > data.length) return false;
    const kind = ascii(data, offset + 4, 4);
    if (kind === "acTL") return true;
    if (kind === "IEND") return false;
    offset = end;
  }
  return false;
}

function bmpSize(data: Uint8Array): [number, number] {
  if (data.length < 26) throw new Error("malformed BMP header");
  const view = viewOf(data);
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) return [view.getUint16(18, true), view.getUint16(20, true)];
  if (dibSize < 40) throw new Error("unsupported BMP header");
  return [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))];
}

function gifSize(data: Uint8Array): [number, number] {
  if (data.length < 10) throw new Error("malformed GIF header");
  const view = viewOf(data);
  return [view.getUint16(6, true), view.getUint16(8, true)];
}

function jpegSize(data: Uint8Array): [number, number] {
  let offset = 2;
  const view = viewOf(data);
  while (offset < data.length) {
    while (offset < data.length && data[offset] !== 0xff) offset += 1;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > data.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > data.length) break;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (length < 7) break;
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    }
    offset += length;
  }
  throw new Error("malformed JPEG header");
}

function webpSize(data: Uint8Array): [number, number, boolean] {
  const view = viewOf(data);
  let offset = 12;
  while (offset + 8 <= data.length) {
    const kind = ascii(data, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + length > data.length) break;
    if (kind === "VP8X" && length >= 10) {
      return [
        1 + uint24le(data, payload + 4),
        1 + uint24le(data, payload + 7),
        Boolean(data[payload] & 0x02),
      ];
    }
    if (kind === "VP8 " && length >= 10 && startsWith(data, [0x9d, 0x01, 0x2a], payload + 3)) {
      return [
        view.getUint16(payload + 6, true) & 0x3fff,
        view.getUint16(payload + 8, true) & 0x3fff,
        false,
      ];
    }
    if (kind === "VP8L" && length >= 5 && data[payload] === 0x2f) {
      const bits = view.getUint32(payload + 1, true);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff), false];
    }
    offset += 8 + length + (length & 1);
  }
  throw new Error("malformed WebP header");
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(data: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((byte, index) => data[offset + index] === byte);
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (offset + length > data.length) return "";
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function includesAscii(data: Uint8Array, needle: string): boolean {
  const bytes = [...needle].map((character) => character.charCodeAt(0));
  outer: for (let offset = 0; offset + bytes.length <= data.length; offset += 1) {
    for (let index = 0; index < bytes.length; index += 1)
      if (data[offset + index] !== bytes[index]) continue outer;
    return true;
  }
  return false;
}

function uint24le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}
