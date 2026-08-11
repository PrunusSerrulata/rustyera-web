import { describe, expect, it } from "vitest";

import {
  projectPresentationLength,
  projectRectangleShape,
  projectSpaceShape,
} from "@/core/shapeProjection";
import type { PresentationLength } from "@/core/types";

describe("shape presentation projection", () => {
  it("projects every supported presentation length unit", () => {
    expect(projectPresentationLength({ unit: "logical", value: 2500 }, 16)).toBe(2.5);
    expect(projectPresentationLength({ unit: "pixels", value: 12 }, 16)).toBe(12);
    expect(projectPresentationLength({ unit: "font_height_hundredths", value: 125 }, 16)).toBe(20);
    expect(
      projectPresentationLength({ unit: "unknown", value: 1 } as unknown as PresentationLength, 16),
    ).toBeUndefined();
    expect(
      projectPresentationLength({ unit: "pixels", value: Number.POSITIVE_INFINITY }, 16),
    ).toBeUndefined();
  });

  it("uses one console row for a single-parameter rectangle", () => {
    expect(projectRectangleShape([{ unit: "pixels", value: 10 }], 16)).toEqual({
      slot: { width: 10, height: 16 },
      visual: { left: 0, top: 0, width: 10, height: 16 },
    });
  });

  it("projects a four-parameter rectangle and reserves negative-y overflow", () => {
    const pixels = (value: number): PresentationLength => ({ unit: "pixels", value });
    expect(projectRectangleShape([pixels(2), pixels(-4), pixels(8), pixels(6)], 16)).toEqual({
      slot: { width: 10, height: 20 },
      visual: { left: 2, top: 0, width: 8, height: 6 },
    });
  });

  it.each([
    ["no parameters", []],
    [
      "invalid parameter count",
      [
        { unit: "pixels", value: 1 },
        { unit: "pixels", value: 2 },
      ],
    ],
    [
      "negative x",
      [
        { unit: "pixels", value: -1 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 1 },
        { unit: "pixels", value: 1 },
      ],
    ],
    [
      "zero width",
      [
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 1 },
      ],
    ],
    [
      "negative width",
      [
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: -1 },
        { unit: "pixels", value: 1 },
      ],
    ],
    [
      "zero height",
      [
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 1 },
        { unit: "pixels", value: 0 },
      ],
    ],
    [
      "negative height",
      [
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: 1 },
        { unit: "pixels", value: -1 },
      ],
    ],
    ["non-finite width", [{ unit: "pixels", value: Number.NaN }]],
    [
      "non-finite y",
      [
        { unit: "pixels", value: 0 },
        { unit: "pixels", value: Number.POSITIVE_INFINITY },
        { unit: "pixels", value: 1 },
        { unit: "pixels", value: 1 },
      ],
    ],
  ])("rejects %s", (_label, parameters) => {
    expect(projectRectangleShape(parameters as PresentationLength[], 16)).toBeUndefined();
  });

  it("rejects a non-positive or non-finite font size", () => {
    const width: PresentationLength = { unit: "pixels", value: 10 };
    expect(projectRectangleShape([width], 0)).toBeUndefined();
    expect(projectRectangleShape([width], Number.NaN)).toBeUndefined();
    expect(projectSpaceShape(width, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("projects spaces and clamps negative widths to zero", () => {
    expect(projectSpaceShape({ unit: "font_height_hundredths", value: 100 }, 16)).toEqual({
      width: 16,
      height: 16,
    });
    expect(projectSpaceShape({ unit: "pixels", value: -4 }, 16)).toEqual({
      width: 0,
      height: 16,
    });
    expect(
      projectSpaceShape({ unit: "unknown", value: 1 } as unknown as PresentationLength, 16),
    ).toBeUndefined();
  });
});
