import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    canInteract: true,
    interactionEnabled: (interaction: any) => interaction.enabled === true,
    effectivePreferences: { fontFamilyOverride: null, fontSizeOverridePx: null },
    gameTextStyle: { fontSizePx: 16 },
  }),
}));

import DisplayLine from "@/components/DisplayLine.vue";
import type { PresentationLength } from "@/core/types";

describe("display line column groups", () => {
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
