import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    canInteract: true,
    effectivePreferences: { fontFamilyOverride: null, fontSizeOverridePx: null },
  }),
}));

import DisplayLine from "@/components/DisplayLine.vue";

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
});
