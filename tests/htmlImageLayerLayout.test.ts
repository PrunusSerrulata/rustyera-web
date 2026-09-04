import { describe, expect, it } from "vitest";

import { htmlImageLayerOffsets } from "@/core/htmlImageLayerLayout";
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
