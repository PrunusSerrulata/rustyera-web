import { describe, expect, it } from "vitest";

import {
  htmlImageLayerOffsets,
  htmlImageLayerOffsetsForRange,
  htmlImageLayerLayoutForRange,
} from "@/core/htmlImageLayerLayout";
import type { DisplayLine } from "@/core/types";

const htmlLine = (lineId: number, nodes: any[]): DisplayLine =>
  ({
    line_id: lineId,
    alignment: "left",
    line_end: true,
    logical_line_start: true,
    temporary: false,
    text_background_eligible: false,
    runs: [{ type: "html_document", document: { nodes } }],
  }) as DisplayLine;

const zeroSpace = (lineId: number) =>
  htmlLine(lineId, [
    {
      type: "element",
      kind: "shape",
      attributes: [],
      semantic: {
        type: "shape",
        kind: "space",
        parameters: [{ unit: "font_height_hundredths", value: 0 }],
      },
      children: [],
    },
  ]);

const positionedImage = (lineId: number, source: string, y: number) =>
  htmlLine(lineId, [
    {
      type: "element",
      kind: "paragraph",
      attributes: [],
      semantic: { type: "paragraph", alignment: "left" },
      children: [
        {
          type: "element",
          kind: "image",
          attributes: [],
          semantic: {
            type: "image",
            source,
            display: "relative",
            height: { unit: "font_height_hundredths", value: 1125 },
            y: { unit: "font_height_hundredths", value: y },
          },
          children: [],
        },
      ],
    },
  ]);

