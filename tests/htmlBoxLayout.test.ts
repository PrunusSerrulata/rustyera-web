import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

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
      resources: { sprites: [], canvases: [] },
    },
  }),
}));

import DisplayLineComponent from "@/components/DisplayLine.vue";
import HtmlNode from "@/components/HtmlNode.vue";
import { htmlBoxRowLayoutsForRange, type HtmlBoxRowLayout } from "@/core/htmlBoxLayout";
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
});
