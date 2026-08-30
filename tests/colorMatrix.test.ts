import { describe, expect, it } from "vitest";

import { decodeFixedColorMatrix, fixedColorMatrixFilter } from "@/core/colorMatrix";

describe("fixed HTML color matrix decoding", () => {
  it("accepts the authoritative adjacent-tagged fixed shape without structural coercion", () => {
    const value = Array.from({ length: 25 }, (_, index) => (index % 6 === 0 ? 256 : 0));
    expect(decodeFixedColorMatrix({ type: "fixed", value })).toEqual(value);
    expect(fixedColorMatrixFilter({ type: "fixed", value })?.split(" ")).toHaveLength(20);
  });

  it.each([
    Array(25).fill(0),
    { type: "fixed" },
    { type: "variable", value: 1 },
    { type: "fixed", value: Array(24).fill(0) },
    { type: "fixed", value: [...Array(24).fill(0), 1.5] },
  ])("reports malformed matrices as protocol errors", (value) => {
    expect(() => decodeFixedColorMatrix(value)).toThrow("fixed 5x5 matrix");
  });
});
