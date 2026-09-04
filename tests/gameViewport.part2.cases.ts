import {
  afterEach,
  beforeEach,
  continueFromViewport,
  describe,
  dispatchTouch,
  expect,
  it,
  mountViewport,
  naturalMeasureElement,
  nextTick,
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

  it("does not map touch gestures when mouse interactions are disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store.useMouse = false;
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main").element;

    dispatchTouch(viewport, "pointerdown", 1, 30, 40);
    vi.advanceTimersByTime(600);
    dispatchTouch(viewport, "pointerup", 1, 30, 40);
    dispatchTouch(viewport, "pointerdown", 2, 30, 40);
    dispatchTouch(viewport, "pointerdown", 3, 60, 40);
    dispatchTouch(viewport, "pointerup", 2, 30, 40);
    dispatchTouch(viewport, "pointerup", 3, 60, 40);

    expect(store.skip).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("applies UseMouse and ScrollHeight to viewport pointer scrolling", async () => {
    const wrapper = mountViewport();
    const viewport = wrapper.get<HTMLElement>("main");
    store.scrollHeight = 3;

    await viewport.trigger("wheel", { deltaY: 1 });
    expect(viewport.element.scrollTop).toBe(39);

    store.useMouse = false;
    await viewport.trigger("click", { button: 0 });
    await viewport.trigger("mousedown", { button: 2 });
    await viewport.trigger("wheel", { deltaY: 1 });
    expect(continueFromViewport).not.toHaveBeenCalled();
    expect(store.skip).not.toHaveBeenCalled();
    expect(viewport.element.scrollTop).toBe(39);
    expect(viewport.classes()).toContain("mouse-disabled");
    wrapper.unmount();
  });

  it("keeps row keys stable across refresh snapshots to retain measured positions", async () => {
    const wrapper = mountViewport();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [], text_background_eligible: false },
    ];
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    store.runtimeEpoch = 2;
    await nextTick();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("2:1");
    wrapper.unmount();
  });

  it("does not scan accumulated line IDs for an ordinary presentation revision", async () => {
    let lineIdReads = 0;
    store.presentation.lines = Array.from({ length: 5_000 }, (_, index) => ({
      get line_id() {
        lineIdReads += 1;
        return index;
      },
      alignment: "left",
      runs: [],
      text_background_eligible: false,
    }));
    const wrapper = mountViewport();
    lineIdReads = 0;

    store.presentation.revision += 1;
    await nextTick();

    expect(lineIdReads).toBe(0);
    wrapper.unmount();
  });

  it("does not revisit media payloads after a line ID key is cached", () => {
    let runReads = 0;
    store.presentation.lines = [
      {
        line_id: 1,
        alignment: "left",
        get runs() {
          runReads += 1;
          return [];
        },
        text_background_eligible: false,
      },
    ];
    const wrapper = mountViewport();

    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    runReads = 0;
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    expect(runReads).toBe(0);
    wrapper.unmount();
  });

  it("reuses a replaced animation row key so mounted media can retain its prior frame", async () => {
    const image = (resourceId: string) => ({
      type: "image",
      placement: {
        resource_id: resourceId,
        requested_width: { unit: "pixels", value: 100 },
        requested_height: { unit: "pixels", value: 80 },
        requested_y: { unit: "pixels", value: -80 },
        width: 100_000n,
        height: 80_000n,
      },
    });
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [], text_background_eligible: false },
      {
        line_id: 2,
        alignment: "left",
        runs: [image("frame-1")],
        text_background_eligible: false,
      },
    ];
    const wrapper = mountViewport();
    expect(virtualOptions.value.value.getItemKey(1)).toBe("1:2");

    store.presentation.lines = [
      store.presentation.lines[0],
      {
        line_id: 3,
        alignment: "left",
        runs: [image("frame-2")],
        text_background_eligible: false,
      },
    ];
    await nextTick();

    expect(virtualOptions.value.value.getItemKey(1)).toBe("1:2");
    wrapper.unmount();
  });

  it("does not invalidate measured media rows when unrelated history is appended", async () => {
    const media = {
      type: "image",
      placement: {
        resource_id: "portrait",
        requested_height: { unit: "pixels", value: 80 },
        requested_y: { unit: "pixels", value: -80 },
        width: 100_000n,
        height: 80_000n,
      },
    };
    store.presentation.lines = [
      { line_id: 1, alignment: "left", runs: [media], text_background_eligible: false },
    ];
    const wrapper = mountViewport();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");

    store.presentation.lines.push({
      line_id: 2,
      alignment: "left",
      runs: [],
      text_background_eligible: false,
    });
    store.presentation.historyRevision += 1;
    await nextTick();
    store.presentation.lines[0] = {
      line_id: 3,
      alignment: "left",
      runs: [media],
      text_background_eligible: false,
    };
    await nextTick();

    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");
    wrapper.unmount();
  });

  it("rekeys rebuilt history rows so fixed screens discard stale dialogue measurements", async () => {
    const wrapper = mountViewport();
    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:1");

    store.presentation.lines = [
      { line_id: 2, alignment: "left", runs: [], text_background_eligible: false },
    ];
    store.presentation.historyRevision += 1;
    await nextTick();

    expect(virtualOptions.value.value.getItemKey(0)).toBe("1:2");
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
      const wrapper = mountViewport();
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
        text_background_eligible: false,
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

    const wrapper = mountViewport();
    await nextTick();
    expect(wrapper.get<HTMLElement>(".game-line").attributes("style")).toContain(
      "min-height: 36px",
    );
    wrapper.unmount();
  });

  it("projects zero-space image layers to one visual origin without removing history rows", async () => {
    const zeroSpace = (lineId: number) => ({
      line_id: lineId,
      alignment: "left",
      text_background_eligible: false,
      runs: [
        {
          type: "html_document",
          document: {
            nodes: [
              {
                type: "element",
                kind: "shape",
                attributes: [],
                semantic: {
                  type: "shape",
                  kind: "space",
                  parameters: [{ unit: "font_height_hundredths", value: 0 }],
                },
                children: [],
              },
            ],
          },
        },
      ],
    });
    const image = (lineId: number, source: string, y: number) => ({
      line_id: lineId,
      alignment: "left",
      text_background_eligible: false,
      runs: [
        {
          type: "html_document",
          document: {
            nodes: [
              {
                type: "element",
                kind: "paragraph",
                attributes: [],
                semantic: { type: "paragraph", alignment: "left" },
                children: [
                  {
                    type: "element",
                    kind: "image",
                    attributes: [],
                    semantic: {
                      type: "image",
                      source,
                      display: "relative",
                      y: { unit: "font_height_hundredths", value: y },
                    },
                    children: [],
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    store.gameLineHeightPx = 17;
    store.presentation.lines = [
      zeroSpace(510),
      image(511, "30_BODY_WEAR", 0),
      zeroSpace(512),
      image(513, "30_PANTS_WEAR_TYPE6_NORMAL", -100),
      zeroSpace(514),
      image(515, "30_SHADOW_LIFT", -200),
    ] as any;
    virtualState.items = store.presentation.lines.map((line, index) => ({
      index,
      key: String(line.line_id),
      start: index * 17,
    }));
    virtualState.totalSize = 102;

    const wrapper = mountViewport();
    await nextTick();
    const rows = wrapper.findAll<HTMLElement>(".virtual-history > .game-line");
    expect(rows).toHaveLength(6);
    expect(rows[1].classes()).toContain("html-image-layer-line");
    expect(rows[1].element.style.getPropertyValue("--game-media-line-offset")).toBe("-17px");
    expect(rows[3].element.style.getPropertyValue("--game-media-line-offset")).toBe("-34px");
    expect(rows[5].element.style.getPropertyValue("--game-media-line-offset")).toBe("-51px");
    expect(rows[0].element.style.getPropertyValue("--game-media-line-offset")).toBe("");
    wrapper.unmount();
  });

  it("uses the configured height without a synchronous DOM read for fixed console rows", () => {
    const wrapper = mountViewport();
    const element = document.createElement("div");
    const instance = {
      indexFromElement: () => 0,
      itemSizeCache: new Map(),
      options: { getItemKey: () => "line-1", estimateSize: () => 13 },
    } as any;

    expect(virtualOptions.value.value.measureElement(element, undefined, instance)).toBe(13);
    expect(naturalMeasureElement).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("accepts ResizeObserver corrections for fixed console rows", () => {
    naturalMeasureElement.mockReturnValue(14);
    const wrapper = mountViewport();
    const element = document.createElement("div");
    const entry = {} as ResizeObserverEntry;
    const instance = { indexFromElement: () => 0 } as any;

    expect(virtualOptions.value.value.measureElement(element, entry, instance)).toBe(14);
    expect(naturalMeasureElement).toHaveBeenCalledWith(element, entry, instance);
    wrapper.unmount();
  });

  it("preserves an observed fixed-row size when its element ref runs again", () => {
    naturalMeasureElement.mockReturnValue(14);
    const wrapper = mountViewport();
    const element = document.createElement("div");
    const instance = {
      indexFromElement: () => 0,
      itemSizeCache: new Map([["line-1", 14]]),
      options: { getItemKey: () => "line-1", estimateSize: () => 13 },
    } as any;

    expect(virtualOptions.value.value.measureElement(element, undefined, instance)).toBe(14);
    expect(naturalMeasureElement).toHaveBeenCalledWith(element, undefined, instance);
    wrapper.unmount();
  });

  it("leaves complex rows on their natural DOM measurement path", () => {
    store.presentation.lines = [
      {
        line_id: 1,
        alignment: "left",
        text_background_eligible: false,
        runs: [{ type: "html_document", document: { nodes: [] } }],
      },
    ];
    naturalMeasureElement.mockReturnValue(42);
    const wrapper = mountViewport();
    const element = document.createElement("div");
    const instance = {
      indexFromElement: () => 0,
      itemSizeCache: new Map(),
      options: { getItemKey: () => "line-1", estimateSize: () => 13 },
    } as any;

    expect(virtualOptions.value.value.measureElement(element, undefined, instance)).toBe(42);
    expect(naturalMeasureElement).toHaveBeenCalledWith(element, undefined, instance);
    wrapper.unmount();
  });
});
