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

describe("interaction assist panel", () => {
  let originalBounds: typeof HTMLElement.prototype.getBoundingClientRect;
  let areaHeight: number;

  beforeEach(() => {
    vi.clearAllMocks();
    store.bridgeKind = "browser";
    store.effectivePreferences.interactionAssistMode = "on";
    store.canInteract = true;
    areaHeight = 300;
    originalBounds = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("game-area"))
        return { width: 800, height: areaHeight } as DOMRect;
      if (this.classList.contains("interaction-assist-panel"))
        return { width: 800, height: 60 } as DOMRect;
      return originalBounds.call(this);
    };
  });

  afterEach(() => {
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
    expect(wrapper.get(".interaction-assist-row").attributes("data-row-key")).toBe("line:7");
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
    if (!hidden) {
      await wrapper.get(".interaction-assist-toggle").trigger("click");
      expect(wrapper.get("section").attributes("style")).toContain(
        `max-height: ${(height - 60) * 0.75}px`,
      );
    }
  });
});
