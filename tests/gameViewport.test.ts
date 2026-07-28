import { shallowMount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.hoisted(() => vi.fn());
const continueFromViewport = vi.hoisted(() => vi.fn());
const projectViewport = vi.hoisted(() => vi.fn());
const store = reactive({
  presentation: {
    revision: 1,
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
  useVirtualizer: () =>
    ref({
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measureElement: vi.fn(),
      scrollToIndex,
    }),
}));
vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import GameViewport from "@/components/GameViewport.vue";

describe("game viewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.presentation.revision = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("always follows a new presentation revision to the last line", async () => {
    const wrapper = shallowMount(GameViewport);
    store.presentation.revision += 1;
    await nextTick();
    await nextTick();

    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "end" });
    wrapper.unmount();
  });

  it("continues an Enter wait when the viewport itself is left-clicked", async () => {
    const wrapper = shallowMount(GameViewport);
    await wrapper.get("main").trigger("click", { button: 0 });

    expect(continueFromViewport).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
