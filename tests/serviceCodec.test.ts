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
});
