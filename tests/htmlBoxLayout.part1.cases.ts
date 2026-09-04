import {
  HtmlNode,
  describe,
  expect,
  htmlBoxRowLayoutsForRange,
  htmlLine,
  htmlMeasurementSegments,
  htmlPrefixDocument,
  htmlTextBoundaries,
  inspectHtmlDocument,
  it,
  mixedTextLine,
  mount,
  mountLine,
  positionedMediaRightBoundariesForRange,
  projectMediaDimensions,
  projectPositionedMediaVerticalSpan,
  queryText,
  textLine,
  validateHtmlCut,
} from "./htmlBoxLayout.testHarness";
import type { CanonicalHtmlDocument, DisplayLine } from "./htmlBoxLayout.testHarness";

describe("Era HTML box layout", () => {
  it("gives the top, shorter interior, and bottom one row-owned width", () => {
    const lines = [
      textLine(1, `┌烙印${"─".repeat(62)}┐`),
      textLine(2, `│请选择要提升的能力${" ".repeat(104)}│`),
      textLine(3, `└${"─".repeat(64)}┘`),
    ];

    const layouts = htmlBoxRowLayoutsForRange(lines, 0, 2);
    expect([...layouts.entries()]).toEqual([
      [0, { columns: 132, trailingRunIndex: 0 }],
      [1, { columns: 132, trailingRunIndex: 0 }],
      [2, { columns: 132, trailingRunIndex: 0 }],
    ]);
    for (const [index, layout] of layouts) {
      const wrapper = mountLine(lines[index], layout);
      expect(wrapper.findAll(".html-box-row")).toHaveLength(1);
      expect(wrapper.get<HTMLElement>(".html-box-row").element.style.width).toBe("132ch");
      expect(wrapper.get(".html-trailing-box-edge").text()).toMatch(/[┐│┘]/u);
    }
  });

  it("anchors the last real descendant across multiple HTML runs and empty tails", () => {
    const top = htmlLine(
      1,
      [{ type: "text", text: "┌烙" }],
      [
        {
          kind: "font",
          semantic: { type: "font", color: null, button_color: null, face: null },
          children: [{ type: "text", text: `印${"─".repeat(62)}┐` }],
        },
      ],
      [{ type: "text", text: "" }],
    );
    const interior = htmlLine(
      2,
      [{ type: "text", text: "│请选择要提升的能力" }],
      [{ kind: "no_break", children: [{ type: "text", text: `${" ".repeat(8)}│` }] }],
      [{ type: "text", text: "" }],
    );
    const bottom = textLine(3, "└────┘");
    const lines = [top, interior, bottom];
    const layouts = htmlBoxRowLayoutsForRange(lines, 0, 2);

    expect(layouts.get(0)?.trailingRunIndex).toBe(1);
    expect(layouts.get(1)?.trailingRunIndex).toBe(1);
    const wrapper = mountLine(interior, layouts.get(1)!);
    expect(wrapper.findAll(".html-box-row")).toHaveLength(1);
    expect(wrapper.findAll(".html-trailing-box-edge")).toHaveLength(1);
    expect(wrapper.get(".html-trailing-box-edge").text()).toBe("│");

    const bottomWrapper = mountLine(bottom, layouts.get(2)!);
    expect(bottomWrapper.get(".html-box-fill").text()).toMatch(/^─+$/u);
    expect(bottomWrapper.get(".html-trailing-box-edge").text()).toBe("┘");
  });

  it("continues horizontal strokes across stable console cells", () => {
    const wrapper = mount(HtmlNode, {
      props: { node: { type: "text", text: "┌─┐" } },
    });

    const cells = wrapper.findAll<HTMLElement>(".html-box-cell");
    expect(cells.map((cell) => cell.element.style.width)).toEqual(["2ch", "2ch", "2ch"]);
    expect(cells.map((cell) => cell.attributes("data-continuation"))).toEqual([
      "─",
      "─",
      undefined,
    ]);
  });

  it("does not continue a labeled corner into following text or a nested tag", () => {
    for (const label of ["工房", "亚兰德", "系统"]) {
      const direct = mount(HtmlNode, {
        props: { node: { type: "text", text: `┌${label}──┐` } },
      });
      expect(direct.findAll(".html-box-cell")[0].attributes("data-continuation")).toBeUndefined();
    }

    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          kind: "no_break",
          children: [
            { type: "text", text: "┌" },
            {
              kind: "font",
              semantic: { type: "font", color: null, button_color: null, face: null },
              children: [{ type: "text", text: "[/] 奴隶" }],
            },
            { type: "text", text: "──┐" },
          ],
        },
      },
    });

    const cells = wrapper.findAll(".html-box-cell");
    expect(cells.map((cell) => cell.text())).toEqual(["┌", "─", "─", "┐"]);
    expect(cells.map((cell) => cell.attributes("data-continuation"))).toEqual([
      undefined,
      "─",
      "─",
      undefined,
    ]);
  });

  it("does not inspect the full retained history for a tail virtual range", () => {
    let accesses = 0;
    const ordinary = Array.from({ length: 4_990 }, (_, index) => ({
      ...textLine(index, `ordinary ${index}`),
      get runs() {
        accesses += 1;
        return [{ type: "text", text: "ordinary" }];
      },
    })) as DisplayLine[];
    const table = [
      textLine(4_990, "┌────────┐"),
      ...Array.from({ length: 8 }, (_, index) => textLine(4_991 + index, "│ row │")),
      textLine(4_999, "└──┘"),
    ];

    const layouts = htmlBoxRowLayoutsForRange([...ordinary, ...table], 4_995, 4_999);
    expect(layouts.size).toBe(5);
    expect(accesses).toBe(0);
  });

  it("leaves positioned or media HTML trees outside table projection", () => {
    const unsafe = htmlLine(1, [
      {
        kind: "division",
        semantic: { type: "division" },
        children: [{ type: "text", text: "┌──┐" }],
      },
    ]);
    expect(htmlBoxRowLayoutsForRange([unsafe], 0, 0).size).toBe(0);
  });

  it("keeps an upward-overflowing portrait inside the box rows it crosses", () => {
    const lines = [
      textLine(1, `┌${"─".repeat(61)}┐`),
      ...Array.from({ length: 30 }, (_, index) => textLine(index + 2, `│${" ".repeat(122)}│`)),
      textLine(32, `└${"─".repeat(61)}┘`),
      htmlLine(33, [
        {
          kind: "non_button",
          semantic: { type: "non_button", position: 4701 },
          children: [
            { type: "text", text: " " },
            {
              semantic: {
                type: "image",
                source: "portrait",
                height: { unit: "font_height_hundredths", value: 2700 },
                y: { unit: "font_height_hundredths", value: -3100 },
              },
            },
            { kind: "break" },
          ],
        },
      ]),
    ];

    const boundaries = positionedMediaRightBoundariesForRange(lines, 32, 32, {
      fontSizePx: 16,
      lineHeightPx: 16,
      imageScale: 1,
    });
    expect(boundaries.get(32)).toBe(124);
    expect(
      projectMediaDimensions({
        requestedWidth: { unit: "font_height_hundredths", value: -1800 },
        requestedHeight: { unit: "font_height_hundredths", value: -2700 },
        spriteWidth: 400,
        spriteHeight: 600,
        fontSizePx: 16,
      }),
    ).toEqual({ width: 288, height: 432 });
    expect(
      projectPositionedMediaVerticalSpan({
        y: { unit: "font_height_hundredths", value: -100 },
        height: { unit: "font_height_hundredths", value: -100 },
        fontSizePx: 16,
        imageScale: 2,
        bottomAnchored: true,
        lineHeightPx: 16,
      }),
    ).toEqual({ top: -48, bottom: -16 });
  });

  it("finds a trailing box that starts while a left-hand box remains open", () => {
    const lines = [
      textLine(1, `┌${"─".repeat(10)}┐${" ".repeat(4)}┌${"─".repeat(48)}┐`),
      mixedTextLine(2, "│", "[q]", `${" ".repeat(17)}│${" ".repeat(4)}│${" ".repeat(96)}│`),
      textLine(3, `│${" ".repeat(20)}│${" ".repeat(4)}│${" ".repeat(96)}│`),
      textLine(4, `└${"─".repeat(10)}┘${" ".repeat(4)}│${" ".repeat(96)}│`),
      htmlLine(5, [
        {
          kind: "non_button",
          semantic: { type: "non_button", position: 4701 },
          children: [
            { type: "text", text: " " },
            {
              semantic: {
                type: "image",
                source: "portrait",
                height: { unit: "font_height_hundredths", value: 300 },
                y: { unit: "font_height_hundredths", value: -300 },
              },
            },
            { kind: "break" },
          ],
        },
      ]),
    ];

    expect(
      positionedMediaRightBoundariesForRange(lines, 4, 4, {
        fontSizePx: 16,
        lineHeightPx: 16,
        imageScale: 1,
      }).get(4),
    ).toBe(126);
  });

  it("preserves the requested portrait position when it crosses no box", () => {
    const portrait = htmlLine(1, [
      {
        kind: "non_button",
        semantic: { type: "non_button", position: 4701 },
        children: [
          { type: "text", text: " " },
          {
            semantic: {
              type: "image",
              source: "portrait",
              width: { unit: "font_height_hundredths", value: 1800 },
              height: { unit: "font_height_hundredths", value: 2700 },
              y: { unit: "font_height_hundredths", value: -3100 },
            },
          },
          { kind: "break" },
        ],
      },
    ]);
    expect(
      positionedMediaRightBoundariesForRange([portrait], 0, 0, {
        fontSizePx: 16,
        lineHeightPx: 16,
        imageScale: 1,
      }).size,
    ).toBe(0);
  });

  it("does not constrain ambiguous or intentionally outside positioned media", () => {
    const box = [
      textLine(1, `┌${"─".repeat(61)}┐`),
      ...Array.from({ length: 30 }, (_, index) => textLine(index + 2, `│${" ".repeat(122)}│`)),
      textLine(32, `└${"─".repeat(61)}┘`),
    ];
    const positioned = (position: number) => ({
      kind: "non_button",
      semantic: { type: "non_button", position },
      children: [
        {
          semantic: {
            type: "image",
            source: "portrait",
            height: { unit: "font_height_hundredths", value: 2700 },
            y: { unit: "font_height_hundredths", value: -3100 },
          },
        },
      ],
    });
    const options = { fontSizePx: 16, lineHeightPx: 16, imageScale: 1 };

    expect(
      positionedMediaRightBoundariesForRange(
        [...box, htmlLine(33, [positioned(4701), positioned(5000)])],
        32,
        32,
        options,
      ).size,
    ).toBe(0);
    expect(
      positionedMediaRightBoundariesForRange(
        [...box, htmlLine(33, [positioned(6500)])],
        32,
        32,
        options,
      ).size,
    ).toBe(0);
  });
});

