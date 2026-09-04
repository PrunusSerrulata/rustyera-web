import { describe, expect, it } from "vitest";

import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";

describe("runtime service CBOR codec", () => {
  it("encodes a bare canonical-compatible map without cbor-x tag 259", () => {
    const encoded = encodeServicePayload(
      new Map<number, unknown>([
        [0, 640],
        [1, "webp"],
      ]),
    );

    expect(encoded[0]).toBe(0xa2);
    expect(decodeServicePayload(encoded)).toEqual(
      new Map<number, unknown>([
        [0, 640],
        [1, "webp"],
      ]),
    );
  });

  it("decodes byte payloads projected from WASM as BigInts", () => {
    const encoded = encodeServicePayload(new Map<number, unknown>([[0, "resources/TITLE.png"]]));
    const projected = BigUint64Array.from(encoded, BigInt);

    expect(decodeServicePayload(projected)).toEqual(
      new Map<number, unknown>([[0, "resources/TITLE.png"]]),
    );
  });

  it("uses shortest-form CBOR for small bigint service results", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const encoded = encodeServicePayload(
      new Map<number, unknown>([
        [0, 0n],
        [1, -1n],
        [2, bytes],
      ]),
    );

    expect([...encoded]).toEqual([0xa3, 0x00, 0x00, 0x01, 0x20, 0x02, 0x43, 0x01, 0x02, 0x03]);
    expect(decodeServicePayload(encoded)).toEqual(
      new Map<number, unknown>([
        [0, 0],
        [1, -1],
        [2, bytes],
      ]),
    );
  });

  it("rejects projected values outside the byte range", () => {
    expect(() => decodeServicePayload(BigUint64Array.from([256n]))).toThrow(
      "runtime service payload contains a non-byte value",
    );
  });
});
