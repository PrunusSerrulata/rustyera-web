import {
  describe,
  expect,
  goalStatus,
  it,
  loadScenario,
  resolveLocator,
  runAction,
  vi,
  waitForAutomaticWaitChange,
} from "./webTestLib.testHarness";

describe("web game test scenario", () => {
  it("waits for a timed input to advance without submitting an input", async () => {
    const before = {
      wait: {
        wait_id: "283",
        kind: "string_value",
        deadline_ns: "69532300000",
        viewport_policy: "preserve_user_viewport",
      },
    };
    const after = {
      wait: {
        wait_id: "284",
        kind: "string_value",
        deadline_ns: "72532300000",
        viewport_policy: "preserve_user_viewport",
      },
    };
    const snapshots = [before, after];
    const page = {
      evaluate: vi.fn(async (callback) => {
        if (String(callback).includes("waitForStableObservation")) return undefined;
        return snapshots.shift() ?? after;
      }),
      waitForFunction: vi.fn(async () => undefined),
    };

    await expect(runAction(page, { type: "wait_timed_input_change" })).resolves.toEqual({
      query: {
        timed_input: {
          previous_wait_id: "283",
          next_wait_id: "284",
          previous_kind: "string_value",
          next_kind: "string_value",
          viewport_policy: "preserve_user_viewport",
        },
      },
    });
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), "283");
  });

  it("scrolls a focused production viewport with real keyboard input", async () => {
    const locator = { focus: vi.fn() };
    const page = {
      locator: vi.fn(() => locator),
      keyboard: { press: vi.fn() },
      waitForTimeout: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "scroll_key",
        locator: { css: ".game-viewport" },
        key: "PageUp",
        settle_ms: 80,
      }),
    ).resolves.toEqual({ semanticInput: undefined });

    expect(locator.focus).toHaveBeenCalledOnce();
    expect(page.keyboard.press).toHaveBeenCalledWith("PageUp");
    expect(page.waitForTimeout).toHaveBeenCalledWith(80);
  });

  it("can select the latest match for a repeated screen label", () => {
    const latest = {};
    const matches = { nth: vi.fn(() => latest) };
    const page = { getByText: vi.fn(() => matches) };

    expect(resolveLocator(page, { text: "第1年", exact: false, nth: -1 })).toBe(latest);
    expect(matches.nth).toHaveBeenCalledWith(-1);
  });

  it("requires positioned images to finish decoding", async () => {
    const image = globalThis.document.createElement("img");
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 1200 },
    });
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      isVisible: vi.fn(async () => true),
      evaluate: vi.fn(async (callback) => callback(image)),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: ".media-visual" },
        fields: ["count", "visible", "image_loaded"],
        expect: { count: 1, visible: true, image_loaded: true },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: { count: 1, visible: true, image_loaded: true },
      }),
    );
  });

  it("asserts the live checked state of form controls", async () => {
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      isChecked: vi.fn(async () => true),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: "input[type=checkbox]" },
        fields: ["count", "checked"],
        expect: { count: 1, checked: true },
      }),
    ).resolves.toMatchObject({ query: { count: 1, checked: true } });
  });

  it("reports whether vertical overflow is actually scrollable", async () => {
    const element = globalThis.document.createElement("div");
    element.style.overflowY = "auto";
    Object.defineProperties(element, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 240 },
    });
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      evaluate: vi.fn(async (callback) => callback(element)),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: ".scrollable" },
        fields: ["count", "scrollable_y"],
        expect: { count: 1, scrollable_y: true },
      }),
    ).resolves.toMatchObject({ query: { count: 1, scrollable_y: true } });
  });

  it("asserts reference-relative layout without hard-coding viewport coordinates", async () => {
    const box = (left, top, width, height) => ({
      getBoundingClientRect: () => ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      }),
    });
    const subject = {
      evaluateAll: vi.fn((callback) => callback([box(88, 10, 24, 24), box(88.4, 10.3, 24, 24)])),
    };
    const reference = {
      evaluateAll: vi.fn((callback) => callback([box(0, 40, 200, 20)])),
    };
    const page = {
      locator: vi.fn((selector) => (selector === ".layers" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".layers" },
        relative_to: { css: ".text" },
        expect: {
          count: 2,
          visible: true,
          same_left_within: 1,
          same_top_within: 1,
          above: { min: 5, max: 10 },
          no_overlap: true,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: expect.objectContaining({ layout: expect.objectContaining({ count: 2 }) }),
      }),
    );
  });

  it("asserts bottom alignment against the reference scene image", async () => {
    const box = (top, height) => ({
      getBoundingClientRect: () => ({
        left: 0,
        top,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(40, 60)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 101)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".portrait" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".portrait" },
        relative_to: { css: ".background" },
        expect: { bottom_aligned_within: 1 },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("asserts left alignment against a reference element", async () => {
    const box = (left) => ({
      getBoundingClientRect: () => ({
        left,
        top: 0,
        right: left + 100,
        bottom: 40,
        width: 100,
        height: 40,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(40.5)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(40)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".control" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".control" },
        relative_to: { css: ".label" },
        expect: { left_aligned_within: 1 },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("asserts horizontal centering against a reference box", async () => {
    const box = (left, width) => ({
      getBoundingClientRect: () => ({
        left,
        top: 0,
        right: left + width,
        bottom: 40,
        width,
        height: 40,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(39, 20)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 100)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".title" ? subject : reference)),
    };
    const action = {
      type: "assert_layout",
      locator: { css: ".title" },
      relative_to: { css: ".viewport" },
      expect: { horizontal_centered_within: 1 },
    };

    await expect(runAction(page, action)).resolves.toEqual(
      expect.objectContaining({ query: expect.any(Object) }),
    );

    subject.evaluateAll.mockImplementationOnce((callback) => callback([box(37, 20)]));
    await expect(runAction(page, action)).rejects.toThrow(
      "assertion failed at layout.horizontal_center",
    );
  });

  it("asserts vertical centering against a reference box", async () => {
    const box = (top, height) => ({
      getBoundingClientRect: () => ({
        left: 0,
        top,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(9, 20)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 40)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".control" ? subject : reference)),
    };
    const action = {
      type: "assert_layout",
      locator: { css: ".control" },
      relative_to: { css: ".label" },
      expect: { vertical_centered_within: 1 },
    };

    await expect(runAction(page, action)).resolves.toEqual(
      expect.objectContaining({ query: expect.any(Object) }),
    );

    subject.evaluateAll.mockImplementationOnce((callback) => callback([box(6, 20)]));
    await expect(runAction(page, action)).rejects.toThrow(
      "assertion failed at layout.vertical_center",
    );
  });

  it("can measure a text locator by its logical game-line box", async () => {
    const line = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 40,
        right: 200,
        bottom: 60,
        width: 200,
        height: 20,
      }),
    };
    const text = {
      closest: vi.fn((selector) => (selector === ".game-line" ? line : null)),
      getBoundingClientRect: () => ({
        left: 20,
        top: 36,
        right: 80,
        bottom: 58,
        width: 60,
        height: 22,
      }),
    };
    const subject = {
      evaluateAll: vi.fn((callback, mode) =>
        callback(
          [
            {
              getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                right: 100,
                bottom: 40,
                width: 100,
                height: 40,
              }),
            },
          ],
          mode,
        ),
      ),
    };
    const reference = {
      evaluateAll: vi.fn((callback, mode) => callback([text], mode)),
    };
    const page = {
      locator: vi.fn((selector) => (selector === ".image" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".image" },
        relative_to: { css: ".title" },
        relative_box: "game_line",
        expect: { above: { min: 0, max: 0 }, no_overlap: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("stops explicit Enter advancement when the current output tail reaches a screen", async () => {
    const snapshots = [
      { output: ["opening"], wait: { kind: "enter_key", wait_id: "1" } },
      {
        output: ["old history", "第1年  1月  8日 周一", "亚斯特丽德的工房"],
        wait: { kind: "enter_key", wait_id: "2" },
      },
    ];
    let snapshotIndex = 0;
    const click = vi.fn(() => {
      snapshotIndex += 1;
    });
    const settle = vi.fn((_timeout, summary) => {
      if (!summary) throw new Error("settling must not materialize the full wire ledger");
      return snapshots[snapshotIndex];
    });
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: {
        snapshotSummary: () => snapshots[snapshotIndex],
        snapshot: () => {
          throw new Error("full snapshot is unnecessary for Enter advancement");
        },
        waitForStableObservation: settle,
      },
    });
    const page = {
      evaluate: vi.fn((callback) => callback()),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn((callback, value) => callback(value)),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "第1年  1月  8日", tail_lines: 3 },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(30_000, true);
  });

  it("settles automatic wait changes without requesting a complete ledger", async () => {
    const settle = vi.fn(async (_timeout, summary) => {
      if (!summary) throw new Error("settling must not materialize the full wire ledger");
      return { wait: { wait_id: "2" } };
    });
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: {
        snapshotSummary: () => ({ wait: { wait_id: "2" } }),
        snapshot: () => {
          throw new Error("full snapshot is unnecessary for wait changes");
        },
        waitForStableObservation: settle,
      },
    });
    const page = {
      evaluate: vi.fn((callback) => callback()),
      waitForFunction: vi.fn((callback, value) => expect(callback(value)).toBe(true)),
    };
    await waitForAutomaticWaitChange(page, "1");
    expect(settle).toHaveBeenCalledWith(30_000, true);
  });

  it("continues a variable number of route prompts until a distinct portrait source appears", async () => {
    const snapshots = [
      { fault: null, wait: { kind: "integer_value", wait_id: "1" } },
      { fault: null, wait: { kind: "enter_key", wait_id: "2" } },
      { fault: null, wait: { kind: "integer_value", wait_id: "3" } },
    ];
    let snapshotIndex = 0;
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: {
        snapshot: () => snapshots[snapshotIndex],
        mediaPlacements: () => ({
          images:
            snapshotIndex < 2 ? [{ source: "clock" }] : [{ source: "clock" }, { source: "reimu" }],
        }),
        waitForStableObservation: () => snapshots[snapshotIndex],
      },
    });
    const fill = vi.fn();
    const click = vi.fn(() => {
      snapshotIndex += 1;
    });
    const page = {
      evaluate: vi.fn((callback) => callback()),
      locator: vi.fn((selector) =>
        selector === ".prompt-bar input" ? { fill } : { click, first: () => ({ click }) },
      ),
      waitForFunction: vi.fn((callback, argument) => callback(argument)),
    };

    await expect(
      runAction(page, {
        type: "advance_intermediate_waits_until",
        maximum: 10,
        integer_value: 0,
        until: { media_sources_at_least: 2 },
      }),
    ).resolves.toMatchObject({ attempts: 2, numericInputs: 1, mediaSources: 2 });
    expect(fill).toHaveBeenCalledWith("0");
    expect(click).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("waits past a text-matched fade frame until the screen locator is visible", async () => {
    const snapshots = [
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "1" } },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const target = {
      count: vi.fn(() => (snapshotIndex ? 1 : 0)),
      first: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(true) })),
    };
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn((selector) => (selector === ".target" ? target : { click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: {
          output_tail_contains: "目标场景",
          locator: { css: ".target" },
        },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("lets deadline waits advance without clicking the game input", async () => {
    const snapshots = [
      {
        output: ["淡入中"],
        wait: { kind: "void", wait_id: "1", deadline_ns: "10000000" },
      },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标场景" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).not.toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it("waits for active right-click skipping when automatic Enter submission is disabled", async () => {
    const snapshots = [
      { output: ["过场中"], wait: { kind: "enter_key", wait_id: "1" } },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        auto_enter: false,
        until: { output_tail_contains: "目标场景" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).not.toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it("submits Enter-compatible one-input message waits while advancing dialogue", async () => {
    const snapshots = [
      {
        output: ["打字完成"],
        wait: { kind: "string_value", wait_id: "1", one_input: true },
      },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click, first: () => ({ click }) })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("waits through a transient missing prompt between dialogue waits", async () => {
    const snapshots = [
      { output: ["转场中"], wait: null },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
  });

  it("advances an any-key introduction wait through the visible submit control", async () => {
    const snapshots = [
      { output: ["继续介绍"], wait: { kind: "any_key", wait_id: "1" } },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("web game test scenario", () => {
  it("samples changing DOM content while scroll and layout stay in place", async () => {
    let frame = 0;
    let unstableScroll = false;
    let staticContent = false;
    const viewport = globalThis.document.createElement("div");
    Object.defineProperties(viewport, {
      scrollTop: { get: () => 320 + (unstableScroll ? frame : 0) },
      scrollHeight: { get: () => 900 },
      clientHeight: { get: () => 600 },
    });
    const heading = globalThis.document.createElement("div");
    heading.getBoundingClientRect = () => ({
      left: 20,
      top: 80,
      right: 220,
      bottom: 100,
      width: 200,
      height: 20,
    });
    const locatorFor = (elements) => {
      const locator = {
        count: vi.fn(async () => elements().length),
        first: vi.fn(() => ({
          evaluate: vi.fn(async (callback) => callback(elements()[0])),
        })),
        evaluateAll: vi.fn(async (callback) => callback(elements())),
      };
      return locator;
    };
    const viewportLocator = locatorFor(() => [viewport]);
    const headingLocator = locatorFor(() => [heading]);
    const linesLocator = locatorFor(() =>
      Array.from({ length: 4 }, (_, index) => {
        const line = globalThis.document.createElement("div");
        line.dataset.index = String(index);
        line.style.color = `rgb(${staticContent ? 0 : frame}, 0, 0)`;
        return line;
      }),
    );
    const page = {
      evaluate: vi.fn(async () => ({
        fault: null,
        presentationRevision: frame,
        historyRevision: 4,
        output: ["map"],
      })),
      locator: vi.fn((selector) => {
        if (selector === ".game-viewport") return viewportLocator;
        if (selector === ".map-heading") return headingLocator;
        return linesLocator;
      }),
      waitForTimeout: vi.fn(async () => {
        frame += 1;
      }),
    };
    const action = {
      type: "sample_queries",
      count: 3,
      interval_ms: 10,
      queries: [
        {
          name: "viewport",
          locator: { css: ".game-viewport" },
          fields: ["scroll_top", "scroll_height", "client_height"],
        },
        {
          name: "lines",
          locator: { css: ".game-line" },
          fields: ["count", "content_signature"],
        },
        { name: "map", locator: { css: ".map-heading" }, fields: ["box"] },
      ],
      expect: {
        stable: ["viewport.scroll_top", "viewport.scroll_height", "lines.count", "map.box.top"],
        changes: ["lines.content_signature"],
      },
    };

    const result = await runAction(page, action);
    expect(result.query.samples).toHaveLength(3);
    expect(result.query.samples[0]).toMatchObject({
      runtime: { presentation_revision: 0, history_revision: 4, output_count: 1 },
      viewport: { scroll_top: 320 },
      lines: { count: 4 },
    });
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);

    frame = 0;
    unstableScroll = true;
    await expect(runAction(page, action)).rejects.toThrow(
      "sample_queries.stable.viewport.scroll_top",
    );

    frame = 0;
    unstableScroll = false;
    staticContent = true;
    await expect(runAction(page, action)).rejects.toThrow(
      "sample_queries.changes.lines.content_signature",
    );

    frame = 0;
    await expect(
      runAction(page, {
        ...action,
        expect: { stable: ["map.box.missing"] },
      }),
    ).rejects.toThrow("path map.box.missing is missing from sample 0");
  });

  it("asserts that a generated canvas contains rendered pixels", async () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[3] = 255;
    pixels[11] = 128;
    const canvas = {
      tagName: "CANVAS",
      width: 4,
      height: 4,
      getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    };
    const locator = {
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn(() => ({
        evaluate: vi.fn((callback, count) => {
          const OriginalCanvas = globalThis.HTMLCanvasElement;
          Object.setPrototypeOf(canvas, OriginalCanvas.prototype);
          return callback(canvas, count);
        }),
      })),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_canvas_pixels",
        locator: { css: ".canvas-replay" },
        expect: { count: 1, width: 4, height: 4, nontransparent_at_least: 2 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: { canvas_pixels: { count: 1, width: 4, height: 4, nontransparent: 2 } },
      }),
    );
  });
});

describe("snake service scenarios", () => {
  it("uses a visible pointer click and preserves the whole initialization goal", async () => {
    const services = await loadScenario("tools/runtime-tester/scenarios/snake-services.json");
    expect(services.actions.at(-1)).toMatchObject({
      type: "click",
      semantic_input: "41",
      advances_game: true,
    });
    const combined = await loadScenario("tools/runtime-tester/scenarios/snake-batch1.json");
    expect(
      goalStatus({ output: ["SNAKE_BATCH1_READY"], wait: { kind: "integer_value" } }, combined.goal)
        .satisfied,
    ).toBe(false);
    expect(
      goalStatus(
        { output: [...combined.goal.output_contains], wait: { kind: "integer_value" } },
        combined.goal,
      ).satisfied,
    ).toBe(true);
  });
});
