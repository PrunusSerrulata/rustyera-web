import { flushPromises, shallowMount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.hoisted(() => vi.fn());
const virtualOptions = vi.hoisted(() => ({ value: undefined as any }));
const continueFromViewport = vi.hoisted(() => vi.fn());
const projectViewport = vi.hoisted(() => vi.fn());
const store = reactive({
  runtimeEpoch: 1,
  presentation: {
    revision: 1,
    historyRevision: 1,
    lines: [{ line_id: 1, alignment: "left", runs: [] }],
    backgrounds: [],
    resources: { sprites: [], canvases: [] },
    htmlIsland: [],
  },
  continueFromViewport,
  projectViewport,
  skip: vi.fn(),
});

vi.mock("@tanstack/vue-virtual", () => ({
  useVirtualizer: (options: any) => {
    virtualOptions.value = options;
    return ref({
      getVirtualItems: () => [],
      getTotalSize: () => 0,
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
});
