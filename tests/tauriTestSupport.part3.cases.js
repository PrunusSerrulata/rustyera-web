import {
  Buffer,
  CaptureWriter,
  Encoder,
  assertBlurPointer,
  assertLifecyclePointer,
  assertSampledLifecyclePointer,
  captureTerminal,
  describe,
  expect,
  gunzipSync,
  hashFile,
  hoverLifecycleTarget,
  installPointerObservation,
  inventory,
  it,
  lifecycleViewport,
  mkdir,
  mkdtemp,
  observeRealWindowBlur,
  pageUpLifecycleViewport,
  path,
  readFile,
  rm,
  runServiceOracleCapture,
  selectCaptureCase,
  serviceOracleExportReady,
  serviceOracleReady,
  serviceOracleReadyMarker,
  sha256,
  startTauriSessionMonitor,
  symlink,
  tmpdir,
  vi,
  writeFile,
} from "./tauriTestSupport.testHarness";

describe("snake service lifecycle assertions", () => {
  it("observes resized viewport geometry even when the old cursor left the window", async () => {
    const observation = {
      pointer: null,
      focused: true,
      visible: true,
      viewport: { width: 700, height: 398, scrollTop: 2022 },
    };
    window.__RUSTYERA_POINTER_OBSERVATION__ = () => observation;
    try {
      const browser = { execute: async (read) => read() };
      expect(await lifecycleViewport(browser)).toEqual(observation.viewport);
      observation.focused = false;
      await expect(lifecycleViewport(browser)).rejects.toThrow("visible focused document");
    } finally {
      delete window.__RUSTYERA_POINTER_OBSERVATION__;
    }
  });

  it("defaults to the lifecycle target and freezes independent target geometry", async () => {
    document.body.innerHTML =
      '<main class="game-viewport"><button aria-label="SNAKE_LIFECYCLE_TARGET">target</button></main>';
    const target = document.querySelector("button");
    let top = 20;
    target.getBoundingClientRect = () => ({
      left: 10,
      top,
      right: 50,
      bottom: top + 15,
      width: 40,
      height: 15,
    });
    await installPointerObservation({ execute: async (callback, ...args) => callback(...args) });
    try {
      const before = window.__RUSTYERA_POINTER_OBSERVATION__();
      top = 50;
      const after = window.__RUSTYERA_POINTER_OBSERVATION__();
      expect(before.targetSelector).toBe('button[aria-label="SNAKE_LIFECYCLE_TARGET"]');
      expect(before.target.top).toBe(20);
      expect(after.target.top).toBe(50);
      expect(before.pointer).toBeNull();
      expect(before.targetHovered).toBe(false);
    } finally {
      window.__RUSTYERA_SERVICE_TRACE__.dispose();
      delete window.__RUSTYERA_SERVICE_TRACE__;
    }
  });
  it("records cancellation after dispatch, distinguishes scroll targets, and bounds pending observations", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.body.innerHTML = '<main class="game-viewport"></main>';
    const viewport = document.querySelector("main");
    const listeners = vi.spyOn(window, "addEventListener");
    await installPointerObservation({ execute: async (callback, ...args) => callback(...args) });
    try {
      const keydown = listeners.mock.calls.find(([type]) => type === "keydown")[1];
      const scroll = listeners.mock.calls.find(([type]) => type === "scroll")[1];
      // Unit-only callback input is explicitly untrusted; no DOM/native event is dispatched.
      const event = {
        type: "keydown",
        target: viewport,
        isTrusted: false,
        key: "PageUp",
        code: "PageUp",
        repeat: false,
        defaultPrevented: false,
      };
      keydown(event);
      const beforeDispatch = window.__RUSTYERA_POINTER_OBSERVATION__();
      expect(beforeDispatch.events[0]).toMatchObject({
        targetScope: "viewport",
        trusted: false,
        defaultPrevented: null,
        dispatchComplete: false,
      });
      event.defaultPrevented = true;
      await vi.runOnlyPendingTimersAsync();
      expect(window.__RUSTYERA_POINTER_OBSERVATION__().events[0]).toMatchObject({
        defaultPrevented: true,
        dispatchComplete: true,
      });
      expect(beforeDispatch.events[0].defaultPrevented).toBeNull();
      scroll({ type: "scroll", target: viewport, isTrusted: false });
      scroll({ type: "scroll", target: document, isTrusted: false });
      expect(
        window
          .__RUSTYERA_POINTER_OBSERVATION__()
          .events.slice(-2)
          .map((row) => row.targetScope),
      ).toEqual(["viewport", "document"]);
      for (let index = 0; index < 40; index += 1) keydown(event);
      expect(window.__RUSTYERA_POINTER_OBSERVATION__().events).toHaveLength(32);
      expect(vi.getTimerCount()).toBe(32);
    } finally {
      window.__RUSTYERA_SERVICE_TRACE__.dispose();
      delete window.__RUSTYERA_SERVICE_TRACE__;
      listeners.mockRestore();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "scrolled",
    "scrolled-with-warnings",
    "focus",
    "canceled",
    "retargeted",
    "rebounded",
    "missing-key",
  ])("keeps the PageUp action and distinguishes %s evidence", async (mode) => {
    const scrolled = mode.startsWith("scrolled");
    const notifications = document.createElement("div");
    notifications.className = "corner-notifications";
    if (mode === "scrolled-with-warnings") {
      for (const level of ["warning", "warning", "error"]) {
        const notice = document.createElement("aside");
        notice.className = `log-notification ${level}`;
        const close = document.createElement("button");
        close.addEventListener("click", () => notice.remove());
        notice.append(close);
        notifications.append(notice);
      }
    }
    document.body.append(notifications);
    const before = {
      focused: true,
      visible: true,
      viewportFocused: mode !== "focus",
      sequence: 10,
      viewport: { scrollTop: 200 },
      events: [],
    };
    const key = {
      sequence: 11,
      type: "keydown",
      key: "PageUp",
      trusted: true,
      targetScope: mode === "retargeted" ? "other" : "viewport",
      dispatchComplete: true,
      defaultPrevented: mode === "canceled",
    };
    const after = {
      ...before,
      sequence: 13,
      viewport: { scrollTop: scrolled ? 100 : 200 },
      events: mode === "missing-key" ? [] : [key],
    };
    if (mode === "rebounded")
      after.events.push(
        { sequence: 12, type: "scroll", targetScope: "viewport", scrollTop: 100 },
        { sequence: 13, type: "scroll", targetScope: "viewport", scrollTop: 200 },
      );
    const state = {
      wait: { wait_id: "25" },
      serviceEvidence: { records: [{ index: 0 }], pointerSamples: [] },
    };
    let observation = before;
    window.__RUSTYERA_POINTER_OBSERVATION__ = () => observation;
    window.__RUSTYERA_TEST__ = { snapshot: () => state };
    const click = vi.fn();
    const browser = {
      $: async (selector) => {
        if (selector.includes(".log-notification.warning"))
          return { click: async () => document.querySelector(selector).click() };
        expect(selector).toBe(".game-viewport");
        expect(notifications.querySelectorAll(".warning")).toHaveLength(0);
        return { click };
      },
      execute: async (callback) => callback(),
      keys: vi.fn(async (value) => {
        expect(value).toBe("PageUp");
        observation = after;
      }),
      waitUntil: vi.fn(async (predicate, options) => {
        if (options.timeoutMsg.includes("warning close")) {
          expect(await predicate()).toBe(true);
          return;
        }
        expect(options).toEqual({
          timeout: 3000,
          interval: 100,
          timeoutMsg: "PageUp did not scroll the real viewport",
        });
        if (!(await predicate())) throw new Error(options.timeoutMsg);
      }),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (scrolled) {
        await pageUpLifecycleViewport(browser, "25");
        expect(log).not.toHaveBeenCalled();
        if (mode === "scrolled-with-warnings")
          expect(notifications.querySelector(".error")).not.toBeNull();
      } else {
        await expect(pageUpLifecycleViewport(browser, "25")).rejects.toThrow("PageUp");
        const report = JSON.parse(log.mock.calls[0][0]);
        expect(report.type).toBe("snake-lifecycle-pageup-failure");
        expect(report.evidence.reason).toBe(
          {
            focus: "viewport_not_focused",
            canceled: "pageup_canceled",
            retargeted: "pageup_target_changed",
            rebounded: "viewport_scrolled_then_rebounded",
            "missing-key": "trusted_pageup_not_in_retained_events",
          }[mode],
        );
        expect(report.evidence.failure.state).toEqual(state);
        expect(report.evidence.failure.observation).toEqual(observation);
      }
      expect(click).toHaveBeenCalledOnce();
      expect(browser.keys).toHaveBeenCalledTimes(mode === "focus" ? 0 : 1);
    } finally {
      notifications.remove();
      delete window.__RUSTYERA_POINTER_OBSERVATION__;
      log.mockRestore();
    }
  });
  function focusBrowser(created = { handle: "native-probe", type: "window" }, blurCount = 1) {
    const actions = [];
    const browser = {
      getWindowHandle: async () => "main",
      url: async (url) => {
        expect(decodeURIComponent(url)).toContain('id="native-focus-target"');
        actions.push(["navigate-probe"]);
      },
      $: async (selector) => {
        expect(selector).toBe("#native-focus-target");
        return { click: async () => actions.push(["click-probe"]) };
      },
      createWindow: async (type) => {
        if (type !== "window") throw new TypeError("WebDriver createWindow expects a string type");
        return created;
      },
      // No legacy newWindow/getWindowHandles fallback: its last handle is not authoritative.
      switchToWindow: async (handle) => actions.push(["switch", handle]),
      closeWindow: async () => actions.push(["close"]),
      execute: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ count: blurCount, focused: true }),
      async waitUntil(accept, { timeoutMsg }) {
        if (!(await accept())) throw new Error(timeoutMsg);
      },
    };
    return { browser, actions };
  }
  it("uses the native creation handle and verifies focus transfer before restoring the game", async () => {
    const { browser, actions } = focusBrowser();
    await observeRealWindowBlur(browser);
    expect(actions).toEqual([
      ["switch", "native-probe"],
      ["navigate-probe"],
      ["click-probe"],
      ["switch", "native-probe"],
      ["close"],
      ["switch", "main"],
    ]);
  });
  it("rejects a tab substitute while closing only the newly created target", async () => {
    const { browser, actions } = focusBrowser({ handle: "native-tab", type: "tab" });
    await expect(observeRealWindowBlur(browser)).rejects.toThrow("independent native focus window");
    expect(actions).toEqual([["switch", "native-tab"], ["close"], ["switch", "main"]]);
  });
  it("uses the explicit native focus window without navigating an auxiliary data document", async () => {
    const { browser, actions } = focusBrowser();
    await observeRealWindowBlur(browser, { nativeFocusWindow: true });
    expect(actions).toEqual([
      ["switch", "native-probe"],
      ["switch", "native-probe"],
      ["close"],
      ["switch", "main"],
    ]);
    const noBlur = focusBrowser(undefined, 0);
    await expect(
      observeRealWindowBlur(noBlur.browser, { nativeFocusWindow: true }),
    ).rejects.toThrow("trusted blur");
  });
  it("does not accept a focused game without a trusted blur observation", async () => {
    const { browser, actions } = focusBrowser(undefined, 0);
    await expect(observeRealWindowBlur(browser)).rejects.toThrow("trusted blur");
    expect(actions.slice(-3)).toEqual([["switch", "native-probe"], ["close"], ["switch", "main"]]);
  });
  it("reveals the target and establishes a distinct pointer before hovering", async () => {
    const actions = [];
    const target = {
      async scrollIntoView() {
        actions.push("scroll");
      },
      async moveTo() {
        actions.push("hover");
      },
    };
    await hoverLifecycleTarget({
      $: async () => target,
      execute: async () => ({ x: 20, y: 30 }),
      performActions: async (events) => {
        expect(events[0].actions[0]).toMatchObject({ type: "pointerMove", x: 20, y: 30 });
        actions.push("move-inside");
      },
    });
    expect(actions).toEqual(["scroll", "move-inside", "hover"]);
  });
  it("requires zero after a real blur without a later pointer event", () => {
    const observation = { blurCount: 1, events: [{ type: "blur", trusted: true }] };
    const state = (value) => ({ output: [`SNAKE_LIFECYCLE_POINTER_5=${value}`] });
    expect(assertBlurPointer(state("0/0/"), observation, null).mode).toBe("cleared-after-blur");
    expect(() => assertBlurPointer(state("20/-170/41"), observation, null)).toThrow(
      "did not clear",
    );
    observation.events.push({
      type: "pointerout",
      trusted: true,
      focused: true,
      relatedTargetPresent: true,
      x: 30,
      y: 50,
    });
    expect(assertBlurPointer(state("0/0/"), observation, null).mode).toBe("cleared-after-blur");
    expect(() => assertBlurPointer(state("0/0/"), { events: [] }, null)).toThrow("trusted blur");
  });
  it("compares a native post-blur move against its pre-query geometry, not an old position", () => {
    const observation = {
      blurCount: 2,
      events: [
        { type: "pointermove", trusted: true, focused: true, x: 1, y: 2 },
        { type: "blur", trusted: true },
        { type: "pointermove", trusted: true, focused: true, x: 30, y: 50 },
      ],
    };
    const geometry = {
      viewport: { left: 10, top: 20, clientLeft: 0, clientTop: 0, height: 200 },
      targetHovered: true,
    };
    const state = (value) => ({ output: [`SNAKE_LIFECYCLE_POINTER_5=${value}`] });
    expect(assertBlurPointer(state("20/-170/41"), observation, geometry).mode).toBe(
      "fresh-pointer-after-blur",
    );
    expect(() => assertBlurPointer(state("0/0/"), observation, geometry)).toThrow("pointer 5");
    observation.events.push({ type: "pointercancel", trusted: true });
    expect(assertBlurPointer(state("0/0/"), observation, null).mode).toBe("cleared-after-blur");
    observation.events.pop();
    observation.events.at(-1).trusted = false;
    expect(() => assertBlurPointer(state("20/-170/41"), observation, geometry)).toThrow(
      "trusted event",
    );
  });
  function sampledPointerState() {
    const encoder = new Encoder({ useRecords: false });
    const payload = (values) => [
      ...encoder.encode(new Map(values.map((value, index) => [index, value]))),
    ];
    const records = [],
      pointerSamples = [];
    for (let index = 0; index < 3; index += 1) {
      const focused = index !== 1;
      const coordinates = focused ? [20 + index, -170 + index, "41"] : [0, 0, ""];
      records.push({
        index: index * 2,
        epoch: "2",
        sessionGeneration: 4,
        direction: "receive",
        message: {
          type: "service_request",
          value: {
            request_id: String(index + 10),
            kind: "input_state",
            operation: "pointer_state",
            operation_version: { major: 1, minor: 0 },
            payload: payload([3, 5, 7]),
          },
        },
      });
      pointerSamples.push({
        index,
        requestId: String(index + 10),
        epoch: "2",
        sessionGeneration: 4,
        wireIndex: index * 2 + 1,
        context: { presentationRevision: 3, environmentRevision: 5, projectionSpaceRevision: 7 },
        observation: {
          focused,
          visible: true,
          sequence: index + 1,
          blurCount: 1,
          targetHovered: true,
          pointer: focused
            ? {
                x: 30 + index,
                y: 50 + index,
                trusted: true,
                focused: true,
                visible: true,
                sequence: index + 1,
              }
            : null,
          viewport: { left: 10, top: 20, clientLeft: 0, clientTop: 0, width: 300, height: 200 },
        },
      });
      records.push({
        index: index * 2 + 1,
        epoch: "2",
        sessionGeneration: 4,
        direction: "send",
        message: {
          type: "service_response",
          value: {
            request_id: String(index + 10),
            result: { type: "ready", payload: payload([...coordinates, 3, 5, 7]) },
          },
        },
      });
    }
    return {
      runtimeEpoch: "2",
      output: ["SNAKE_LIFECYCLE_POINTER_5=20/0/41"],
      serviceEvidence: {
        enabled: true,
        overflow: false,
        failure: null,
        sessionGeneration: 4,
        records,
        pointerSamples,
      },
    };
  }
  it("binds X, Y and button separately to frozen query-time DOM observations", () => {
    const state = sampledPointerState();
    expect(
      assertSampledLifecyclePointer(state, 5, { wireIndex: 0, sampleIndex: 0 }).expected,
    ).toEqual({ x: 20, y: 0, buttonValue: "41" });
    state.output = ["SNAKE_LIFECYCLE_POINTER_5=20/-170/41"];
    expect(() => assertSampledLifecyclePointer(state, 5, { wireIndex: 0, sampleIndex: 0 })).toThrow(
      "pointer 5",
    );
  });
  it("decodes captured Chromium decimal request bytes alongside numeric reply bytes", () => {
    const state = sampledPointerState();
    state.output = ["SNAKE_LIFECYCLE_POINTER_0=118/-28/41"];
    // The actual bridge request is BigInt-backed before RuntimeEvidence's JSON conversion.
    for (const record of state.serviceEvidence.records) {
      if (record.direction === "receive")
        record.message.value.payload = ["163", "0", "25", "1", "11", "1", "4", "2", "4"];
      else
        record.message.value.result.payload = [
          166, 0, 24, 118, 1, 56, 27, 2, 98, 52, 49, 3, 25, 1, 11, 4, 4, 5, 4,
        ];
    }
    for (const sample of state.serviceEvidence.pointerSamples) {
      sample.context = {
        presentationRevision: 267,
        environmentRevision: 4,
        projectionSpaceRevision: 4,
      };
      sample.observation.focused = true;
      sample.observation.pointer = {
        x: 118.76000213623047,
        y: 818.5900268554688,
        trusted: true,
        focused: true,
        visible: true,
        sequence: sample.observation.sequence,
      };
      sample.observation.viewport = {
        left: 0,
        top: 39.09375,
        clientLeft: 0,
        clientTop: 0,
        width: 1280,
        height: 808,
      };
    }
    expect(
      assertSampledLifecyclePointer(state, 0, { wireIndex: 0, sampleIndex: 0 }).expected,
    ).toEqual({ x: 118, y: -28, buttonValue: "41" });
  });
  it.each([
    true,
    false,
    null,
    undefined,
    -1,
    256,
    0.5,
    NaN,
    "",
    " 0",
    "0 ",
    "00",
    "+0",
    "-0",
    "-1",
    "256",
    "1.0",
    "1e2",
    "0xff",
    "1n",
  ])("rejects invalid pointer evidence byte %s without coercion", (value) => {
    for (const direction of ["receive", "send"]) {
      const state = sampledPointerState();
      const record = state.serviceEvidence.records.find((entry) => entry.direction === direction);
      const payload =
        direction === "receive"
          ? record.message.value.payload
          : record.message.value.result.payload;
      payload[0] = value;
      expect(() =>
        assertSampledLifecyclePointer(state, 5, { wireIndex: 0, sampleIndex: 0 }),
      ).toThrow("invalid CBOR bytes");
    }
  });
  it.each(["sessionGeneration", "requestId", "revision", "order", "duplicate", "untrusted"])(
    "rejects %s drift in query-time evidence",
    (kind) => {
      const state = sampledPointerState();
      const samples = state.serviceEvidence.pointerSamples;
      if (kind === "sessionGeneration") samples[0].sessionGeneration += 1;
      if (kind === "requestId") samples[0].requestId = "99";
      if (kind === "revision") samples[0].context.environmentRevision += 1;
      if (kind === "order") samples[0].wireIndex = 0;
      if (kind === "duplicate") samples.push(structuredClone(samples[0]));
      if (kind === "untrusted") samples[0].observation.pointer.trusted = false;
      expect(() =>
        assertSampledLifecyclePointer(state, 5, { wireIndex: 0, sampleIndex: 0 }),
      ).toThrow();
    },
  );
  const geometry = {
    pointer: { x: 30, y: 50 },
    viewport: { left: 10, top: 20, clientLeft: 0, clientTop: 0, width: 300, height: 200 },
  };
  const state = (text) => ({ fault: null, output: [`SNAKE_LIFECYCLE_POINTER_0=${text}`] });
  it("checks negative bottom-origin coordinates and the script value independently of DOM labels", () => {
    expect(assertLifecyclePointer(state("20/-170/41"), 0, geometry, "41").actual).toEqual({
      x: 20,
      y: -170,
      buttonValue: "41",
    });
    expect(() => assertLifecyclePointer(state("20/30/41"), 0, geometry, "41")).toThrow("pointer 0");
    expect(() =>
      assertLifecyclePointer(state("20/-170/SNAKE_LIFECYCLE_TARGET"), 0, geometry, "41"),
    ).toThrow("pointer 0");
    expect(() => assertLifecyclePointer(state("20/-170/1"), 0, geometry, "41")).toThrow(
      "pointer 0",
    );
  });
  it("requires empty no-hover values and rejects old geometry, duplicate markers and faults", () => {
    expect(assertLifecyclePointer(state("20/-170/"), 0, geometry, "").actual.buttonValue).toBe("");
    expect(() => assertLifecyclePointer(state("20/-170/41"), 0, geometry, "")).toThrow("pointer 0");
    expect(() =>
      assertLifecyclePointer(
        state("20/-170/"),
        0,
        { ...geometry, viewport: { ...geometry.viewport, height: 250 } },
        "",
      ),
    ).toThrow("pointer 0");
    expect(() =>
      assertLifecyclePointer(
        {
          fault: null,
          output: ["SNAKE_LIFECYCLE_POINTER_0=20/-170/", "SNAKE_LIFECYCLE_POINTER_0=20/-170/"],
        },
        0,
        geometry,
        "",
      ),
    ).toThrow("exactly one");
    expect(() =>
      assertLifecyclePointer(
        { ...state("20/-170/"), fault: { message: "stale" } },
        0,
        geometry,
        "",
      ),
    ).toThrow("runtime fault");
  });
});

