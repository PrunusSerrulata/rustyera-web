import { describe, expect, it } from "vitest";

import { sameServiceInteger } from "@/core/runtimeServiceProtocol";

describe("service integer equality", () => {
  it("preserves the validated BigInt comparison for all representation pairs", () => {
    const values: unknown[] = [
      0,
      -0,
      1,
      -1,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      0n,
      1n,
      -1n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MIN_SAFE_INTEGER),
      1n << 64n,
      -(1n << 64n),
      "0",
      "1",
      null,
      undefined,
      true,
      false,
      Symbol("invalid"),
      {},
      {
        valueOf() {
          throw new Error("must not coerce");
        },
      },
    ];
    const valid = (value: unknown): value is number | bigint =>
      typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
    for (const left of values)
      for (const right of values) {
        const expected = valid(left) && valid(right) && BigInt(left) === BigInt(right);
        expect(sameServiceInteger(left, right)).toBe(expected);
      }
  });
});