describe("HTML measurement source positions", () => {
  it("matches UTF-8 and UTF-16 scalar boundaries without accepting a surrogate midpoint", () => {
    const document = queryText("A&中😀");
    expect(htmlTextBoundaries("A&中😀")).toEqual([
      { utf8: 0, utf16: 0 },
      { utf8: 1, utf16: 1 },
      { utf8: 2, utf16: 2 },
      { utf8: 5, utf16: 3 },
      { utf8: 9, utf16: 5 },
    ]);
    expect(() =>
      validateHtmlCut(document, {
        id: 1,
        textNodePath: [0],
        decodedUtf8Offset: 9,
        decodedUtf16Offset: 4,
      }),
    ).toThrow("matching scalar boundary");
    expect(() =>
      validateHtmlCut(document, {
        id: 1,
        textNodePath: [0],
        decodedUtf8Offset: 5,
        decodedUtf16Offset: 5,
      }),
    ).toThrow("matching scalar boundary");
    expect(() => htmlTextBoundaries("\ud83d")).toThrow("unpaired surrogate");
    const prefix = htmlPrefixDocument(document, {
      id: 2,
      textNodePath: [0],
      decodedUtf8Offset: 5,
      decodedUtf16Offset: 3,
    });
    expect(prefix.nodes).toEqual([{ type: "text", text: "A&中" }]);
    expect(document.nodes).toEqual([{ type: "text", text: "A&中😀" }]);
  });

  it("keeps U+3000 expansion atomic and excludes box continuation decoration from source offsets", () => {
    const segments = htmlMeasurementSegments("A　😀┌─", true);
    const space = segments.find((segment) => segment.kind === "space")!;
    expect(space.text).toBe("  ");
    expect(space.boundaries).toEqual([
      { sourceUtf16: 1, domUtf16: 0 },
      { sourceUtf16: 2, domUtf16: 2 },
    ]);
    const emoji = segments.find((segment) => segment.text === "😀")!;
    expect(emoji.boundaries).toEqual([
      { sourceUtf16: 2, domUtf16: 0 },
      { sourceUtf16: 4, domUtf16: 2 },
    ]);
    const corner = segments.find((segment) => segment.text === "┌")!;
    expect(corner.continuation).toBe("─");
    expect(corner.boundaries).toEqual([
      { sourceUtf16: 4, domUtf16: 0 },
      { sourceUtf16: 5, domUtf16: 1 },
    ]);
  });

  it("crops only canonical nodes and retains styling without parsing literal tag-looking text", () => {
    const document: CanonicalHtmlDocument = {
      nodes: [
        {
          type: "element",
          kind: "bold",
          attributes: [],
          semantic: { type: "style" },
          children: [{ type: "text", text: "<img>fi" }],
        },
      ],
    };
    const prefix = htmlPrefixDocument(document, {
      id: 1,
      textNodePath: [0, 0],
      decodedUtf8Offset: 6,
      decodedUtf16Offset: 6,
    });
    expect(prefix.nodes[0]).toMatchObject({
      kind: "bold",
      children: [{ type: "text", text: "<img>f" }],
    });
    expect(() =>
      inspectHtmlDocument({
        nodes: [
          {
            type: "element",
            kind: "canvas",
            attributes: [],
            children: [],
            semantic: { type: "style" },
          } as never,
        ],
      }),
    ).toThrow("unknown");
  });

  it("rejects cycles, excessive projected DOM and unsupported shapes before mounting", () => {
    const cyclic: CanonicalHtmlDocument = {
      nodes: [
        {
          type: "element",
          kind: "bold",
          attributes: [],
          semantic: { type: "style" },
          children: [],
        },
      ],
    };
    (
      cyclic.nodes[0] as Extract<CanonicalHtmlDocument["nodes"][number], { type: "element" }>
    ).children.push(cyclic.nodes[0]);
    expect(() => inspectHtmlDocument(cyclic)).toThrow("cyclic");
    expect(() => inspectHtmlDocument(queryText("─".repeat(3000)))).toThrow("budget");
    expect(() =>
      inspectHtmlDocument({
        nodes: [
          {
            type: "element",
            kind: "shape",
            attributes: [],
            children: [],
            semantic: { type: "shape", kind: "triangle", parameters: [] },
          },
        ],
      }),
    ).toThrow("existing projection");
  });
});
