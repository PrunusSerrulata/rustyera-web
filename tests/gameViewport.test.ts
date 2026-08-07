import { flushPromises, shallowMount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    tooltip: {},
  },
  continueFromViewport,
  projectViewport,
  skip: vi.fn(),
  effectivePreferences: { imageScale: 1 },
  gameTextStyle: { fontFamily: "sans-serif", fontSize: "12px", fontSizePx: 12 },
  gameLineHeightPx: 13,
  useMouse: true,
  scrollHeight: 1,
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

import DisplayLine from "@/components/DisplayLine.vue";
import GameViewport from "@/components/GameViewport.vue";

describe("game viewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.runtimeEpoch = 1;
    store.presentation.revision = 1;
    store.presentation.historyRevision = 1;
    store.presentation.lines = [{ line_id: 1, alignment: "left", runs: [] }];
    store.useMouse = true;
    store.scrollHeight = 1;
    virtualState.items = [];
    virtualState.totalSize = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports a viewport whose height changes without a width change", async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let height = 600;
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 800 },
      clientHeight: { configurable: true, get: () => height },
    });

    try {
      const wrapper = shallowMount(GameViewport);
      projectViewport.mockClear();
      height = 650;
      resize?.([], {} as ResizeObserver);
      await flushPromises();

      expect(projectViewport).toHaveBeenCalledOnce();
      wrapper.unmount();
    } finally {
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
      else delete (HTMLElement.prototype as any).clientWidth;
      if (originalHeight)
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
      else delete (HTMLElement.prototype as any).clientHeight;
    }
  });

  it("reports new line columns when font metrics change at the same viewport size", async () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 800 },
      clientHeight: { configurable: true, get: () => 600 },
    });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    let probeWidth = 80;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("column-width-probe")) return { width: probeWidth } as DOMRect;
      return originalBounds.call(this);
    };

    let wrapper: ReturnType<typeof shallowMount> | undefined;
    try {
      wrapper = shallowMount(GameViewport);
      expect(projectViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ lineColumns: 100 }),
      );
      projectViewport.mockClear();
      probeWidth = 100;
      store.gameTextStyle.fontSize = "13px";
      await nextTick();
      await flushPromises();

      expect(projectViewport).toHaveBeenCalledWith(expect.objectContaining({ lineColumns: 80 }));
    } finally {
      wrapper?.unmount();
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      delete (HTMLElement.prototype as any).clientWidth;
      delete (HTMLElement.prototype as any).clientHeight;
      store.gameTextStyle.fontSize = "12px";
    }
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

  it("updates an equal-length dynamic tail without moving the viewport", async () => {
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [] },
      { line_id: 2, alignment: "left", runs: [{ type: "text", text: "frame 1" }] },
    ];
    virtualState.items = [{ index: 1, key: "1:2", start: 13 }];
    const wrapper = shallowMount(GameViewport);
    const viewport = wrapper.get<HTMLElement>("main").element;
    const setScrollTop = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: {
        configurable: true,
        get: () => 25,
        set: setScrollTop,
      },
    });
    scrollToIndex.mockClear();

    store.presentation.lines = [
      store.presentation.lines[0],
      { line_id: 3, alignment: "left", runs: [{ type: "text", text: "frame 2" }] },
    ];
    await nextTick();

    expect(wrapper.findComponent(DisplayLine).props("line")).toEqual(store.presentation.lines[1]);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(setScrollTop).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps an equal-length dynamic tail pinned when it refreshes at the bottom", async () => {
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [] },
      { line_id: 2, alignment: "left", runs: [{ type: "text", text: "frame 1" }] },
    ];
    virtualState.items = [{ index: 1, key: "1:2", start: 13 }];
    const wrapper = shallowMount(GameViewport);
    const viewport = wrapper.get<HTMLElement>("main").element;
    let scrollTop = 50;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: {
        configurable: true,
        get: () => (scrollToIndex.mock.calls.length ? 106.5 : 100),
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    scrollToIndex.mockClear();

    store.presentation.lines = [
      store.presentation.lines[0],
      { line_id: 3, alignment: "left", runs: [{ type: "text", text: "frame 2" }] },
    ];
    await nextTick();
    await flushPromises();

    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollTop).toBe(106.5);
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

  it("applies UseMouse and ScrollHeight to viewport pointer scrolling", async () => {
    const wrapper = shallowMount(GameViewport);
    const viewport = wrapper.get<HTMLElement>("main");
    store.scrollHeight = 3;

    await viewport.trigger("wheel", { deltaY: 1 });
    expect(viewport.element.scrollTop).toBe(39);

    store.useMouse = false;
    await viewport.trigger("click", { button: 0 });
    await viewport.trigger("contextmenu");
    await viewport.trigger("wheel", { deltaY: 1 });
    expect(continueFromViewport).not.toHaveBeenCalled();
    expect(store.skip).not.toHaveBeenCalled();
    expect(viewport.element.scrollTop).toBe(39);
    expect(viewport.classes()).toContain("mouse-disabled");
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
