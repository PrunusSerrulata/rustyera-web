import {
  SNAKE_SERVICE_MARKERS,
  assertSnakeServiceState,
  assertSnapshotProgress,
  captureCompleteTauriSnapshot,
  describe,
  expandCompleteTauriSnapshot,
  expect,
  focusCurrentTauriWindow,
  it,
  path,
  resolveTauriBinary,
  snapshotCaptureTimeout,
  snapshotProgressSignature,
  startTauriSessionMonitor,
  vi,
} from "./tauriTestSupport.testHarness";

describe("Tauri end-to-end test support", () => {
  function foregroundBrowser(events, switchFailure) {
    return {
      getWindowHandle: vi.fn(async () => {
        events.push("get-window");
        return "current-native-window";
      }),
      switchToWindow: vi.fn(async (handle) => {
        events.push(`switch:${handle}`);
        if (switchFailure) throw new Error("native window rejected");
      }),
      execute: vi.fn(async (callback) => {
        events.push("observe-document");
        return callback();
      }),
      waitUntil: vi.fn(async (predicate, options) => {
        events.push("wait-foreground");
        if (!(await predicate())) throw new Error(options.timeoutMsg);
      }),
    };
  }

  it("establishes native foreground through the current handle before observing document focus", async () => {
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const events = [];
    const browser = foregroundBrowser(events, false);
    try {
      await expect(focusCurrentTauriWindow(browser)).resolves.toBe("current-native-window");
      expect(events).toEqual([
        "get-window",
        "switch:current-native-window",
        "wait-foreground",
        "observe-document",
      ]);
      expect(browser.waitUntil).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          timeout: 3_000,
          interval: 50,
        }),
      );
    } finally {
      visible.mockRestore();
      focused.mockRestore();
    }
  });

  it.each(["rejected", "hidden", "unfocused"])(
    "rejects %s native foreground without retrying window commands",
    async (reason) => {
      const visible = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue(reason === "hidden" ? "hidden" : "visible");
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(reason !== "unfocused");
      const browser = foregroundBrowser([], reason === "rejected");
      try {
        await expect(focusCurrentTauriWindow(browser)).rejects.toThrow(
          reason === "rejected" ? "native window rejected" : "visible and focused",
        );
        expect(browser.getWindowHandle).toHaveBeenCalledOnce();
        expect(browser.switchToWindow).toHaveBeenCalledOnce();
        expect(browser.waitUntil).toHaveBeenCalledTimes(reason === "rejected" ? 0 : 1);
      } finally {
        visible.mockRestore();
        focused.mockRestore();
      }
    },
  );

  it.each([
    ["win32", "era-web-tauri.exe"],
    ["linux", "era-web-tauri"],
    ["darwin", "era-web-tauri"],
  ])("resolves the native binary name on %s", (platform, executable) => {
    const target = path.resolve("/workspace/isolated-build/target");
    const debugBinary = resolveTauriBinary(target, false, platform);
    const releaseBinary = resolveTauriBinary(target, true, platform);

    expect(debugBinary).toBe(path.join(target, "debug", executable));
    expect(releaseBinary).toBe(path.join(target, "release", executable));
    expect(path.basename(debugBinary)).toBe(executable);
    expect(path.basename(path.dirname(debugBinary))).toBe("debug");
    expect(path.basename(releaseBinary)).toBe(executable);
    expect(path.basename(path.dirname(releaseBinary))).toBe("release");
  });

  it("rejects missing or relative Cargo metadata instead of selecting an old default binary", () => {
    for (const directory of [undefined, "", "../target"])
      expect(() => resolveTauriBinary(directory, false)).toThrow("absolute target_directory");
  });

  it("captures every element with attributes, text, value, visibility, and runtime state", async () => {
    document.body.innerHTML =
      '<main data-stage="title"><input value="0"><progress value="2" max="3"></progress><span>era萝乐娜</span></main>';
    for (const element of document.querySelectorAll("*")) {
      element.getBoundingClientRect = () => ({ width: 100, height: 20 });
    }
    window.__RUSTYERA_TEST__ = { snapshot: () => ({ bridgeKind: "tauri", phase: "ready" }) };
    const browser = { execute: vi.fn(async (callback) => callback()) };

    const snapshot = await captureCompleteTauriSnapshot(browser);

    expect(snapshot.runtime).toEqual({ bridgeKind: "tauri", phase: "ready" });
    expect(snapshot.document).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "main",
          attributes: { "data-stage": "title" },
          text: "era萝乐娜",
          value: null,
          visible: true,
        }),
        expect.objectContaining({ tag: "input", value: "0", visible: true }),
        expect.objectContaining({ tag: "progress", value: 2, visible: true }),
      ]),
    );
  });

  it("captures selected protocol evidence without cloning unrelated payloads", async () => {
    const fault = { code: "service_failure" };
    const records = [{ message: { type: "command_rejected", value: { code: "stale_request" } } }];
    const full = vi.fn(() => {
      throw new Error("full ledger must not be cloned");
    });
    const protocolEvidence = vi.fn(() => ({ records }));
    window.__RUSTYERA_TEST_PROTOCOL_TYPES__ = ["command_rejected"];
    window.__RUSTYERA_TEST__ = {
      snapshotSummary: () => ({ fault, serviceEvidence: { enabled: true } }),
      snapshot: full,
      protocolEvidence,
    };
    const browser = { execute: vi.fn(async (callback) => callback()) };
    const snapshot = await captureCompleteTauriSnapshot(browser);
    expect(snapshot.runtime.serviceEvidence.records).toEqual(records);
    expect(full).not.toHaveBeenCalled();
    expect(protocolEvidence).toHaveBeenCalledWith(["command_rejected"]);
    delete window.__RUSTYERA_TEST_PROTOCOL_TYPES__;
  });

  it("resolves visibility once per element while preserving nested text", async () => {
    document.body.innerHTML = "<main><span>map</span><button value='1'>move</button></main>";
    const computed = vi.spyOn(window, "getComputedStyle");
    for (const element of document.querySelectorAll("*")) {
      element.getBoundingClientRect = () => ({ width: 100, height: 20 });
    }
    const browser = { execute: vi.fn(async (callback) => callback()) };

    try {
      const snapshot = await captureCompleteTauriSnapshot(browser);
      expect(snapshot.document.find((element) => element.tag === "main")?.text).toBe("mapmove");
      expect(computed).toHaveBeenCalledTimes(document.querySelectorAll("*").length);
    } finally {
      computed.mockRestore();
    }
  });

  it("propagates non-rendered ancestor styles through the visibility topology", async () => {
    document.body.innerHTML = [
      "<div id='display'><span id='display-child'>display</span></div>",
      "<div id='opacity'><span id='opacity-child'>opacity</span></div>",
      "<div id='content'><span id='content-child'>content</span></div>",
      "<span id='visible'>visible</span>",
    ].join("");
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: element.id === "display" ? "none" : "block",
      opacity: element.id === "opacity" ? "0" : "1",
      contentVisibility: element.id === "content" ? "hidden" : "visible",
      visibility: "visible",
    }));
    for (const element of document.querySelectorAll("*")) {
      element.getBoundingClientRect = () => ({ width: 100, height: 20 });
    }
    const browser = { execute: vi.fn(async (callback) => callback()) };

    try {
      const snapshot = await captureCompleteTauriSnapshot(browser);
      const visibility = Object.fromEntries(
        snapshot.document
          .filter((element) => element.attributes.id)
          .map((element) => [element.attributes.id, element.visible]),
      );
      expect(visibility).toEqual({
        display: false,
        "display-child": false,
        opacity: false,
        "opacity-child": false,
        content: false,
        "content-child": false,
        visible: true,
      });
    } finally {
      computed.mockRestore();
    }
  });

  it("uses maintained HTML dimensions before allocating geometry rectangles", async () => {
    document.body.innerHTML = "<main><span>map</span></main>";
    for (const element of document.querySelectorAll("*")) {
      Object.defineProperties(element, {
        offsetWidth: { configurable: true, value: 100 },
        offsetHeight: { configurable: true, value: 20 },
      });
      element.getBoundingClientRect = vi.fn(() => {
        throw new Error("positive HTML dimensions must not resolve a rectangle");
      });
    }
    const browser = { execute: vi.fn(async (callback) => callback()) };

    const snapshot = await captureCompleteTauriSnapshot(browser);

    expect(
      snapshot.document
        .filter((element) => ["main", "span"].includes(element.tag))
        .every((element) => element.visible),
    ).toBe(true);
    for (const element of document.querySelectorAll("*"))
      expect(element.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("expands the compact text tree into exact textContent for every element", () => {
    const snapshot = {
      document: [
        { tag: "main", textParts: [1, "!"], value: null, visible: true },
        { tag: "span", textParts: ["map"], value: null, visible: true },
      ],
      runtime: { phase: "waiting_input" },
    };

    const expanded = expandCompleteTauriSnapshot(snapshot);
    expect(expanded).toEqual({
      document: [
        { tag: "main", text: "map!", value: null, visible: true },
        { tag: "span", text: "map", value: null, visible: true },
      ],
      runtime: { phase: "waiting_input" },
    });
    expect(Object.keys(expanded)).not.toContain("compactProgressSignature");
    expect(expanded.compactProgressSignature).toEqual(expect.any(String));
  });

  it("derives the watchdog signature from compact direct text", () => {
    const makeSnapshot = (text) =>
      expandCompleteTauriSnapshot({
        document: [
          { tag: "main", textParts: [1], value: null, visible: true },
          { tag: "span", textParts: [text], value: null, visible: true },
        ],
        runtime: { phase: "waiting_input" },
      });

    expect(makeSnapshot("map").compactProgressSignature).toBe(
      makeSnapshot("map").compactProgressSignature,
    );
    expect(makeSnapshot("map").compactProgressSignature).not.toBe(
      makeSnapshot("room").compactProgressSignature,
    );
  });

  it("rejects a complete snapshot command that exceeds its hard deadline", async () => {
    const browser = { execute: vi.fn(() => new Promise(() => {})) };

    await expect(captureCompleteTauriSnapshot(browser, 1)).rejects.toThrow(
      "complete snapshot capture exceeded 1 ms",
    );
  });

  it("keeps the five-second capture deadline during project loading", () => {
    expect(snapshotCaptureTimeout(undefined, 5_000)).toBe(5_000);
    expect(snapshotCaptureTimeout({ runtime: { projectLoading: false } }, 5_000)).toBe(5_000);
    expect(snapshotCaptureTimeout({ runtime: { projectLoading: true } }, 5_000)).toBe(5_000);
  });

  it("rejects the second consecutive identical complete snapshot", () => {
    const snapshot = { document: [{ tag: "main" }], runtime: { phase: "waiting_input" } };

    expect(() => assertSnapshotProgress(snapshot, structuredClone(snapshot))).toThrow(
      /1 consecutive 5-second interval/,
    );
    expect(() =>
      assertSnapshotProgress(snapshot, { ...snapshot, runtime: { phase: "running" } }),
    ).not.toThrow();
  });

  it("reuses precomputed complete snapshot signatures", () => {
    const previous = { document: [] };
    const current = { document: [] };
    previous.circular = previous;
    current.circular = current;

    expect(() =>
      assertSnapshotProgress(previous, current, "Browser", 1, {
        previous: "previous",
        current: "current",
      }),
    ).not.toThrow();
  });

  it("rejects the first unchanged loading interval", () => {
    const snapshot = {
      document: [{ tag: "main" }],
      runtime: { phase: "negotiating", projectLoading: true },
    };
    expect(() => assertSnapshotProgress(snapshot, structuredClone(snapshot), "Browser", 1)).toThrow(
      /1 consecutive 5-second intervals/,
    );
  });

  it("permits only the authorized first three unchanged loading intervals", () => {
    vi.stubEnv("RUSTYERA_TEST_LOADING_STALL_INTERVALS", "4");
    const snapshot = {
      document: [{ tag: "main" }],
      runtime: { phase: "ready", projectLoading: true, canInteract: false, wait: null },
    };
    for (const count of [1, 2, 3])
      expect(() =>
        assertSnapshotProgress(snapshot, structuredClone(snapshot), "Browser", count),
      ).not.toThrow();
    expect(() => assertSnapshotProgress(snapshot, structuredClone(snapshot), "Browser", 4)).toThrow(
      /4 consecutive 5-second intervals/,
    );
    for (const runtime of [
      { ...snapshot.runtime, projectLoading: false },
      { ...snapshot.runtime, canInteract: true },
      { ...snapshot.runtime, wait: { kind: "integer_value" } },
      { ...snapshot.runtime, transfer: { export: { name: "full.reraproj" } } },
    ]) {
      const active = { ...snapshot, runtime };
      expect(() => assertSnapshotProgress(active, structuredClone(active), "Browser", 1)).toThrow(
        /1 consecutive 5-second interval/,
      );
    }
    expect(snapshotCaptureTimeout(snapshot)).toBe(5_000);
  });

  it("does not count growing capture history as game progress", () => {
    const first = {
      document: [{ tag: "body", text: "waiting", visible: true }],
      runtime: {
        phase: "waiting_input",
        serviceEvidence: {
          version: 1,
          enabled: true,
          overflow: false,
          failure: null,
          bytes: 20,
          records: [{ messageId: "1", message: { type: "advance_time" } }],
          pointerSamples: [],
        },
        serviceLifecycle: { enabled: true, failure: null, records: [{ phase: "start" }] },
      },
    };
    const second = structuredClone(first);
    second.runtime.serviceEvidence.records.push({
      messageId: "2",
      message: {
        type: "storage_response",
        value: {
          result: {
            type: "read",
            data: { observation: "bulk_bytes_digest", byteLength: 3, blake3: "digest-a" },
          },
        },
      },
    });
    second.runtime.serviceEvidence.bytes = 40;
    second.runtime.serviceEvidence.pointerSamples.push({ index: 0, requestId: "3" });
    second.runtime.serviceLifecycle.records.push({ phase: "settled" });
    expect(() => assertSnapshotProgress(first, second)).toThrow(/identical/);
    expect(second.runtime.serviceEvidence.records).toHaveLength(2);
    expect(second.runtime.serviceLifecycle.records).toHaveLength(2);
    second.runtime.serviceEvidence.records[1].message.value.result.data.blake3 = "digest-b";
    expect(() => assertSnapshotProgress(first, second)).toThrow(/identical/);
    second.runtime.phase = "running";
    expect(() => assertSnapshotProgress(first, second)).not.toThrow();
    second.runtime.phase = first.runtime.phase;
    second.runtime.serviceEvidence.overflow = true;
    expect(snapshotProgressSignature(first)).not.toBe(snapshotProgressSignature(second));
    second.runtime.serviceEvidence.overflow = false;
    second.runtime.serviceLifecycle.failure = "lifecycle_observation_limit";
    expect(snapshotProgressSignature(first)).not.toBe(snapshotProgressSignature(second));
  });

  it("ignores log timestamps but preserves observable runtime changes", () => {
    const first = {
      document: [],
      runtime: { phase: "running", logs: [{ timestamp: "2026-08-02T00:00:00Z", message: "tick" }] },
    };
    const second = {
      document: [],
      runtime: { phase: "running", logs: [{ timestamp: "2026-08-02T00:00:05Z", message: "tick" }] },
    };

    expect(snapshotProgressSignature(first)).toBe(snapshotProgressSignature(second));
    expect(() => assertSnapshotProgress(first, second)).toThrow(/identical/);
    expect(snapshotProgressSignature(first)).not.toBe(
      snapshotProgressSignature({
        ...second,
        runtime: { ...second.runtime, phase: "waiting_input" },
      }),
    );
  });

  it.each([
    [{ fault: { message: "boom" } }, /runtime faulted/],
    [
      { fault: null, logs: [{ message: "command rejected [VersionMismatch]: stale" }] },
      /rejected the configured state/,
    ],
    [
      { fault: null, logs: [{ message: "command rejected [ProtocolMismatch]: stale" }] },
      /rejected the configured state/,
    ],
  ])("fails the monitor for terminal runtime state %#", async (runtime, expected) => {
    const browser = { execute: vi.fn(async () => ({ document: [], runtime })) };
    const output = vi.fn();
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output });

    await expect(monitor.failure).rejects.toThrow(expected);
    await expect(monitor.stop()).rejects.toThrow(expected);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ document: [], runtime });
  });

  it("delivers a structured snapshot without a stringify/parse round trip", async () => {
    const runtime = { fault: { message: "boom" } };
    const browser = { execute: vi.fn(async () => ({ document: [], runtime })) };
    const output = vi.fn();
    const outputEvent = vi.fn();
    const monitor = startTauriSessionMonitor(browser, {
      interval: 1,
      output,
      outputEvent,
    });

    await expect(monitor.failure).rejects.toThrow(/runtime faulted/);
    await expect(monitor.stop()).rejects.toThrow(/runtime faulted/);
    expect(output).not.toHaveBeenCalled();
    expect(outputEvent).toHaveBeenCalledWith(expect.objectContaining({ document: [], runtime }));
  });

  it("fails exactly when the shared deadline is reached", async () => {
    const browser = { execute: vi.fn() };
    const monitor = startTauriSessionMonitor(browser, {
      deadline: Date.now() - 1,
      interval: 1,
      output: vi.fn(),
    });

    await expect(monitor.failure).rejects.toThrow(/60-minute wall-clock limit/);
    await expect(monitor.stop()).rejects.toThrow(/60-minute wall-clock limit/);
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("propagates an in-flight capture failure when stop races with the monitor", async () => {
    let finishCapture;
    const browser = {
      execute: vi.fn(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      ),
    };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });
    void monitor.failure.catch(() => undefined);
    const stopping = monitor.stop();
    finishCapture({ document: [], runtime: { fault: { message: "late fault" } } });

    await expect(stopping).rejects.toThrow(/runtime faulted/);
  });

  it("fails after two consecutive identical full snapshots", async () => {
    const snapshot = { document: [{ tag: "main" }], runtime: { phase: "running", logs: [] } };
    const browser = { execute: vi.fn(async () => structuredClone(snapshot)) };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });

    await expect(monitor.failure).rejects.toThrow(/1 consecutive 5-second interval/);
    await expect(monitor.stop()).rejects.toThrow(/1 consecutive 5-second interval/);
    expect(browser.execute).toHaveBeenCalledTimes(2);
  });

  it("resets the authorized loading interval count on progress and restores the normal limit", async () => {
    vi.stubEnv("RUSTYERA_TEST_LOADING_STALL_INTERVALS", "4");
    const loading = (status) => ({
      document: [],
      runtime: { projectLoading: true, status },
    });
    const running = { document: [], runtime: { projectLoading: false, phase: "running" } };
    const snapshots = [
      ...Array.from({ length: 4 }, () => loading("reading 10")),
      ...Array.from({ length: 4 }, () => loading("reading 20")),
      running,
      running,
    ];
    const browser = { execute: vi.fn(async () => structuredClone(snapshots.shift())) };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });
    await expect(monitor.failure).rejects.toThrow(/1 consecutive 5-second interval/);
    await expect(monitor.stop()).rejects.toThrow(/1 consecutive 5-second interval/);
    expect(browser.execute).toHaveBeenCalledTimes(10);
  });

  it("fails at the fourth unchanged loading interval when explicitly authorized", async () => {
    vi.stubEnv("RUSTYERA_TEST_LOADING_STALL_INTERVALS", "4");
    const snapshot = { document: [], runtime: { projectLoading: true } };
    const browser = { execute: vi.fn(async () => structuredClone(snapshot)) };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });
    await expect(monitor.failure).rejects.toThrow(/4 consecutive 5-second intervals/);
    await expect(monitor.stop()).rejects.toThrow(/4 consecutive 5-second intervals/);
    expect(browser.execute).toHaveBeenCalledTimes(5);
  });

  it("stops cleanly while waiting for the next snapshot", async () => {
    const snapshot = { document: [], runtime: { phase: "running", logs: [] } };
    const browser = { execute: vi.fn(async () => structuredClone(snapshot)) };
    const monitor = startTauriSessionMonitor(browser, { interval: 60_000, output: vi.fn() });
    await vi.waitFor(() => expect(browser.execute).toHaveBeenCalledOnce());

    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(browser.execute).toHaveBeenCalledOnce();
  });

  it("captures an overdue snapshot before stopping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let capture = 0;
    const output = vi.fn();
    const browser = {
      execute: vi.fn(async () => ({
        document: [{ tag: "main", text: String(++capture) }],
        runtime: { phase: String(capture) },
      })),
    };
    const monitor = startTauriSessionMonitor(browser, {
      interval: 5_000,
      output,
    });
    await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());

    vi.setSystemTime(5_001);
    await monitor.stop();

    expect(browser.execute).toHaveBeenCalledTimes(2);
  });
});

describe("snake service client assertions", () => {
  const ready = () => ({
    bridgeKind: "tauri",
    fault: null,
    canInteract: true,
    wait: { kind: "integer_value" },
    output: [...SNAKE_SERVICE_MARKERS, "SNAKE_POINTER=40/-20/41", "SNAKE_SERVICES_READY"],
  });
  it("requires every semantic marker and actual script button value", () => {
    expect(assertSnakeServiceState(ready(), "tauri")).toEqual(ready());
    for (const marker of SNAKE_SERVICE_MARKERS)
      expect(() =>
        assertSnakeServiceState(
          { ...ready(), output: ready().output.filter((value) => value !== marker) },
          "tauri",
        ),
      ).toThrow("missing service marker");
    expect(() =>
      assertSnakeServiceState(
        {
          ...ready(),
          output: ready().output.map((value) => value.replace("40/-20/41", "40/-20/1")),
        },
        "tauri",
      ),
    ).toThrow("script value 41");
    expect(() =>
      assertSnakeServiceState({ ...ready(), fault: { message: "stale projection" } }, "tauri"),
    ).toThrow("service fault");
    expect(() => assertSnakeServiceState(ready(), "browser")).toThrow("require browser");
  });
});
