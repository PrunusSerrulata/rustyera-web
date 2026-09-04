import {
  DisplayLine,
  GameViewport,
  afterEach,
  beforeEach,
  continueFromViewport,
  defaultRangeExtractor,
  describe,
  dispatchTouch,
  expect,
  flushPromises,
  it,
  measure,
  mountViewport,
  nextTick,
  projectViewport,
  scrollToIndex,
  shallowMount,
  store,
  vi,
  virtualOptions,
  virtualState,
} from "./gameViewport.testHarness";

describe("game viewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.runtimeEpoch = 1;
    store.presentation.revision = 1;
    store.presentation.historyRevision = 1;
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [], text_background_eligible: false },
    ];
    store.presentation.settings = {};
    store.presentation.inputWait = undefined;
    store.gameLineHeightPx = 13;
    store.useMouse = true;
    store.scrollHeight = 1;
    virtualState.items = [];
    virtualState.totalSize = 0;
    virtualState.naturalRange = { startIndex: 0, endIndex: 0 };
    virtualState.useOptionsRange = false;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
      const wrapper = mountViewport();
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

  it("projects the global text background across eligible virtualized rows", async () => {
    virtualState.items = [{ index: 0, key: "1:1", start: 0 }];
    store.presentation.lines = [
      {
        line_id: 1,
        alignment: "left",
        runs: [],
        text_background_eligible: true,
      },
    ];
    store.presentation.settings = {
      text_line_background: { red: 17, green: 34, blue: 51, alpha: 127 },
    };
    const wrapper = mountViewport();
    await nextTick();
    const row = wrapper.find(".virtual-history > .game-line").element as HTMLElement;
    expect(row.style.backgroundColor).toBe("rgba(17, 34, 51, 0.498)");

    store.presentation.settings = { text_line_background: null };
    await nextTick();
    expect(row.style.backgroundColor).toBe("");
    wrapper.unmount();
  });

  it("shares one compact depth order across scene, line HTML, text zero, and island HTML", () => {
    store.presentation.scene = { revision: 1, layers: [{ depth: 3 }] } as any;
    store.presentation.lines[0].runs = [
      {
        type: "html_document",
        document: { nodes: [{ semantic: { type: "division", depth: 2 }, children: [] }] },
      },
    ];
    store.presentation.htmlIsland = [
      { nodes: [{ semantic: { type: "division", depth: -5 }, children: [] }] },
    ];
    const wrapper = mountViewport();
    const ranks = wrapper.getComponent({ name: "SceneCompositor" }).props("depthRanks") as Map<
      string,
      number
    >;
    expect([...ranks.entries()]).toEqual([
      ["3", -2],
      ["2", -1],
      ["0", 0],
      ["-5", 1],
    ]);
    wrapper.unmount();
    store.presentation.scene = { revision: 0, layers: [] };
    store.presentation.lines[0].runs = [];
    store.presentation.htmlIsland = [];
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
      wrapper = mountViewport();
      expect(projectViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ lineColumns: 100 }),
        expect.any(String),
      );
      projectViewport.mockClear();
      // A new presentation object can recompute an identical gameTextStyle.
      store.gameTextStyle = { ...store.gameTextStyle };
      await nextTick();
      await flushPromises();
      expect(projectViewport).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      probeWidth = 100;
      store.gameTextStyle.fontSize = "13px";
      await nextTick();
      await flushPromises();

      expect(projectViewport).toHaveBeenCalledWith(
        expect.objectContaining({ lineColumns: 80 }),
        expect.any(String),
      );
      expect(measure).toHaveBeenCalledOnce();
      projectViewport.mockClear();
      store.gameTextStyle.fontFamily = "serif";
      await nextTick();
      await flushPromises();
      expect(projectViewport).toHaveBeenCalledOnce();
      expect(projectViewport).toHaveBeenCalledWith(
        expect.objectContaining({ width: 800, height: 600, lineColumns: 80 }),
        expect.any(String),
      );
    } finally {
      wrapper?.unmount();
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      delete (HTMLElement.prototype as any).clientWidth;
      delete (HTMLElement.prototype as any).clientHeight;
      store.gameTextStyle.fontSize = "12px";
      store.gameTextStyle.fontFamily = "sans-serif";
    }
  });

  it("invalidates measured rows when only the configured line height changes", async () => {
    const originalLineHeight = store.gameLineHeightPx;
    const wrapper = mountViewport();
    measure.mockClear();

    try {
      store.gameLineHeightPx = originalLineHeight + 1;
      await nextTick();
      await flushPromises();

      expect(measure).toHaveBeenCalledOnce();
    } finally {
      wrapper.unmount();
      store.gameLineHeightPx = originalLineHeight;
    }
  });

  it("follows new history output but ignores non-history presentation changes", async () => {
    const wrapper = mountViewport();
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

  it("selects the committed history tail before the first measurement frame", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    virtualState.items = [{ index: 0, key: "1:1", start: 0 }];
    const wrapper = mountViewport();
    scrollToIndex.mockClear();

    store.presentation.lines[0] = {
      line_id: 2,
      alignment: "left",
      runs: [],
      text_background_eligible: false,
    };
    store.presentation.revision += 1;
    store.presentation.historyRevision += 1;
    await nextTick();

    expect(wrapper.findComponent(DisplayLine).props("line").line_id).toBe(2);
    expect(scrollToIndex).toHaveBeenCalledOnce();
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "end" });
    expect(callbacks).toHaveLength(1);
    wrapper.unmount();
  });

  it("mounts the terminal history range in the first followed commit", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    virtualState.useOptionsRange = true;
    virtualState.naturalRange = { startIndex: 20, endIndex: 59 };
    store.presentation.lines = Array.from({ length: 100 }, (_, index) => ({
      line_id: index + 1,
      alignment: "left",
      runs: [],
      text_background_eligible: false,
    }));
    const wrapper = mountViewport();
    scrollToIndex.mockClear();
    callbacks.length = 0;

    store.presentation.lines = Array.from({ length: 100 }, (_, index) => ({
      line_id: index + 101,
      alignment: "left",
      runs: [],
      text_background_eligible: false,
    }));
    store.presentation.revision += 1;
    store.presentation.historyRevision += 1;
    await nextTick();

    const committedIds = wrapper
      .findAllComponents(DisplayLine)
      .map((line) => line.props("line").line_id);
    expect(committedIds.at(-1)).toBe(200);
    expect(committedIds).not.toContain(101);
    expect(committedIds).toHaveLength(40);
    expect(scrollToIndex).toHaveBeenCalledOnce();
    // The compositor layout projection and bottom follow own independent frames. Drain their
    // bounded queue because releasing the terminal extractor can itself schedule one final
    // projection frame.
    expect(callbacks.length).toBeGreaterThan(0);
    expect(virtualOptions.value.value.rangeExtractor).not.toBe(defaultRangeExtractor);
    for (
      let frame = 0;
      frame < 8 && virtualOptions.value.value.rangeExtractor !== defaultRangeExtractor;
      frame += 1
    ) {
      const pending = callbacks.splice(0);
      expect(pending.length).toBeGreaterThan(0);
      for (const callback of pending) callback(frame * 16);
      await flushPromises();
    }
    expect(virtualOptions.value.value.rangeExtractor).toBe(defaultRangeExtractor);
    wrapper.unmount();
  });

  it("does not retain the terminal range after scrolling back", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    let scrollTop = 50;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    store.presentation.historyRevision += 1;
    await nextTick();
    callbacks.shift()?.(0);
    await flushPromises();
    callbacks.shift()?.(0);
    await flushPromises();
    scrollTop = 0;
    await wrapper.get("main").trigger("scroll");

    expect(virtualOptions.value.value.rangeExtractor).toBe(defaultRangeExtractor);
    wrapper.unmount();
  });

  it("preserves an NF scroll-back chain through a closed wait and resumes following on ordinary input", async () => {
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    let scrollTop = 40;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    scrollToIndex.mockClear();

    store.presentation.inputWait = { viewport_policy: "preserve_user_viewport" };
    store.presentation.historyRevision += 1;
    await nextTick();
    await flushPromises();
    expect(scrollTop).toBe(40);
    expect(scrollToIndex).not.toHaveBeenCalled();

    store.presentation.inputWait = undefined;
    store.presentation.historyRevision += 1;
    await nextTick();
    await flushPromises();
    expect(scrollTop).toBe(40);

    store.presentation.inputWait = { viewport_policy: "follow_output" };
    await nextTick();
    await flushPromises();
    expect(scrollToIndex).toHaveBeenCalled();
    expect(scrollTop).toBe(200);
    wrapper.unmount();
  });

  it("updates an equal-length dynamic tail without moving the viewport", async () => {
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [], text_background_eligible: false },
      {
        line_id: 2,
        alignment: "left",
        runs: [{ type: "text", text: "frame 1" }],
        text_background_eligible: true,
      },
    ];
    virtualState.items = [{ index: 1, key: "1:2", start: 13 }];
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    const setScrollTop = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: {
        configurable: true,
        get: () => (wrapper.findComponent(DisplayLine).props("line").line_id === 2 ? 100 : 90),
      },
      scrollTop: {
        configurable: true,
        get: () => 40,
        set: setScrollTop,
      },
    });
    scrollToIndex.mockClear();

    store.presentation.lines = [
      store.presentation.lines[0],
      {
        line_id: 3,
        alignment: "left",
        runs: [{ type: "text", text: "frame 2" }],
        text_background_eligible: true,
      },
    ];
    await nextTick();

    expect(wrapper.findComponent(DisplayLine).props("line")).toEqual(store.presentation.lines[1]);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(setScrollTop).not.toHaveBeenCalled();
    expect(virtualOptions.value.value.rangeExtractor).toBe(defaultRangeExtractor);
    wrapper.unmount();
  });

  it("keeps an equal-length dynamic tail pinned when it refreshes at the bottom", async () => {
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [], text_background_eligible: false },
      {
        line_id: 2,
        alignment: "left",
        runs: [{ type: "text", text: "frame 1" }],
        text_background_eligible: true,
      },
    ];
    virtualState.items = [{ index: 1, key: "1:2", start: 13 }];
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    let scrollTop = 50;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: {
        configurable: true,
        get: () => (wrapper.findComponent(DisplayLine).props("line").line_id === 2 ? 100 : 106.5),
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
      {
        line_id: 3,
        alignment: "left",
        runs: [{ type: "text", text: "frame 2" }],
        text_background_eligible: true,
      },
    ];
    await nextTick();
    await flushPromises();

    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollTop).toBe(106.5);
    wrapper.unmount();
  });

  it("clamps after restoring the natural virtual range", async () => {
    const wrapper = shallowMount(GameViewport);
    const viewport = wrapper.get<HTMLElement>("main").element;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => (virtualOptions.value.value.rangeExtractor === defaultRangeExtractor ? 640 : 320),
    });

    store.presentation.historyRevision += 1;
    await nextTick();
    await flushPromises();

    expect(viewport.scrollTop).toBe(640);
    wrapper.unmount();
  });

  it("coalesces burst history following into the newest refresh", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const wrapper = mountViewport();
    store.presentation.historyRevision += 1;
    await nextTick();
    const firstExtractor = virtualOptions.value.value.rangeExtractor;
    store.presentation.historyRevision += 1;
    await nextTick();

    expect(virtualOptions.value.value.rangeExtractor).not.toBe(firstExtractor);

    callbacks.shift()?.(0);
    await flushPromises();
    expect(virtualOptions.value.value.rangeExtractor).not.toBe(defaultRangeExtractor);
    callbacks.shift()?.(0);
    await flushPromises();
    expect(virtualOptions.value.value.rangeExtractor).toBe(defaultRangeExtractor);
    callbacks.shift()?.(0);
    await flushPromises();
    expect(virtualOptions.value.value.rangeExtractor).toBe(defaultRangeExtractor);

    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("continues an Enter wait when the viewport itself is left-clicked", async () => {
    const wrapper = mountViewport();
    await wrapper.get("main").trigger("click", { button: 0 });

    expect(continueFromViewport).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("starts continuous Enter-wait skipping when the secondary mouse button is pressed", async () => {
    const wrapper = mountViewport();
    const viewport = wrapper.get("main");
    await viewport.trigger("mousedown", { button: 2 });

    expect(store.skip).toHaveBeenCalledOnce();

    await viewport.trigger("mousedown", { button: 0 });
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    viewport.element.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(store.skip).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("maps a stationary two-finger tap to the secondary action", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;

    dispatchTouch(viewport, "pointerdown", 1, 30, 40);
    vi.advanceTimersByTime(40);
    dispatchTouch(viewport, "pointerdown", 2, 60, 40);
    vi.advanceTimersByTime(40);
    dispatchTouch(viewport, "pointerup", 1, 30, 40);
    dispatchTouch(viewport, "pointerup", 2, 60, 40);

    expect(store.skip).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("maps a stationary single-finger long press to the secondary action", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;

    dispatchTouch(viewport, "pointerdown", 1, 30, 40);
    vi.advanceTimersByTime(600);

    expect(store.skip).toHaveBeenCalledOnce();
    dispatchTouch(viewport, "pointerup", 1, 30, 40);
    wrapper.unmount();
  });

  it("captures touch gestures on the viewport while animated output replaces their target", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    const animatedLine = document.createElement("span");
    const setPointerCapture = vi.fn();
    Object.defineProperty(viewport, "setPointerCapture", { value: setPointerCapture });
    viewport.append(animatedLine);

    dispatchTouch(animatedLine, "pointerdown", 7, 30, 40);
    animatedLine.remove();
    vi.advanceTimersByTime(600);

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(store.skip).toHaveBeenCalledOnce();
    dispatchTouch(viewport, "pointerup", 7, 30, 40);
    wrapper.unmount();
  });

  it("does not capture or continue a single-finger touch that starts on a game button", () => {
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    const button = document.createElement("button");
    const activated = vi.fn();
    const setPointerCapture = vi.fn();
    Object.defineProperty(viewport, "setPointerCapture", { value: setPointerCapture });
    button.addEventListener("click", activated);
    viewport.append(button);

    dispatchTouch(button, "pointerdown", 8, 30, 40);
    dispatchTouch(button, "pointerup", 8, 30, 40);
    button.click();

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(activated).toHaveBeenCalledOnce();
    expect(continueFromViewport).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("cancels touch secondary gestures that move, time out, gain a third touch, or cancel", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;

    dispatchTouch(viewport, "pointerdown", 1, 10, 10);
    dispatchTouch(viewport, "pointermove", 1, 23, 10);
    vi.advanceTimersByTime(600);
    dispatchTouch(viewport, "pointerup", 1, 23, 10);

    dispatchTouch(viewport, "pointerdown", 2, 10, 10);
    dispatchTouch(viewport, "pointerdown", 3, 30, 10);
    vi.advanceTimersByTime(351);
    dispatchTouch(viewport, "pointerup", 2, 10, 10);
    dispatchTouch(viewport, "pointerup", 3, 30, 10);

    dispatchTouch(viewport, "pointerdown", 4, 10, 10);
    dispatchTouch(viewport, "pointerdown", 5, 30, 10);
    dispatchTouch(viewport, "pointerdown", 6, 50, 10);
    dispatchTouch(viewport, "pointerup", 4, 10, 10);
    dispatchTouch(viewport, "pointerup", 5, 30, 10);
    dispatchTouch(viewport, "pointerup", 6, 50, 10);

    dispatchTouch(viewport, "pointerdown", 7, 10, 10);
    dispatchTouch(viewport, "pointercancel", 7, 10, 10);
    vi.advanceTimersByTime(600);

    expect(store.skip).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("suppresses only the click synthesized by a successful touch secondary action", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    const button = document.createElement("button");
    const activated = vi.fn();
    button.addEventListener("click", activated);
    viewport.append(button);

    dispatchTouch(button, "pointerdown", 1, 30, 40);
    vi.advanceTimersByTime(600);
    dispatchTouch(button, "pointerup", 1, 30, 40);
    vi.advanceTimersByTime(700);
    button.click();

    expect(store.skip).toHaveBeenCalledOnce();
    expect(activated).not.toHaveBeenCalled();
    button.click();
    expect(activated).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("lets a new touch sequence clear stale synthetic-click suppression", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;
    const button = document.createElement("button");
    const activated = vi.fn();
    button.addEventListener("click", activated);
    viewport.append(button);

    dispatchTouch(button, "pointerdown", 1, 30, 40);
    vi.advanceTimersByTime(600);
    dispatchTouch(button, "pointerup", 1, 30, 40);
    dispatchTouch(button, "pointerdown", 2, 30, 40);
    dispatchTouch(button, "pointerup", 2, 30, 40);
    button.click();

    expect(store.skip).toHaveBeenCalledOnce();
    expect(activated).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