describe("real service capture producer boundaries", () => {
  function startupConfiguration(hazard = false) {
    const ordinary = {
      id: "s04-empty-lazy",
      group: "SERVICES",
      requests: [{ request: { op: "run", entry: "S04_CASE_EMPTY", watch: ["RESULT:10"] } }],
    };
    const noProgress = {
      id: "s04-lines-no-progress",
      group: "SERVICES_HAZARD",
      requests: [{ request: { op: "run", entry: "S04_CASE_NO_PROGRESS", watch: ["RESULT:10"] } }],
    };
    const fixtureManifest = {
      cases: hazard
        ? [noProgress]
        : [
            {
              id: "s04-other",
              group: "SERVICES",
              requests: [{ request: { op: "run", entry: "S04_CASE_OTHER", watch: [] } }],
            },
            ordinary,
          ],
    };
    return {
      family: "chromium",
      fixtureManifest,
      ...selectCaptureCase(fixtureManifest, hazard ? noProgress.id : ordinary.id),
    };
  }

  it.each([false, true])("accepts only the exact fixture ready marker (hazard=%s)", (hazard) => {
    const config = startupConfiguration(hazard);
    const expected = hazard ? "S04_NO_PROGRESS_READY" : "S04_ORACLE_READY";
    const other = hazard ? "S04_ORACLE_READY" : "S04_NO_PROGRESS_READY";
    const marker = serviceOracleReadyMarker(config);
    const ready = { canInteract: true, wait: { kind: "integer_value" }, output: [expected] };
    expect(marker).toBe(expected);
    expect(config.menu).toBe(hazard ? "1" : "2");
    expect(serviceOracleReady(ready, marker)).toBe(true);
    expect(serviceOracleReady({ ...ready, output: [expected + " suffix"] }, marker)).toBe(false);
    expect(serviceOracleReady({ ...ready, output: [" " + expected] }, marker)).toBe(false);
    expect(serviceOracleReady({ ...ready, output: [expected.toLowerCase()] }, marker)).toBe(false);
    expect(serviceOracleReady({ ...ready, canInteract: false }, marker)).toBe(false);
    expect(serviceOracleReady({ ...ready, wait: { kind: "string_value" } }, marker)).toBe(false);
    expect(() => serviceOracleReady({ ...ready, output: [other] }, marker)).toThrow(
      "unexpected service oracle ready marker",
    );
    expect(() => serviceOracleReady({ ...ready, output: [expected, other] }, marker)).toThrow(
      "unexpected service oracle ready marker",
    );
    expect(() => serviceOracleReady({ ...ready, output: [expected, expected] }, marker)).toThrow(
      "ambiguous service oracle ready marker",
    );
    expect(() =>
      serviceOracleReady({ ...ready, fault: { message: "startup failed" } }, marker),
    ).toThrow("fixture startup fault");
    expect(() => serviceOracleReady({ ...ready, phase: "faulted" }, marker)).toThrow(
      "fixture startup fault",
    );
  });

  it("keeps the no-progress hazard isolated with its exact case, group and run entry", () => {
    const mixed = startupConfiguration(true);
    mixed.fixtureManifest.cases.push(startupConfiguration().selected);
    expect(() => serviceOracleReadyMarker(mixed)).toThrow("independent single-case hazard fixture");
    const wrongEntry = startupConfiguration(true);
    wrongEntry.selected.requests[0].request.entry = "S04_CASE_EMPTY";
    wrongEntry.request.entry = "S04_CASE_EMPTY";
    expect(() => serviceOracleReadyMarker(wrongEntry)).toThrow(
      "independent single-case hazard fixture",
    );
    const wrongGroup = startupConfiguration(true);
    wrongGroup.selected.group = "SERVICES";
    expect(() => serviceOracleReadyMarker(wrongGroup)).toThrow(
      "independent single-case hazard fixture",
    );
    const ordinary = startupConfiguration();
    ordinary.fixtureManifest.cases.push(startupConfiguration(true).selected);
    expect(() => serviceOracleReadyMarker(ordinary)).toThrow(
      "normal service capture cannot include the no-progress hazard",
    );
    const renamed = startupConfiguration(true);
    renamed.selected.id = "s04-lines-no-progress-copy";
    renamed.selected.group = "SERVICES";
    expect(() => serviceOracleReadyMarker(renamed)).toThrow(
      "normal service capture cannot include the no-progress hazard",
    );
  });

  it("refuses changed selected IDs, menu numbers or requests before startup observation", () => {
    const changedId = startupConfiguration();
    changedId.selected = { ...changedId.selected, id: "S04-EMPTY-LAZY" };
    expect(() => serviceOracleReadyMarker(changedId)).toThrow("exact case");
    const changedMenu = startupConfiguration(true);
    changedMenu.menu = "2";
    expect(() => serviceOracleReadyMarker(changedMenu)).toThrow("menu/request differs");
    const changedRequest = startupConfiguration(true);
    changedRequest.request.watch = [];
    expect(() => serviceOracleReadyMarker(changedRequest)).toThrow("menu/request differs");
    expect(() => serviceOracleReady({}, "S04_ANY_READY")).toThrow(
      "unknown exact service oracle ready marker",
    );
  });

  it.each([false, true])(
    "rejects the other fixture's marker before menu input or capture writes (hazard=%s)",
    async (hazard) => {
      const config = startupConfiguration(hazard);
      const client = {
        execute: vi.fn(async () => ({
          canInteract: true,
          wait: { kind: "integer_value" },
          output: [hazard ? "S04_ORACLE_READY" : "S04_NO_PROGRESS_READY"],
        })),
        submit: vi.fn(),
      };
      await expect(runServiceOracleCapture(client, config, {})).rejects.toThrow(
        "unexpected service oracle ready marker",
      );
      expect(client.execute).toHaveBeenCalledTimes(1);
      expect(client.submit).not.toHaveBeenCalled();
    },
  );

  it("maps only exact fixture IDs to their original visible menu numbers without expectations", () => {
    const fixture = {
      cases: [
        {
          id: "first",
          requests: [{ request: { op: "run", entry: "FIRST", watch: [] }, expect: { forged: 42 } }],
        },
        {
          id: "second",
          requests: [
            {
              request: { op: "run", entry: "SECOND", watch: ["RESULT:10"] },
              expect: { forged: 99 },
            },
          ],
        },
      ],
    };
    expect(selectCaptureCase(fixture, "second")).toMatchObject({
      menu: "2",
      request: { op: "run", entry: "SECOND", watch: ["RESULT:10"] },
    });
    expect(selectCaptureCase(fixture, "second").request).not.toHaveProperty("expect");
    expect(() => selectCaptureCase(fixture, "SECOND")).toThrow("exact case");
    expect(() =>
      selectCaptureCase({ cases: [fixture.cases[0], fixture.cases[0]] }, "first"),
    ).toThrow("duplicate");
  });

  it("stops a finished diagnosis without committed identity instead of waiting for the watchdog", () => {
    expect(serviceOracleExportReady({ diagnosis: { exporting: true, result: "" } })).toBe(false);
    expect(serviceOracleExportReady({ lastDownload: { projectIdentityFiles: [] } })).toBe(true);
    expect(() =>
      serviceOracleExportReady({ diagnosis: { exporting: false, result: "detached buffer" } }),
    ).toThrow("project identity export ended without committed evidence: detached buffer");
  });

  it("never turns missing completion or an actual fault into a completed entry", () => {
    expect(
      captureTerminal({ canInteract: true, wait: {}, output: ["S04_ENTRY_BEGIN"] }),
    ).toBeNull();
    expect(captureTerminal({ canInteract: true, wait: {}, output: ["S04_CASE_COMPLETE"] })).toBe(
      "completed",
    );
    expect(captureTerminal({ fault: { message: "bad HTML" }, output: ["S04_ENTRY_BEGIN"] })).toBe(
      "fault",
    );
  });

  it("writes ordered gzip packets and independent stored/decoded hashes without expanded trace copies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-service-capture-"));
    try {
      const writer = new CaptureWriter(directory);
      await Promise.all([
        writer.record({ type: "header", identity: { actual: true } }),
        writer.record({ type: "footer", captureComplete: true }),
      ]);
      const trace = await writer.close();
      const stored = await readFile(path.join(directory, trace.path));
      const decoded = gunzipSync(stored);
      expect(trace).toMatchObject({
        storedBytes: stored.length,
        storedSha256: sha256(stored),
        decodedBytes: decoded.length,
        decodedSha256: sha256(decoded),
      });
      expect(
        decoded
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).index),
      ).toEqual([0, 1]);
      expect(await hashFile(path.join(directory, trace.path))).toEqual({
        bytes: stored.length,
        sha256: sha256(stored),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hashes Vite source inputs and keeps raw versus UTF8 BOM payload identity distinct", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-service-inventory-"));
    try {
      await mkdir(path.join(directory, "src"));
      await mkdir(path.join(directory, "scripts"));
      await mkdir(path.join(directory, "dist"));
      await writeFile(path.join(directory, "src/input.ts"), Buffer.from([0xef, 0xbb, 0xbf, 0x41]));
      await writeFile(path.join(directory, "scripts/runner.mjs"), "real runner");
      await writeFile(path.join(directory, "package-lock.json"), "{}");
      await writeFile(path.join(directory, "dist/unrelated.js"), "not running in Vite dev");
      const source = await inventory(directory, { sourceManifest: true, decoded: true });
      expect(source.map((item) => item.path)).toEqual([
        "package-lock.json",
        "scripts/runner.mjs",
        "src/input.ts",
      ]);
      expect(source.at(-1).decodedUtf8Sha256).toBe(sha256("A"));
      expect(source.at(-1).sha256).not.toBe(source.at(-1).decodedUtf8Sha256);
      await symlink(path.join(directory, "src/input.ts"), path.join(directory, "src/alias.ts"));
      await expect(inventory(directory, { sourceManifest: true })).rejects.toThrow("symlink");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records an explicitly permitted expected fault but still rejects identical full snapshots", async () => {
    const state = {
      document: [{ tag: "main", text: "fault" }],
      runtime: { fault: { message: "expected malformed HTML" } },
    };
    const onSnapshot = vi.fn(async () => undefined);
    const monitor = startTauriSessionMonitor(
      { execute: vi.fn(async () => structuredClone(state)) },
      { interval: 1, allowFault: () => true, onSnapshot, output: vi.fn() },
    );
    await expect(monitor.failure).rejects.toThrow("identical");
    await expect(monitor.stop()).rejects.toThrow("identical");
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });
});
