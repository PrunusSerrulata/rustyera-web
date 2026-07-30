import { flushPromises, shallowMount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.hoisted(() => vi.fn());
const virtualOptions = vi.hoisted(() => ({ value: undefined as any }));
const virtualState = vi.hoisted(() => ({ items: [] as any[], totalSize: 0 }));
const continueFromViewport = vi.hoisted(() => vi.fn());
const projectViewport = vi.hoisted(() => vi.fn());
const store = reactive({
  runtimeEpoch: 1,
  presentation: {
    revision: 1,
    historyRevision: 1,
    lines: [{ line_id: 1, alignment: "left", runs: [] as any[] }],
    backgrounds: [],
    resources: { sprites: [], canvases: [] },
    htmlIsland: [],
  },
  continueFromViewport,
  projectViewport,
  skip: vi.fn(),
  effectivePreferences: { imageScale: 1 },
  gameTextStyle: { fontFamily: "sans-serif", fontSize: "12px", fontSizePx: 12 },
});

vi.mock("@tanstack/vue-virtual", () => ({
  useVirtualizer: (options: any) => {
    virtualOptions.value = options;
    return ref({
      getVirtualItems: () => virtualState.items,
      getTotalSize: () => virtualState.totalSize,
      measureElement: vi.fn(),
      scrollToIndex,
    });
  },
}));
vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import GameViewport from "@/components/GameViewport.vue";

describe("game viewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.runtimeEpoch = 1;
    store.presentation.revision = 1;
    store.presentation.historyRevision = 1;
    store.presentation.lines = [{ line_id: 1, alignment: "left", runs: [] }];
    virtualState.items = [];
    virtualState.totalSize = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("follows new history output but ignores non-history presentation changes", async () => {
    const wrapper = shallowMount(GameViewport);
    store.presentation.revision += 1;
    await nextTick();
    await nextTick();

    expect(scrollToIndex).not.toHaveBeenCalled();

    store.presentation.historyRevision += 1;
    await nextTick();
    await flushPromises();

    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "end" });
    wrapper.unmount();
  });

  it("clamps to the measured DOM bottom after virtual rows settle", async () => {
    const wrapper = shallowMount(GameViewport);
    const viewport = wrapper.get<HTMLElement>("main").element;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 640 });

    store.presentation.historyRevision += 1;
    await nextTick();
    await flushPromises();

    expect(viewport.scrollTop).toBe(640);
    wrapper.unmount();
  });

  it("continues an Enter wait when the viewport itself is left-clicked", async () => {
    const wrapper = shallowMount(GameViewport);
    await wrapper.get("main").trigger("click", { button: 0 });

    expect(continueFromViewport).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("starts continuous Enter-wait skipping from a viewport context menu", async () => {
    const wrapper = shallowMount(GameViewport);
    await wrapper.get("main").trigger("contextmenu");

    expect(store.skip).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("keeps row keys stable across refresh snapshots to retain measured positions", async () => {
    const wrapper = shallowMount(GameViewport);
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    store.presentation.lines = [{ line_id: 1, alignment: "left", runs: [] }];
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    store.runtimeEpoch = 2;
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("2:1");
    wrapper.unmount();
  });

  it("bottom-aligns short history while retaining virtual row coordinates", async () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("game-viewport") ? 720 : 0;
      },
    });
    virtualState.items = [{ index: 0, key: "line-1", start: 0 }];
    virtualState.totalSize = 260;

    try {
      const wrapper = shallowMount(GameViewport);
      await nextTick();
      const history = wrapper.get<HTMLElement>(".virtual-history");
      expect(history.classes()).toContain("history-bottom-aligned");
      expect(history.attributes("style")).toContain("height: 720px");
      expect(wrapper.get<HTMLElement>(".game-line").attributes("style")).toContain(
        "translateY(460px)",
      );
      wrapper.unmount();
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      else delete (HTMLElement.prototype as any).clientHeight;
    }
  });

  it("reserves the visible lower edge of a space-positioned negative-y HTML image", async () => {
    virtualState.items = [{ index: 0, key: "line-1", start: 0 }];
    virtualState.totalSize = 12;
    store.presentation.lines = [
      {
        line_id: 1,
        alignment: "left",
        runs: [
          {
            type: "html_document",
            document: {
              nodes: [
                {
                  semantic: {
                    type: "shape",
                    kind: "space",
                    parameters: [{ unit: "font_height_hundredths", value: 3600 }],
                  },
                },
                {
                  semantic: {
                    type: "image",
                    height: { unit: "font_height_hundredths", value: 3600 },
                    y: { unit: "font_height_hundredths", value: -3300 },
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const wrapper = shallowMount(GameViewport);
    await nextTick();
    expect(wrapper.get<HTMLElement>(".game-line").attributes("style")).toContain(
      "min-height: 36px",
    );
    wrapper.unmount();
  });
});
