import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    canInteract: true,
    interactionEnabled: () => true,
    replaceFullWidthSpaces: false,
    effectivePreferences: { fontFamilyOverride: null, fontSizeOverridePx: null, imageScale: 1 },
    gameTextStyle: { fontSizePx: 16 },
    gameLineHeightPx: 16,
    presentation: {
      settings: { line_height: 16_000 },
      resources: {
        sprites: [{ name: "portrait", size: [400, 600], frames: [] }],
        canvases: [],
      },
    },
  }),
}));

import DisplayLineComponent from "@/components/DisplayLine.vue";
import HtmlNode from "@/components/HtmlNode.vue";
import {
  htmlBoxRowLayoutsForRange,
  positionedMediaRightBoundariesForRange,
  type HtmlBoxRowLayout,
} from "@/core/htmlBoxLayout";
import { projectMediaDimensions, projectPositionedMediaVerticalSpan } from "@/core/mediaProjection";
import type { DisplayLine } from "@/core/types";

function htmlLine(lineId: number, ...documents: any[][]): DisplayLine {
  return {
    line_id: lineId,
    temporary: false,
    logical_line_start: true,
    line_end: true,
    alignment: "left",
    runs: documents.map((nodes) => ({ type: "html_document", document: { nodes } })),
  } as DisplayLine;
}

function textLine(lineId: number, text: string): DisplayLine {
  return htmlLine(lineId, [{ type: "text", text }]);
}

function mixedTextLine(lineId: number, before: string, button: string, after: string): DisplayLine {
  return {
    line_id: lineId,
    temporary: false,
    logical_line_start: true,
    line_end: true,
    alignment: "left",
    runs: [
      { type: "html_document", document: { nodes: [{ type: "text", text: before }] } },
      { type: "button", runs: [{ type: "text", text: button }] },
      { type: "html_document", document: { nodes: [{ type: "text", text: after }] } },
    ],
  } as DisplayLine;
}

function mountLine(line: DisplayLine, boxRowLayout: HtmlBoxRowLayout) {
  return mount(DisplayLineComponent, {
    props: { line, boxRowLayout, viewportColumns: 132 },
  });
}

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

// These tests exercise canonical projection and async ownership with controlled DOM geometry.
// Real browser/font measurements remain a separate Browser/Tauri acceptance gate.
import {
  HtmlMeasurementScope,
  htmlMeasurementProjectionKey,
  type HtmlMeasurementBinding,
} from "@/components/htmlMeasurementProjection";
import {
  htmlMeasurementSegments,
  htmlPrefixDocument,
  htmlTextBoundaries,
  inspectHtmlDocument,
  validateHtmlCut,
  type CanonicalHtmlDocument,
  type HtmlQueryStyle,
} from "@/core/htmlMeasurement";
import { RuntimeServiceError } from "@/core/runtimeServiceProtocol";
import type { FrontendBridge } from "@/core/types";
import { HtmlMeasurementProvider } from "@/platform/htmlMeasurement";
import * as htmlResourceUrls from "@/core/resources";
import * as pointerObservation from "@/platform/pointerObservation";

const queryStyle = (): HtmlQueryStyle => ({
  current: {
    foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
    bold: true,
    italic: true,
    underline: true,
    strikeout: true,
    font_millipixels: 24000,
  },
  base: {
    foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    font_millipixels: 16000,
    font_family: "FixtureFont",
  },
  settings: { line_height: 17000 },
});
const queryText = (text: string): CanonicalHtmlDocument => ({ nodes: [{ type: "text", text }] });

function measurementBinding(viewport: HTMLElement): HtmlMeasurementBinding {
  return {
    viewport,
    viewportSize: { width: viewport.clientWidth, height: viewport.clientHeight },
    context: { presentationRevision: 3, environmentRevision: 4, projectionSpaceRevision: 5 },
    resources: { sprites: [], canvases: [] },
    resourceGeneration: 8,
    preferences: { fontFamilyOverride: null, fontSizeOverridePx: null, imageScale: 1 },
    replaceFullWidthSpaces: false,
    resourceBridge: {
      readImageMetadata: vi.fn(),
      readResource: vi.fn(),
    } as unknown as FrontendBridge,
  };
}

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

