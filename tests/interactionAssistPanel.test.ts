import { mount } from "@vue/test-utils";
import { reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activate = vi.hoisted(() => vi.fn());
const store = reactive({
  bridgeKind: "browser" as "browser" | "tauri",
  effectivePreferences: { interactionAssistMode: "on" as "off" | "on" | "auto" },
  presentation: {
    lines: [
      {
        line_id: 7,
        runs: [
          {
            type: "button",
            enabled: true,
            token: { epoch: 1, id: 2 },
            runs: [{ type: "text", text: "A very long interaction label" }],
          },
        ],
      },
    ] as any[],
    htmlIsland: [],
  },
  canInteract: true,
  activate,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import InteractionAssistPanel from "@/components/InteractionAssistPanel.vue";

const PANEL_HEIGHT = 60;
const ACTION_ROW_HEIGHT = 30;
const EXPANDED_ROW_GAP = 6;
const EXPANSION_BOUNDARY =
  PANEL_HEIGHT + (PANEL_HEIGHT + ACTION_ROW_HEIGHT + EXPANDED_ROW_GAP) / 0.75;

describe("interaction assist panel", () => {
  let originalBounds: typeof HTMLElement.prototype.getBoundingClientRect;
  let areaHeight: number;

  beforeEach(() => {
    vi.clearAllMocks();
    store.bridgeKind = "browser";
    store.effectivePreferences.interactionAssistMode = "on";
    store.canInteract = true;
    store.presentation.lines = [
      {
        line_id: 7,
        runs: [
          {
            type: "button",
            enabled: true,
            token: { epoch: 1, id: 2 },
            runs: [
              {
                type: "text",
                text: "A very long interaction label",
                style: { foreground: { red: 12, green: 34, blue: 56, alpha: 255 } },
              },
            ],
          },
        ],
      },
    ];
    areaHeight = 300;
    const originalComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = originalComputedStyle(element);
      return {
        ...style,
        getPropertyValue: (name: string) =>
          name === "--interaction-assist-row-gap"
            ? `${EXPANDED_ROW_GAP}px`
            : style.getPropertyValue(name),
      } as CSSStyleDeclaration;
    });
    originalBounds = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("game-area"))
        return { width: 800, height: areaHeight } as DOMRect;
      if (this.classList.contains("interaction-assist-panel"))
        return { width: 800, height: PANEL_HEIGHT } as DOMRect;
      if (this.classList.contains("interaction-assist-row"))
        return { width: 800, height: ACTION_ROW_HEIGHT } as DOMRect;
      return originalBounds.call(this);
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    document.body.replaceChildren();
  });

  it("shows a collapsed fixed-width action and activates its runtime token", async () => {
    const area = document.createElement("div");
    area.className = "game-area";
    document.body.append(area);
    const wrapper = mount(InteractionAssistPanel, { attachTo: area });
    await wrapper.vm.$nextTick();

    const panel = wrapper.get("section");
    expect(panel.attributes("aria-hidden")).toBe("false");
    const action = wrapper.get(".interaction-assist-action");
    expect(action.attributes("title")).toBe("A very long interaction label");
    expect(action.attributes("style")).toContain("color: rgb(12, 34, 56)");
    expect(wrapper.find(".interaction-assist-header strong").exists()).toBe(false);
    expect(wrapper.get(".interaction-assist-toggle").text()).toBe("⏬");
    expect(wrapper.get(".interaction-assist-toggle").attributes("aria-label")).toBe("展开");
    await action.trigger("click");
    expect(activate).toHaveBeenCalledWith({ epoch: 1, id: 2 });
  });

  it("expands upward within three quarters of the projected viewport", async () => {
    const area = document.createElement("div");
    area.className = "game-area";
    document.body.append(area);
    const wrapper = mount(InteractionAssistPanel, { attachTo: area });
    await wrapper.vm.$nextTick();

    await wrapper.get(".interaction-assist-toggle").trigger("click");
    expect(wrapper.get("section").classes()).toContain("expanded");
    expect(wrapper.get("section").attributes("style")).toContain("max-height: 180px");
    expect(wrapper.get(".interaction-assist-toggle").text()).toBe("⏫");
    expect(wrapper.get(".interaction-assist-toggle").attributes("aria-label")).toBe("折叠");
    expect(wrapper.get(".interaction-assist-row").attributes("data-row-key")).toBe("line:7");
  });

  it("keeps an action-row placeholder when no interaction is currently available", async () => {
    store.presentation.lines = [];
    const area = document.createElement("div");
    area.className = "game-area";
    document.body.append(area);
    const wrapper = mount(InteractionAssistPanel, { attachTo: area });
    await wrapper.vm.$nextTick();

    expect(wrapper.get("section").attributes("aria-hidden")).toBe("false");
    expect(wrapper.find(".interaction-assist-flat-row").exists()).toBe(true);
    expect(wrapper.findAll(".interaction-assist-action")).toHaveLength(0);
  });

  it("does not consume the game area when the remaining viewport is too short", async () => {
    areaHeight = 100;
    const area = document.createElement("div");
    area.className = "game-area";
    document.body.append(area);
    const wrapper = mount(InteractionAssistPanel, { attachTo: area });
    await wrapper.vm.$nextTick();

    expect(wrapper.get("section").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get(".interaction-assist-slot").classes()).toContain(
      "interaction-assist-hidden",
    );
  });

  it.each([
    [120, true],
    [139, true],
    [140, false],
    [141, false],
  ])("applies the strict expanded-height boundary at a %ipx game area", async (height, hidden) => {
    areaHeight = height;
    const area = document.createElement("div");
    area.className = "game-area";
    document.body.append(area);
    const wrapper = mount(InteractionAssistPanel, { attachTo: area });
    await wrapper.vm.$nextTick();

    expect(wrapper.get("section").attributes("aria-hidden")).toBe(String(hidden));
  });

  it.each([
    [EXPANSION_BOUNDARY - 1, true],
    [EXPANSION_BOUNDARY, false],
  ])(
    "disables expansion below the two-row boundary at a %ipx game area",
    async (height, disabled) => {
      areaHeight = height;
      const area = document.createElement("div");
      area.className = "game-area";
      document.body.append(area);
      const wrapper = mount(InteractionAssistPanel, { attachTo: area });
      await wrapper.vm.$nextTick();

      const toggle = wrapper.get<HTMLButtonElement>(".interaction-assist-toggle");
      expect(toggle.element.disabled).toBe(disabled);
      await toggle.trigger("click");
      expect(wrapper.get("section").classes().includes("expanded")).toBe(!disabled);
    },
  );
});
