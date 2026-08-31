import { describe, expect, it } from "vitest";

import { decodeImageMetadata } from "@/core/imageMetadata";

describe("image metadata header decoder", () => {
  it("reads PNG dimensions and animation without decoding pixels", () => {
    const bytes = new Uint8Array(65);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeU32be(bytes, 8, 13);
    bytes.set(ascii("IHDR"), 12);
    writeU32be(bytes, 16, 1920);
    writeU32be(bytes, 20, 1080);
    writeU32be(bytes, 33, 8);
    bytes.set(ascii("acTL"), 37);

    expect(decodeImageMetadata(bytes)).toEqual({
      width: 1920,
      height: 1080,
      format: "png",
      animated: true,
    });
  });

  it("reads animated WebP VP8X dimensions", () => {
    const bytes = new Uint8Array(30);
    bytes.set(ascii("RIFF"));
    bytes.set(ascii("WEBP"), 8);
    bytes.set(ascii("VP8X"), 12);
    writeU32le(bytes, 16, 10);
    bytes[20] = 0x02;
    writeU24le(bytes, 24, 799);
    writeU24le(bytes, 27, 599);

    expect(decodeImageMetadata(bytes)).toEqual({
      width: 800,
      height: 600,
      format: "webp",
      animated: true,
    });
  });

  it("reads lossless WebP dimensions from a bounded prefix", () => {
    const bytes = new Uint8Array(25);
    bytes.set(ascii("RIFF"));
    bytes.set(ascii("WEBP"), 8);
    bytes.set(ascii("VP8L"), 12);
    writeU32le(bytes, 16, 2 * 1024 * 1024);
    bytes[20] = 0x2f;
    writeU32le(bytes, 21, (640 - 1) | ((480 - 1) << 14));

    expect(decodeImageMetadata(bytes)).toEqual({
      width: 640,
      height: 480,
      format: "webp",
      animated: false,
    });
  });

  it("rejects malformed resources", () => {
    expect(() => decodeImageMetadata(ascii("not an image"))).toThrow(
      "unsupported or malformed image resource",
    );
  });
});

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value);
}

function writeU32le(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function writeU24le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}