describe("bounded offscreen HTML measurement", () => {
  let viewport: HTMLElement;
  let originalFonts: PropertyDescriptor | undefined;
  let originalRects: PropertyDescriptor | undefined;
  let fontLoad: ReturnType<typeof vi.fn>;
  const rectangles = new WeakMap<Range, Node>();
  const shapedWidth = (value: string) => (value === "fi" ? 9 : Array.from(value).length * 6);

  beforeEach(() => {
    viewport = document.createElement("section");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.style.fontFamily = "FixtureFont";
    viewport.style.fontSize = "16px";
    document.body.append(viewport);
    originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    fontLoad = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: fontLoad, ready: Promise.resolve() },
    });
    originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    vi.spyOn(Range.prototype, "selectNodeContents").mockImplementation(function (
      this: Range,
      node: Node,
    ) {
      rectangles.set(this, node);
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: function (this: Range) {
        return [new DOMRect(0, 0, shapedWidth(rectangles.get(this)?.textContent ?? ""), 16)];
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, shapedWidth(this.textContent ?? ""), 16);
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    viewport.remove();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("independently shapes a prefix and ignores the unrelated current-style bits", async () => {
    const register = vi.spyOn(pointerObservation, "registerPointerButton");
    const signal = new AbortController().signal;
    const provider = new HtmlMeasurementProvider();
    const regular: string[] = [];
    fontLoad.mockImplementation(async () => {
      regular.push(
        window.document.body.querySelector<HTMLElement>("[data-html-measurement-line]")!.style
          .fontWeight,
      );
      return [];
    });
    const result = await provider.measure(
      {
        document: queryText("fi"),
        mode: "text_part",
        cuts: [{ id: 7, textNodePath: [0], decodedUtf8Offset: 1, decodedUtf16Offset: 1 }],
        style: queryStyle(),
      },
      measurementBinding(viewport),
      { signal, assertCurrent() {} },
    );
    expect(result.advancePx).toBe(9);
    expect(result.cuts).toEqual([{ id: 7, advancePx: 6 }]);
    expect(regular).toEqual(["normal"]);
    expect(register).not.toHaveBeenCalled();
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("does not retain an unrelated project sprite catalog for a text measurement", async () => {
    const binding = measurementBinding(viewport);
    binding.resources.sprites = Array.from({ length: 4_097 }, (_, index) => ({
      name: `unused-${index}`,
      revision: 1,
      size: [1, 1],
      frames: [{ resource_id: `unused-${index}.png` }],
    }));

    const result = await new HtmlMeasurementProvider().measure(
      { document: queryText("plain text"), mode: "text_part", cuts: [], style: queryStyle() },
      binding,
      { signal: new AbortController().signal, assertCurrent() {} },
    );

    expect(result.advancePx).toBeGreaterThan(0);
    expect(binding.resourceBridge.readResource).not.toHaveBeenCalled();
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("measures all independent prefixes in one settled font layout", async () => {
    let fontWidth = 12;
    let finishLoad!: () => void;
    let finishReady!: () => void;
    fontLoad.mockReturnValue(
      new Promise<void>((resolve) => {
        finishLoad = () => {
          fontWidth = 10;
          resolve();
        };
      }),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load: fontLoad,
        ready: new Promise<void>((resolve) => {
          finishReady = () => {
            fontWidth = 9;
            resolve();
          };
        }),
      },
    });
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, (this.textContent?.length ?? 0) * fontWidth, 16);
    });
    let completed = false;
    const pending = new HtmlMeasurementProvider()
      .measure(
        {
          document: queryText("AAAA"),
          mode: "text_part",
          cuts: [0, 1, 2, 3, 4].map((offset) => ({
            id: offset,
            textNodePath: [0],
            decodedUtf8Offset: offset,
            decodedUtf16Offset: offset,
          })),
          style: queryStyle(),
        },
        measurementBinding(viewport),
        { signal: new AbortController().signal, assertCurrent() {} },
      )
      .then((result) => {
        completed = true;
        return result;
      });
    await flushPromises();
    expect(fontLoad).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    finishLoad();
    await flushPromises();
    expect(completed).toBe(false);
    finishReady();
    const result = await pending;
    expect(result.advancePx).toBe(36);
    expect(result.cuts.map((cut) => cut.advancePx)).toEqual([0, 9, 18, 27, 36]);
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("reports an empty first forced row without using later visible text", async () => {
    const document: CanonicalHtmlDocument = {
      nodes: [
        {
          type: "element",
          kind: "break",
          attributes: [],
          children: [],
          semantic: { type: "break" },
        },
        { type: "text", text: "later" },
      ],
    };
    const result = await new HtmlMeasurementProvider().measureDocument(
      document,
      queryStyle(),
      measurementBinding(viewport),
      { signal: new AbortController().signal, assertCurrent() {} },
    );
    expect(result.firstRow).toEqual({ advancePx: 0, heightPx: 17, fragments: [] });
  });

  it.each(["abort", "revision", "clear"])(
    "disposes the DOM and refuses a reply after %s during font loading",
    async (reason) => {
      let finish!: () => void;
      fontLoad.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      const controller = new AbortController();
      let current = true;
      const provider = new HtmlMeasurementProvider();
      const pending = provider.measure(
        { document: queryText("x"), mode: "text_part", cuts: [], style: queryStyle() },
        measurementBinding(viewport),
        {
          signal: controller.signal,
          assertCurrent() {
            if (!current) throw new RuntimeServiceError("stale_projection", "revision changed");
          },
        },
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await flushPromises();
      expect(fontLoad).toHaveBeenCalledOnce();
      if (reason === "abort") controller.abort();
      if (reason === "revision") current = false;
      if (reason === "clear") provider.clear();
      finish();
      await rejected;
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
    },
  );

  it("keeps the captured projection width when demand-driven scrollbars change the viewport", async () => {
    let finish!: () => void;
    fontLoad.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const provider = new HtmlMeasurementProvider();
    const pending = provider.measure(
      { document: queryText("x"), mode: "text_part", cuts: [], style: queryStyle() },
      measurementBinding(viewport),
      { signal: new AbortController().signal, assertCurrent() {} },
    );
    await flushPromises();
    const host = document.body.querySelector<HTMLElement>(".html-measurement-host");
    expect(host?.style.width).toBe("320px");
    expect(viewport.contains(host)).toBe(false);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 307 },
      clientHeight: { configurable: true, value: 187 },
    });
    finish();
    await expect(pending).resolves.toMatchObject({ context: measurementBinding(viewport).context });
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("requires a mounted viewport and reports font failure instead of a zero-width success", async () => {
    const provider = new HtmlMeasurementProvider();
    const probe = {
      document: queryText("x"),
      mode: "text_part" as const,
      cuts: [],
      style: queryStyle(),
    };
    const guard = { signal: new AbortController().signal, assertCurrent() {} };
    await expect(
      provider.measure(probe, measurementBinding(document.createElement("section")), guard),
    ).rejects.toMatchObject({ category: "stale_projection" });
    fontLoad.mockRejectedValue(new Error("font backend failed"));
    await expect(
      provider.measure(probe, measurementBinding(viewport), guard),
    ).rejects.toMatchObject({ category: "backend_failure" });
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("identifies blocked font-ready at the unchanged deadline and disposes its projection", async () => {
    // Leave Vue's microtasks and flushPromises' scheduler real; only advance the scope deadline.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load: fontLoad,
        ready: new Promise<void>(() => {}),
        status: "loading",
      },
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const frame = vi.fn(() => 17);
    vi.stubGlobal("requestAnimationFrame", frame);
    const returned = vi.fn();
    const pending = new HtmlMeasurementProvider().measure(
      { document: queryText("x"), mode: "text_part", cuts: [], style: queryStyle() },
      measurementBinding(viewport),
      { signal: new AbortController().signal, assertCurrent() {} },
    );
    const rejected = expect(pending.then(returned)).rejects.toMatchObject({
      category: "backend_failure",
      message:
        "HTML fonts or media did not settle within the measurement deadline; " +
        "phase=font-ready; visibilityState=hidden; hasFocus=false; fonts.status=loading",
    });
    await flushPromises();
    expect(fontLoad).toHaveBeenCalledOnce();
    expect(frame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(document.body.querySelector(".html-measurement-host")).not.toBeNull();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(returned).not.toHaveBeenCalled();
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("measures a hidden unfocused document without requesting an animation frame", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const frame = vi.fn(() => 17);
    vi.stubGlobal("requestAnimationFrame", frame);
    const provider = new HtmlMeasurementProvider();
    const measured = vi.fn();
    const pending = provider
      .measure(
        {
          document: queryText("fi"),
          mode: "text_part",
          cuts: [{ id: 7, textNodePath: [0], decodedUtf8Offset: 1, decodedUtf16Offset: 1 }],
          style: queryStyle(),
        },
        measurementBinding(viewport),
        { signal: new AbortController().signal, assertCurrent() {} },
      )
      .then(measured);
    try {
      await flushPromises();
      expect(frame).not.toHaveBeenCalled();
      expect(measured).toHaveBeenCalledWith(
        expect.objectContaining({
          advancePx: 9,
          cuts: [{ id: 7, advancePx: 6 }],
        }),
      );
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
    } finally {
      provider.clear();
      await pending;
    }
  });

  function imageProbe(source = "portrait") {
    return {
      document: {
        nodes: [
          {
            type: "element" as const,
            kind: "image" as const,
            attributes: [],
            children: [],
            semantic: { type: "image" as const, source },
          },
        ],
      },
      missingDocument: queryText("<img>"),
      style: queryStyle(),
    };
  }

  it("measures core fallback only for an undeclared sprite, including the empty name", async () => {
    const binding = measurementBinding(viewport);
    const guard = { signal: new AbortController().signal, assertCurrent() {} };
    const provider = new HtmlMeasurementProvider();
    for (const name of ["missing", ""]) {
      const result = await provider.measureImageSlot(imageProbe(name), binding, guard);
      expect(result).toEqual({ context: binding.context, type: "missing", fallbackAdvancePx: 30 });
    }
    expect(binding.resourceBridge.readImageMetadata).not.toHaveBeenCalled();
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it.each([false, true])(
    "returns frozen sprite natural dimensions with bigint=%s",
    async (wasm) => {
      const binding = measurementBinding(viewport);
      binding.resources.sprites = [
        {
          name: "PORTRAIT",
          revision: 1,
          size: wasm ? [20n, 10n] : [20, 10],
          frames: [{ resource_id: "atlas.png", source_rectangle: [12, 14, 20, 10] }],
        },
      ];
      vi.mocked(binding.resourceBridge.readImageMetadata).mockResolvedValue({
        width: 300,
        height: 200,
        format: "png",
        animated: false,
      });
      const release = vi.fn();
      vi.spyOn(htmlResourceUrls, "acquireResourceUrl").mockReturnValue({
        url: Promise.resolve("blob:frozen"),
        release,
      });
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 300;
          naturalHeight = 200;
          decode = vi.fn().mockResolvedValue(undefined);
        },
      );
      const provider = new HtmlMeasurementProvider();
      const pending = provider.measureImageSlot(imageProbe(), binding, {
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      binding.resources.sprites[0]!.size = [999, 999];
      binding.resources.sprites = [];
      expect(await pending).toEqual({
        context: binding.context,
        type: "loaded",
        naturalWidth: 20,
        naturalHeight: 10,
      });
      expect(binding.resourceBridge.readImageMetadata).toHaveBeenCalledWith("atlas.png");
      expect(release).toHaveBeenCalledOnce();
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
    },
  );

  it.each([0n, -1n, 1_048_577n, "20"])("rejects invalid natural sprite width %s", async (width) => {
    const binding = measurementBinding(viewport);
    binding.resources.sprites = [
      {
        name: "portrait",
        revision: 1,
        size: [width, 10n] as any,
        frames: [{ resource_id: "atlas.png" }],
      },
    ];
    await expect(
      new HtmlMeasurementProvider().measureImageSlot(imageProbe(), binding, {
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(binding.resourceBridge.readImageMetadata).not.toHaveBeenCalled();
  });

  it.each(["permission", "hash changed", "decode"])(
    "does not turn declared image %s failure into Missing",
    async (reason) => {
      const binding = measurementBinding(viewport);
      binding.resources.sprites = [
        {
          name: "portrait",
          revision: 1,
          size: [20, 10],
          frames: [{ resource_id: "declared.png", source_rectangle: [0, 0, 20, 10] }],
        },
      ];
      const release = vi.fn();
      vi.spyOn(htmlResourceUrls, "acquireResourceUrl").mockReturnValue({
        url: Promise.resolve("blob:declared"),
        release,
      });
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 20;
          naturalHeight = 10;
          decode = vi.fn().mockRejectedValue(new Error("decode failed"));
        },
      );
      if (reason === "decode")
        vi.mocked(binding.resourceBridge.readImageMetadata).mockResolvedValue({
          width: 20,
          height: 10,
          format: "png",
          animated: false,
        });
      else vi.mocked(binding.resourceBridge.readImageMetadata).mockRejectedValue(new Error(reason));
      await expect(
        new HtmlMeasurementProvider().measureImageSlot(imageProbe(), binding, {
          signal: new AbortController().signal,
          assertCurrent() {},
        }),
      ).rejects.toMatchObject({ category: "backend_failure" });
      expect(fontLoad).not.toHaveBeenCalled();
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
      if (reason === "decode") expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["clear", "deadline"])(
    "retires an image decoding request on %s and allows another measurement",
    async (reason) => {
      if (reason === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const binding = measurementBinding(viewport);
      binding.resources.sprites = [
        {
          name: "portrait",
          revision: 1,
          size: [20, 10],
          frames: [{ resource_id: "declared.png" }],
        },
      ];
      vi.mocked(binding.resourceBridge.readImageMetadata).mockResolvedValue({
        width: 20,
        height: 10,
        format: "png",
        animated: false,
      });
      const release = vi.fn();
      vi.spyOn(htmlResourceUrls, "acquireResourceUrl").mockReturnValue({
        url: Promise.resolve("blob:declared"),
        release,
      });
      let finish!: () => void;
      const decode = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 20;
          naturalHeight = 10;
          decode = decode;
        },
      );
      const provider = new HtmlMeasurementProvider();
      const guard = { signal: new AbortController().signal, assertCurrent() {} };
      const pending = provider.measureImageSlot(imageProbe(), binding, guard);
      const rejected = expect(pending).rejects.toMatchObject({
        category: reason === "clear" ? "stale_projection" : "backend_failure",
        ...(reason === "deadline"
          ? { message: expect.stringContaining("phase=image-decode,media-settle;") }
          : {}),
      });
      await flushPromises();
      expect(decode).toHaveBeenCalledOnce();
      if (reason === "clear") provider.clear();
      else await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(release).toHaveBeenCalledOnce();
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
      finish();
      const result = await provider.measure(
        { document: queryText("fi"), style: queryStyle(), mode: "text_part", cuts: [] },
        measurementBinding(viewport),
        guard,
      );
      expect(result.advancePx).toBe(9);
    },
  );

  it("rejects absent or inconsistent cut offsets before creating any DOM", async () => {
    const provider = new HtmlMeasurementProvider();
    const guard = { signal: new AbortController().signal, assertCurrent() {} };
    for (const cut of [
      { id: 1, textNodePath: [0] },
      { id: 1, textNodePath: [0], decodedUtf8Offset: 4, decodedUtf16Offset: 1 },
    ]) {
      await expect(
        provider.measure(
          {
            document: queryText("😀"),
            style: queryStyle(),
            mode: "text_part",
            cuts: [cut as never],
          },
          measurementBinding(viewport),
          guard,
        ),
      ).rejects.toMatchObject({ category: "invalid_request" });
    }
    expect(fontLoad).not.toHaveBeenCalled();
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("confirms a fixed slot without exposing a DOM-derived width", async () => {
    const probe = {
      document: {
        nodes: [
          {
            type: "element" as const,
            kind: "shape" as const,
            attributes: [],
            children: [],
            semantic: {
              type: "shape" as const,
              kind: "space",
              parameters: [{ unit: "pixels" as const, value: 12 }],
            },
          },
        ],
      },
      style: queryStyle(),
    };
    const result = await new HtmlMeasurementProvider().ensureFixedSlot(
      probe,
      measurementBinding(viewport),
      { signal: new AbortController().signal, assertCurrent() {} },
    );
    expect(result).toEqual({
      context: { presentationRevision: 3, environmentRevision: 4, projectionSpaceRevision: 5 },
      type: "ready",
    });
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("rejects giant fixed slots before mounting or measuring instead of fabricating readiness", async () => {
    const provider = new HtmlMeasurementProvider();
    for (const width of [32769, 1073741824]) {
      const probe = {
        document: {
          nodes: [
            {
              type: "element" as const,
              kind: "shape" as const,
              attributes: [],
              children: [],
              semantic: {
                type: "shape" as const,
                kind: "space",
                parameters: [{ unit: "pixels" as const, value: width }],
              },
            },
          ],
        },
        style: queryStyle(),
      };
      await expect(
        provider.ensureFixedSlot(probe, measurementBinding(viewport), {
          signal: new AbortController().signal,
          assertCurrent() {},
        }),
      ).rejects.toMatchObject({ category: "resource_limit" });
      expect(document.body.querySelector(".html-measurement-host")).toBeNull();
    }
    expect(fontLoad).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("does not ignore a later declared image failure in full-document diagnostics", async () => {
    const binding = measurementBinding(viewport);
    binding.resources.sprites = [
      {
        name: "portrait",
        revision: 1,
        size: [20, 10],
        frames: [{ resource_id: "declared.png" }],
      },
    ];
    vi.mocked(binding.resourceBridge.readImageMetadata).mockRejectedValue(
      new Error("later image failed"),
    );
    const document: CanonicalHtmlDocument = {
      nodes: [
        { type: "text", text: "first" },
        {
          type: "element",
          kind: "break",
          attributes: [],
          children: [],
          semantic: { type: "break" },
        },
        ...imageProbe().document.nodes,
      ],
    };
    await expect(
      new HtmlMeasurementProvider().measureDocument(document, queryStyle(), binding, {
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toMatchObject({ category: "backend_failure" });
    expect(window.document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("keeps queued measurements bound to their confirmed historical viewport size", async () => {
    let finish!: () => void;
    fontLoad.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const provider = new HtmlMeasurementProvider();
    const guard = { signal: new AbortController().signal, assertCurrent() {} };
    const probe = {
      document: queryText("x"),
      mode: "text_part" as const,
      cuts: [],
      style: queryStyle(),
    };
    const first = provider.measure(probe, measurementBinding(viewport), guard);
    const second = provider.measure(probe, measurementBinding(viewport), guard);
    await flushPromises();
    Object.defineProperty(viewport, "clientWidth", { value: 321 });
    finish();
    await Promise.all([
      expect(first).resolves.toBeDefined(),
      expect(second).resolves.toBeDefined(),
    ]);
    expect(fontLoad).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector(".html-measurement-host")).toBeNull();
  });

  it("does not register canonical button interactions in an offscreen projection", () => {
    const register = vi.spyOn(pointerObservation, "registerPointerButton");
    const binding = measurementBinding(viewport);
    const scope = new HtmlMeasurementScope(binding, queryStyle(), {
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    const warn = vi.spyOn(console, "warn");
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "button",
          semantic: { type: "button", value: "42" },
          interaction: { enabled: true, epoch: 1, id: 2, integer_value: 42 },
          children: [{ type: "text", text: "button" }],
          attributes: [],
        },
        measurementPath: [0],
      },
      global: { provide: { [htmlMeasurementProjectionKey as symbol]: scope } },
    });
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(register).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    wrapper.unmount();
    scope.dispose();
  });
});
