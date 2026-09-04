import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockRuntimeStore = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/stores/runtime", async () => {
  const { reactive } = await import("vue");
  mockRuntimeStore.current = reactive({
    activate: vi.fn(),
    canInteract: true,
    interactionEnabled: (interaction: any) => interaction.enabled === true,
    replaceFullWidthSpaces: false,
    effectivePreferences: { fontFamilyOverride: null, fontSizeOverridePx: null },
    gameTextStyle: { fontSizePx: 16 },
  });
  return { useRuntimeStore: () => mockRuntimeStore.current };
});

import DisplayLine from "@/components/DisplayLine.vue";
import RunRenderer from "@/components/RunRenderer.vue";
import TextRunGroup from "@/components/TextRunGroup.vue";
import type { DisplayRun, PresentationLength, TextStyle } from "@/core/types";

type TextLayoutRun = Extract<DisplayRun, { type: "text_layout" }>;

function textStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    font_millipixels: 16_000,
    ...overrides,
  };
}

describe("display line rendering", () => {
  afterEach(() => {
    mockRuntimeStore.current.replaceFullWidthSpaces = false;
    mockRuntimeStore.current.effectivePreferences.fontFamilyOverride = null;
    mockRuntimeStore.current.effectivePreferences.fontSizeOverridePx = null;
  });

  it("renders large text-layout groups without per-run Vue components", () => {
    const runs: TextLayoutRun[] = Array.from({ length: 4096 }, (_, index) => ({
      type: "text_layout" as const,
      text: String(index % 10),
      columns: (index % 3) + 1,
      style: textStyle(
        index === 0
          ? {
              foreground: { red: 18, green: 52, blue: 86, alpha: 255 },
              background: { red: 1, green: 2, blue: 3, alpha: 255 },
              bold: true,
              italic: true,
              underline: true,
              strikeout: true,
              font_family: "Runtime Font",
              font_millipixels: 18_000,
            }
          : {},
      ),
    }));
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 80,
        line: {
          line_id: 1,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs,
        },
      },
    });

    const spans = wrapper.findAll("span.text-layout");
    expect(spans).toHaveLength(runs.length);
    expect(wrapper.findAllComponents(TextRunGroup)).toHaveLength(1);
    expect(wrapper.findAllComponents(RunRenderer)).toHaveLength(0);
    expect(spans.slice(0, 6).map((span) => span.text())).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(spans.slice(0, 6).map((span) => span.attributes("data-columns"))).toEqual([
      "1",
      "2",
      "3",
      "1",
      "2",
      "3",
    ]);
    expect(spans[0].attributes("style")).toContain(
      "color: var(--game-interaction-foreground, rgba(18, 52, 86, 1))",
    );
    expect((spans[0].element as HTMLElement).style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(spans[0].attributes("style")).toContain("font-weight: bold");
    expect(spans[0].attributes("style")).toContain("font-style: italic");
    expect(spans[0].attributes("style")).toContain("text-decoration: underline line-through");
    expect(spans[0].attributes("style")).toContain("font-family: Runtime Font, var(--game-font)");
    expect(spans[0].attributes("style")).toContain("font-size: 18px");
    expect(spans[0].attributes("style")).toContain("width: 1ch");
    expect(spans[0].attributes("style")).toContain("vertical-align: top");
  });

  it("reacts to text replacement and font override preferences without mutating runs", async () => {
    const run = {
      type: "text_layout" as const,
      text: "left　right",
      columns: 12,
      style: textStyle({ font_family: "Runtime Font", font_millipixels: 18_000 }),
    };
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 80,
        line: {
          line_id: 1,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [run],
        },
      },
    });

    expect(wrapper.get("span").text()).toBe("left　right");
    expect(wrapper.get<HTMLElement>("span").element.style.fontFamily).toBe(
      "Runtime Font, var(--game-font)",
    );
    expect(wrapper.get<HTMLElement>("span").element.style.fontSize).toBe("18px");

    mockRuntimeStore.current.replaceFullWidthSpaces = true;
    mockRuntimeStore.current.effectivePreferences.fontFamilyOverride = "User Font";
    mockRuntimeStore.current.effectivePreferences.fontSizeOverridePx = 20;
    await nextTick();

    expect(wrapper.get("span").text()).toBe("left  right");
    expect(wrapper.get<HTMLElement>("span").element.style.fontFamily).toBe("var(--game-font)");
    expect(wrapper.get<HTMLElement>("span").element.style.fontSize).toBe("var(--game-size)");
    expect(run).toEqual({
      type: "text_layout",
      text: "left　right",
      columns: 12,
      style: textStyle({ font_family: "Runtime Font", font_millipixels: 18_000 }),
    });
  });

  it("coalesces adjacent whitespace layout cells without crossing style boundaries", () => {
    const white = textStyle();
    const accent = textStyle({ foreground: { red: 18, green: 52, blue: 86, alpha: 255 } });
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 80,
        line: {
          line_id: 1,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [
            { type: "text_layout", text: " ", columns: 1, style: white },
            { type: "text_layout", text: "  ", columns: 2, style: { ...white } },
            { type: "text_layout", text: " ", columns: 3, style: accent },
            { type: "text_layout", text: "label", columns: 5, style: accent },
            { type: "text_layout", text: " ", columns: 1, style: accent },
          ],
        },
      },
    });

    const spans = wrapper.findAll("span.text-layout");
    expect(spans).toHaveLength(4);
    expect(spans.map((span) => span.attributes("data-columns"))).toEqual(["3", "3", "5", "1"]);
    expect(spans.map((span) => span.element.textContent)).toEqual(["   ", " ", "label", " "]);
    expect(spans[0].attributes("style")).toContain("width: 3ch");
  });

  it("preserves mixed run order and keeps non-text runs on RunRenderer", () => {
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 80,
        line: {
          line_id: 1,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [
            { type: "text", text: "left", style: textStyle() },
            { type: "text_layout", text: "middle", columns: 6, style: textStyle() },
            {
              type: "button",
              value: { type: "string", value: "click-value" },
              runs: [{ type: "text", text: "click", style: textStyle() }],
              token: { epoch: 1, id: 1 },
              enabled: true,
              generation: 1,
            },
            { type: "text", text: "right", style: textStyle() },
            { type: "space", width: { unit: "pixels", value: 4 } },
          ],
        },
      },
    });

    expect(wrapper.findAllComponents(TextRunGroup)).toHaveLength(3);
    expect(wrapper.findAllComponents(RunRenderer)).toHaveLength(2);
    const html = wrapper.html();
    const positions = [">left</span>", ">middle</span>", "<button", ">right</span>"].map(
      (fragment) => html.indexOf(fragment),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(wrapper.get("button.game-button").text()).toBe("click");
    expect(wrapper.get("button.game-button").attributes("disabled")).toBeUndefined();
  });

  it("wraps only consecutive semantic cells into the responsive grid", () => {
    const cells = Array.from({ length: 8 }, (_, index) => ({
      type: "column_cell",
      alignment: "left",
      preferred_columns: 25,
      content: [{ type: "text", text: `option ${index}`, style: {} }],
    }));
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 79,
        line: {
          line_id: 1,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [{ type: "text", text: "prefix", style: {} }, ...cells] as any,
        },
      },
    });

    const group = wrapper.get<HTMLElement>(".column-group");
    expect(group.attributes("style")).toContain("repeat(4, 19ch)");
    expect(group.findAll(".column-cell")).toHaveLength(8);
    expect(wrapper.findAllComponents(TextRunGroup)).toHaveLength(9);
    expect(wrapper.findAllComponents(RunRenderer)).toHaveLength(8);
    expect(wrapper.text()).toContain("prefixoption 0");
  });

  it("repeats and clips each DRAWLINE pattern to the current viewport columns", () => {
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 6,
        line: {
          line_id: 2,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [
            {
              type: "separator",
              pattern: "*-",
              role: "rule",
              style: {
                foreground: { red: 18, green: 52, blue: 86, alpha: 255 },
                bold: false,
                italic: false,
                underline: false,
                strikeout: false,
                font_millipixels: 16_000,
              },
            },
          ],
        },
      },
    });

    const separator = wrapper.get<HTMLElement>(".separator");
    expect(separator.attributes("data-pattern")).toBe("*-");
    expect(separator.attributes("style")).toContain("width: 6ch");
    expect(separator.attributes("style")).toContain("rgba(18, 52, 86, 1)");
    expect(separator.text()).toBe("*-".repeat(6));
  });

  it("projects eraFL COLOR_LINE rectangles as a contiguous filled rule", () => {
    const color = (value: number) => ({ red: value, green: value, blue: value, alpha: 255 });
    // COLOR_LINE converts 0x202020 through integer HSV arithmetic, yielding
    // 30 for the base segments and 17 for the final gradient segment.
    const parameters = (width: number): PresentationLength[] => [
      { unit: "font_height_hundredths", value: 0 },
      { unit: "font_height_hundredths", value: 45 },
      { unit: "font_height_hundredths", value: width },
      { unit: "font_height_hundredths", value: 10 },
    ];
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 87,
        line: {
          line_id: 3,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [
            {
              type: "shape",
              shape: {
                kind: "rect",
                parameters: parameters(6200),
                foreground: color(30),
                background: { red: 255, green: 255, blue: 0, alpha: 255 },
              },
            },
            {
              type: "shape",
              shape: { kind: "rect", parameters: parameters(100), foreground: color(30) },
            },
            {
              type: "shape",
              shape: { kind: "rect", parameters: parameters(100), foreground: color(17) },
            },
          ],
        },
      },
    });

    const slots = wrapper.findAll<HTMLElement>(".shape.shape-rect[data-shape='rect']");
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => [slot.element.style.width, slot.element.style.height])).toEqual([
      ["992px", "16px"],
      ["16px", "16px"],
      ["16px", "16px"],
    ]);
    expect(
      slots.reduce((width, slot) => width + Number.parseFloat(slot.element.style.width), 0),
    ).toBe(1024);

    const visuals = wrapper.findAll<HTMLElement>(".shape-rect-visual");
    for (const visual of visuals) {
      expect(visual.element.style.left).toBe("0px");
      expect(visual.element.style.top).toBe("7.2px");
      expect(visual.element.style.height).toBe("1.6px");
    }
    expect(visuals[0].element.style.backgroundColor).toBe(
      "var(--game-shape-foreground, rgba(30, 30, 30, 1))",
    );
    expect(visuals[0].element.style.getPropertyValue("--game-button-shape-foreground")).toBe(
      "rgba(255, 255, 0, 1)",
    );
    expect(visuals[2].element.style.backgroundColor).toBe(
      "var(--game-shape-foreground, rgba(17, 17, 17, 1))",
    );
  });

  it("projects direct PRINT_SPACE from its presentation length", () => {
    const wrapper = mount(DisplayLine, {
      props: {
        viewportColumns: 87,
        line: {
          line_id: 4,
          temporary: false,
          logical_line_start: true,
          line_end: true,
          alignment: "left",
          runs: [
            {
              type: "space",
              width: { unit: "font_height_hundredths", value: 3600 },
            },
          ],
        },
      },
    });

    const space = wrapper.get<HTMLElement>(".space").element.style;
    expect(space.width).toBe("576px");
    expect(space.height).toBe("16px");
  });
});
