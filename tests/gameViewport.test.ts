import { shallowMount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.hoisted(() => vi.fn());
const measure = vi.hoisted(() => vi.fn());
const virtualOptions = vi.hoisted(() => ({ value: undefined as any }));
const continueFromViewport = vi.hoisted(() => vi.fn());
const projectViewport = vi.hoisted(() => vi.fn());
const store = reactive({
  runtimeEpoch: 1,
  presentationGeneration: 1,
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
      measure,
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
    store.presentationGeneration = 1;
    store.presentation.revision = 1;
    store.presentation.historyRevision = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("follows new history output but ignores non-history presentation changes", async () => {
    const wrapper = shallowMount(GameViewport);
    const nativeScroll = vi.fn();
    Object.defineProperty(wrapper.get("main").element, "scrollTop", { set: nativeScroll });
    store.presentation.revision += 1;
    await nextTick();
    await nextTick();

    expect(scrollToIndex).not.toHaveBeenCalled();

    store.presentation.historyRevision += 1;
    await nextTick();
    await nextTick();

    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "end" });
    expect(nativeScroll).not.toHaveBeenCalled();

    scrollToIndex.mockClear();
    measure.mockClear();
    await wrapper.get("main").trigger("load");
    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "end" });
    expect(measure).toHaveBeenCalledOnce();

    scrollToIndex.mockClear();
    await wrapper.get("main").trigger("wheel");
    await wrapper.get("main").trigger("load");
    expect(scrollToIndex).not.toHaveBeenCalled();
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

  it("isolates virtual row keys across runtime epochs and authoritative snapshots", async () => {
    const wrapper = shallowMount(GameViewport);
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1:1");
    store.runtimeEpoch = 2;
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:2:1");
    store.presentationGeneration = 2;
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("2:2:1");
    wrapper.unmount();
  });
});