describe("Snake HTML image layer layout", () => {
  it("anchors the stable Eiki skirt layers while preserving their history rows", () => {
    const lines = [
      zeroSpace(510),
      positionedImage(511, "30_BODY_WEAR", 0),
      zeroSpace(512),
      positionedImage(513, "30_PANTS_WEAR_TYPE6_NORMAL", -100),
      zeroSpace(514),
      positionedImage(515, "30_SHADOW_LIFT", -200),
    ];

    expect([...htmlImageLayerOffsets(lines, 17)]).toEqual([
      [1, -17],
      [3, -34],
      [5, -51],
    ]);
    expect(lines).toHaveLength(6);
  });

  it("resolves a visible tail from its group origin without scanning unrelated history", () => {
    const unrelated = htmlLine(1, []);
    Object.defineProperty(unrelated, "runs", {
      get() {
        throw new Error("visible image layout must not scan unrelated history");
      },
    });
    const lines = [
      unrelated,
      htmlLine(2, [{ type: "text", text: "separator" }]),
      zeroSpace(3),
      positionedImage(4, "first", 0),
      zeroSpace(5),
      positionedImage(6, "second", -100),
    ];

    expect([...htmlImageLayerOffsetsForRange(lines, 17, 4, 5)]).toEqual([[5, -34]]);
  });

  it.each([0.5, 1, 2])(
    "keeps multi-column layers aligned at image scale %s and reserves height once",
    (scale) => {
      const lines: DisplayLine[] = [];
      for (let layer = 0; layer < 5; layer += 1) {
        const row = positionedImage(layer * 2 + 1, "layer", -100 * layer);
        const children = (row.runs[0] as any).document.nodes[0].children;
        children.push(
          layer === 0
            ? structuredClone(children[0])
            : {
                type: "element",
                kind: "shape",
                attributes: [],
                children: [],
                semantic: {
                  type: "shape",
                  kind: "space",
                  parameters: [{ unit: "font_height_hundredths", value: 1125 }],
                },
              },
        );
        lines.push(zeroSpace(layer * 2), row);
      }
      const layout = htmlImageLayerLayoutForRange(lines, 17, 0, 9, 16, scale);
      expect(layout.size).toBe(5);
      for (let layer = 0; layer < 5; layer += 1) {
        const index = layer * 2 + 1;
        const entry = layout.get(index)!;
        expect(index * 17 - layer * 16 * scale + entry.offset).toBe(0);
        expect(entry.minimumHeight).toBe(layer === 4 ? Math.max(17, 180 * scale - 153) : 17);
      }
      expect([...htmlImageLayerLayoutForRange(lines, 17, 7, 9, 16, scale)]).toEqual(
        [...layout].filter(([index]) => index >= 7),
      );
    },
  );

  it("recognizes the bigint lengths received from the real runtime wire", () => {
    const lines: DisplayLine[] = [];
    for (let layer = 0; layer < 5; layer += 1) {
      const row = positionedImage(layer * 2 + 1, "layer", -100 * layer);
      const children = (row.runs[0] as any).document.nodes[0].children;
      children.push(
        layer === 0
          ? structuredClone(children[0])
          : {
              type: "element",
              kind: "shape",
              attributes: [],
              children: [],
              semantic: {
                type: "shape",
                kind: "space",
                parameters: [{ unit: "font_height_hundredths", value: 1125 }],
              },
            },
      );
      lines.push(zeroSpace(layer * 2), row);
    }
    const convert = (value: any): void => {
      if (value == null || typeof value !== "object") return;
      if (typeof value.unit === "string" && typeof value.value === "number")
        value.value = BigInt(value.value);
      for (const child of Object.values(value)) convert(child);
    };
    const expected = [...htmlImageLayerLayoutForRange(lines, 16, 0, 9, 16, 1)];
    convert(lines);
    expect([...htmlImageLayerLayoutForRange(lines, 16, 0, 9, 16, 1)]).toEqual(expected);
    expect(expected).toHaveLength(5);
  });

  it.each(["pixels", "font_height_hundredths"])("preserves legacy nonstandard y in %s", (unit) => {
    const first = positionedImage(1, "first", 0);
    const second = positionedImage(3, "second", -50);
    for (const row of [first, second])
      (row.runs[0] as any).document.nodes[0].children[0].semantic.y.unit = unit;
    expect([
      ...htmlImageLayerLayoutForRange([zeroSpace(0), first, zeroSpace(2), second], 17, 0, 3, 16, 2),
    ]).toEqual([
      [1, { offset: -17 }],
      [3, { offset: -34 }],
    ]);
  });

  it("rejects mixed-y images, breaks, text, and interactive filler inside a layer", () => {
    for (const extra of [
      { type: "text", text: "caption" },
      { type: "element", kind: "break", children: [], semantic: { type: "break" } },
      {
        type: "element",
        kind: "shape",
        children: [],
        interaction: { id: 1 },
        semantic: { type: "shape", kind: "space", parameters: [{ unit: "pixels", value: 10 }] },
      },
      (positionedImage(9, "other", -200).runs[0] as any).document.nodes[0].children[0],
    ]) {
      const second = positionedImage(3, "second", -100);
      (second.runs[0] as any).document.nodes[0].children.push(extra);
      expect([
        ...htmlImageLayerOffsets(
          [zeroSpace(0), positionedImage(1, "first", 0), zeroSpace(2), second],
          16,
        ),
      ]).toEqual([]);
    }
  });

  it("does not move ordinary images or nonzero layout spaces", () => {
    const positiveSpace = htmlLine(1, [
      {
        type: "element",
        kind: "shape",
        attributes: [],
        semantic: {
          type: "shape",
          kind: "space",
          parameters: [{ unit: "pixels", value: 20 }],
        },
        children: [],
      },
    ]);
    const plainImage = positionedImage(2, "ordinary", 0);
    const imageWithText = htmlLine(3, [
      {
        type: "element",
        kind: "image",
        attributes: [],
        semantic: { type: "image", display: "relative", y: { unit: "pixels", value: 0 } },
        children: [],
      },
      { type: "text", text: "caption" },
    ]);

    expect([...htmlImageLayerOffsets([positiveSpace, plainImage], 17)]).toEqual([]);
    expect([...htmlImageLayerOffsets([zeroSpace(4), plainImage], 17)]).toEqual([]);
    expect([...htmlImageLayerOffsets([zeroSpace(4), imageWithText], 17)]).toEqual([]);
    expect([...htmlImageLayerOffsets([plainImage], 17)]).toEqual([]);
  });

  it("rejects interrupted, nonprogressing, and interactive image pairs", () => {
    const ordinaryLine = htmlLine(10, [{ type: "text", text: "ordinary history" }]);
    const interactive = positionedImage(11, "interactive", -100);
    const root = (interactive.runs[0] as any).document.nodes[0];
    root.interaction = { id: 1 };

    expect([
      ...htmlImageLayerOffsets(
        [
          zeroSpace(1),
          positionedImage(2, "first", 0),
          ordinaryLine,
          zeroSpace(3),
          positionedImage(4, "second", -100),
        ],
        17,
      ),
    ]).toEqual([]);
    expect([
      ...htmlImageLayerOffsets(
        [
          zeroSpace(5),
          positionedImage(6, "first", 0),
          zeroSpace(7),
          positionedImage(8, "second", 0),
        ],
        17,
      ),
    ]).toEqual([]);
    expect([
      ...htmlImageLayerOffsets(
        [zeroSpace(9), positionedImage(10, "first", 0), zeroSpace(11), interactive],
        17,
      ),
    ]).toEqual([]);
  });
});
