import {
  nativeWebdriverOption,
  validateNativeWebdriverSource,
} from "../scripts/tauri-native-webdriver-support.mjs";
import {
  observePendingCanvas,
  assertCancelledLifecycle,
} from "../scripts/snake-service-lifecycle-races.mjs";
import {
  assertLifecyclePointer,
  hoverLifecycleTarget,
} from "../scripts/snake-service-lifecycle-test-support.mjs";
import {
  assertSnakeServiceState,
  runSnakeServicesClient,
  SNAKE_SERVICE_MARKERS,
} from "../scripts/snake-services-test-support.mjs";
/* global document, structuredClone, window */

import path from "node:path";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
  CaptureWriter,
  hashFile,
  inventory,
  selectCaptureCase,
  sha256,
} from "../scripts/snake-service-capture-io.mjs";
import {
  captureTerminal,
  runServiceOracleCapture,
  serviceOracleReady,
  serviceOracleReadyMarker,
} from "../scripts/snake-service-capture-client.mjs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSnakeDataState,
  runSnakeDataClient,
  SNAKE_DATA_MARKERS,
  SNAKE_DATA_START,
} from "../scripts/snake-data-test-support.mjs";
import {
  assertSnapshotProgress,
  captureCompleteTauriSnapshot,
  resolveTauriBinary,
  snapshotProgressSignature,
  startTauriSessionMonitor,
} from "../scripts/tauri-test-support.mjs";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete window.__RUSTYERA_TEST__;
});

describe("snake data client test support", () => {
  function completedState(bridgeKind = "tauri") {
    return {
      bridgeKind,
      fault: null,
      canInteract: true,
      wait: { kind: "integer_value", wait_id: "2" },
      output: [SNAKE_DATA_START, ...SNAKE_DATA_MARKERS],
    };
  }

  it.each(SNAKE_DATA_MARKERS)("requires the completed %s stage", (marker) => {
    const state = completedState();
    state.output = state.output.filter((line) => line !== marker);

    expect(() => assertSnakeDataState(state, "tauri")).toThrow("stages are missing");
  });

  it("rejects a wrong bridge, fault, or non-interactive completion", () => {
    expect(() => assertSnakeDataState(completedState("browser"), "tauri")).toThrow(
      "requires tauri",
    );
    expect(() =>
      assertSnakeDataState({ ...completedState(), fault: { message: "broken" } }, "tauri"),
    ).toThrow("runtime fault");
    expect(() =>
      assertSnakeDataState({ ...completedState(), canInteract: false }, "tauri"),
    ).toThrow("final integer input wait");
    expect(() =>
      assertSnakeDataState({ ...completedState(), wait: { kind: "any_key" } }, "tauri"),
    ).toThrow("final integer input wait");
  });

  it.each([
    ["browser", "firefox"],
    ["browser", "safari"],
    ["tauri", "wry"],
  ])(
    "submits visible input and waits for a new wait identity on %s/%s",
    async (bridgeKind, browserName) => {
      const initial = {
        ...completedState(bridgeKind),
        wait: { kind: "integer_value", wait_id: "1" },
        output: [SNAKE_DATA_START],
      };
      const complete = completedState(bridgeKind);
      const states = [initial, { ...complete, wait: initial.wait }, complete];
      const input = {
        waitForDisplayed: vi.fn(async () => undefined),
        waitForEnabled: vi.fn(async () => undefined),
        setValue: vi.fn(async () => undefined),
      };
      const button = { click: vi.fn(async () => undefined) };
      const browser = {
        capabilities: { browserName },
        keys: vi.fn(async () => undefined),
        execute: vi.fn(async (callback) => {
          window.__RUSTYERA_TEST__ = { snapshot: () => states.shift() };
          return callback();
        }),
        $: vi.fn(async (selector) => {
          if (selector === ".prompt-bar input") return input;
          if (selector === ".prompt-bar button[type=submit]") return button;
          throw new Error(`unexpected selector ${selector}`);
        }),
        waitUntil: vi.fn(async (predicate) => {
          for (let attempt = 0; attempt < 3; attempt += 1) if (await predicate()) return;
          throw new Error("test predicate never completed");
        }),
      };

      await expect(runSnakeDataClient(browser, bridgeKind)).resolves.toBe(complete);
      expect(input.waitForDisplayed).toHaveBeenCalledOnce();
      expect(input.waitForEnabled).toHaveBeenCalledOnce();
      expect(input.setValue).toHaveBeenCalledWith("1");
      if (browserName === "safari") {
        expect(browser.keys).toHaveBeenCalledWith("Enter");
        expect(button.click).not.toHaveBeenCalled();
      } else {
        expect(button.click).toHaveBeenCalledOnce();
        expect(browser.keys).not.toHaveBeenCalled();
      }
      expect(browser.execute).toHaveBeenCalledTimes(3);
    },
  );
});

describe("snake service client prompt submission", () => {
  it.each(["firefox", "safari", "wry"])("uses real prompt actions on %s", async (browserName) => {
    const states = [
      {
        canInteract: true,
        wait: { kind: "integer_value", wait_id: "1" },
        output: ["SNAKE_SERVICES_START"],
      },
      {
        canInteract: true,
        wait: { kind: "integer_value", wait_id: "2" },
        output: ["SNAKE_POINTER_READY"],
      },
      {
        canInteract: true,
        wait: { kind: "integer_value", wait_id: "3" },
        output: [...SNAKE_SERVICE_MARKERS, "SNAKE_POINTER=1/-2/41", "SNAKE_SERVICES_READY"],
      },
    ].map((state) => ({ ...state, bridgeKind: "browser" }));
    const input = { waitForDisplayed: vi.fn(), waitForEnabled: vi.fn(), setValue: vi.fn() };
    const submit = { click: vi.fn() };
    const target = {
      waitForDisplayed: vi.fn(),
      waitForEnabled: vi.fn(),
      moveTo: vi.fn(),
      click: vi.fn(),
    };
    const browser = {
      capabilities: { browserName },
      keys: vi.fn(),
      execute: vi.fn(async () => states.shift()),
      waitUntil: async (predicate) => {
        expect(await predicate()).toBe(true);
      },
      $: async (selector) =>
        ({
          ".prompt-bar input": input,
          ".prompt-bar button[type=submit]": submit,
          "button=SNAKE_POINTER_TARGET": target,
        })[selector],
    };
    await runSnakeServicesClient(browser, "browser");
    expect(input.setValue).toHaveBeenCalledWith("1");
    expect(target.moveTo).toHaveBeenCalledOnce();
    expect(target.click).toHaveBeenCalledOnce();
    if (browserName === "safari") {
      expect(browser.keys).toHaveBeenCalledWith("Enter");
      expect(submit.click).not.toHaveBeenCalled();
    } else {
      expect(submit.click).toHaveBeenCalledOnce();
      expect(browser.keys).not.toHaveBeenCalled();
    }
  });
});

describe("Tauri end-to-end test support", () => {
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

  it("rejects a complete snapshot command that exceeds its hard deadline", async () => {
    const browser = { execute: vi.fn(() => new Promise(() => {})) };

    await expect(captureCompleteTauriSnapshot(browser, 1)).rejects.toThrow(
      "complete snapshot capture exceeded 1 ms",
    );
  });

  it("rejects the second consecutive identical complete snapshot", () => {
    const snapshot = { document: [{ tag: "main" }], runtime: { phase: "waiting_input" } };

    expect(() => assertSnapshotProgress(snapshot, structuredClone(snapshot))).toThrow(
      /two consecutive complete snapshots were identical/,
    );
    expect(() =>
      assertSnapshotProgress(snapshot, { ...snapshot, runtime: { phase: "running" } }),
    ).not.toThrow();
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
        },
        serviceLifecycle: { enabled: true, failure: null, records: [{ phase: "start" }] },
      },
    };
    const second = structuredClone(first);
    second.runtime.serviceEvidence.records.push({
      messageId: "2",
      message: { type: "advance_time" },
    });
    second.runtime.serviceEvidence.bytes = 40;
    second.runtime.serviceLifecycle.records.push({ phase: "settled" });
    expect(() => assertSnapshotProgress(first, second)).toThrow(/identical/);
    expect(second.runtime.serviceEvidence.records).toHaveLength(2);
    expect(second.runtime.serviceLifecycle.records).toHaveLength(2);
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

    await expect(monitor.failure).rejects.toThrow(/two consecutive complete snapshots/);
    await expect(monitor.stop()).rejects.toThrow(/two consecutive complete snapshots/);
    expect(browser.execute).toHaveBeenCalledTimes(2);
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

describe("snake service lifecycle assertions", () => {
  it("reveals a clipped target before moving the real pointer after resize", async () => {
    let visible = false;
    const target = {
      async scrollIntoView() {
        visible = true;
      },
      async moveTo() {
        if (!visible) throw new Error("pointer would hit the input overlay");
      },
    };
    await expect(hoverLifecycleTarget({ $: async () => target })).resolves.toBeUndefined();
  });
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

describe("real lifecycle race evidence assertions", () => {
  const sourceUrl = "http://127.0.0.1:19001/snake-lifecycle/" + "a".repeat(64) + ".png";
  const request = {
    index: 8,
    sessionGeneration: 4,
    direction: "receive",
    epoch: "20",
    message: {
      type: "service_request",
      value: { request_id: "9", kind: "canvas", operation: "sample_canvas_pixel" },
    },
  };
  const authorized = {
    index: 0,
    phase: "resource_authorized",
    sourceUrl,
    resourceGeneration: 4,
    sha256: "b".repeat(64),
    byteLength: 71,
  };
  const start = { index: 1, phase: "start", sourceUrl, resourceGeneration: 4 };
  const cancel = { index: 2, phase: "cancelled", sourceUrl, resourceGeneration: 4 };
  const settled = {
    index: 4,
    phase: "settled",
    sourceUrl,
    resourceGeneration: 4,
    outcome: "resolved",
  };
  const fresh = {
    index: 9,
    sessionGeneration: 5,
    direction: "receive",
    epoch: "21",
    message: {
      type: "service_request",
      value: { request_id: "9", kind: "canvas", operation: "sample_canvas_pixel" },
    },
  };
  const reply = {
    index: 10,
    sessionGeneration: 5,
    direction: "send",
    epoch: "21",
    message: { type: "service_response", value: { request_id: "9", result: { type: "ready" } } },
  };
  const freshDecode = {
    index: 3,
    phase: "settled",
    resourceId: "resources/lifecycle-next.png",
    resourceGeneration: 5,
    outcome: "resolved",
  };
  const state = (wire = [request], decode = [authorized, start], epoch = "20") => ({
    runtimeEpoch: epoch,
    fault: null,
    serviceEvidence: {
      enabled: true,
      overflow: false,
      failure: null,
      records: wire,
      sessionGeneration: epoch === "21" ? 5 : 4,
    },
    serviceLifecycle: { enabled: true, failure: null, records: decode },
  });

  it("requires actual pending service, source authorization and unfinished physical decode", () => {
    expect(observePendingCanvas(state(), sourceUrl, 7)).toMatchObject({
      epoch: "20",
      authorization: authorized,
    });
    expect(observePendingCanvas(state([request], []), sourceUrl, 7)).toBeNull();
    expect(() => observePendingCanvas(state([], [authorized, start]), sourceUrl, 7)).toThrow(
      "exactly one",
    );
    expect(() => observePendingCanvas(state([request], [start]), sourceUrl, 7)).toThrow(
      "authorized source hash",
    );
    expect(() =>
      observePendingCanvas(state([request], [authorized, start, settled]), sourceUrl, 7),
    ).toThrow("not physically");
    expect(() =>
      observePendingCanvas(
        state([request, { ...reply, epoch: "20", sessionGeneration: 4 }]),
        sourceUrl,
        7,
      ),
    ).toThrow("already replied");
    expect(() =>
      observePendingCanvas(
        { ...state(), serviceEvidence: { enabled: true, overflow: true } },
        sourceUrl,
        7,
      ),
    ).toThrow("complete real");
  });

  it("does not match old replies when a restarted transport reuses its epoch and request ID", () => {
    const history = { ...reply, index: 3, epoch: "20", sessionGeneration: 3 };
    const earlier = { ...reply, index: 5, epoch: "20", sessionGeneration: 4 };
    const pending = observePendingCanvas(state([history, earlier, request]), sourceUrl, 7);
    expect(pending.request.index).toBe(8);
    const held = state(
      [history, earlier, request, { ...fresh, epoch: "20" }, { ...reply, epoch: "20" }],
      [authorized, start, cancel, freshDecode],
      "21",
    );
    held.runtimeEpoch = "20";
    const completed = {
      ...held,
      serviceLifecycle: {
        ...held.serviceLifecycle,
        records: [authorized, start, cancel, freshDecode, settled],
      },
    };
    expect(
      assertCancelledLifecycle(pending, held, completed, true).beforeReleaseSessionGeneration,
    ).toBe(5);
    const stale = {
      ...completed,
      serviceEvidence: {
        ...completed.serviceEvidence,
        records: [
          ...completed.serviceEvidence.records,
          { ...reply, index: 11, epoch: "20", sessionGeneration: 4 },
        ],
      },
    };
    expect(() => assertCancelledLifecycle(pending, held, stale, true)).toThrow("stale reply");
  });

  it("separates actual cancellation, new request progress, late settle and resource generation", () => {
    const pending = observePendingCanvas(state(), sourceUrl, 7);
    const held = state([request, fresh, reply], [authorized, start, cancel, freshDecode], "21");
    const completed = state(
      [request, fresh, reply],
      [authorized, start, cancel, freshDecode, settled],
      "21",
    );
    expect(assertCancelledLifecycle(pending, held, completed, true).settled).toEqual(settled);
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh, reply], [authorized, start, freshDecode], "21"),
        completed,
        true,
      ),
    ).toThrow("actually cancelled");
    expect(() => assertCancelledLifecycle(pending, completed, completed, true)).toThrow(
      "physical decode",
    );
    expect(() =>
      assertCancelledLifecycle(
        pending,
        {
          ...held,
          runtimeEpoch: "20",
          serviceEvidence: { ...held.serviceEvidence, sessionGeneration: 4 },
        },
        completed,
        true,
      ),
    ).toThrow("new runtime session");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh], [authorized, start, cancel], "21"),
        completed,
        false,
      ),
    ).toThrow("did not complete");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh, reply], [authorized, start, cancel], "21"),
        completed,
        true,
      ),
    ).toThrow("newer real resource generation");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        held,
        state(
          [request, fresh, reply, { ...reply, index: 11, epoch: "20", sessionGeneration: 4 }],
          completed.serviceLifecycle.records,
          "21",
        ),
        true,
      ),
    ).toThrow("stale reply");
  });
});

describe("explicit native WebDriver source binding", () => {
  const upstreamChecksum = "30c5bffe978c41b06ad44a5f4b5b543405918cf316b98756c678a6431061f2e9";
  const row = (file, text) => ({
    path: file,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  });

  async function fixture(run, cargoVersion = "1.2.0") {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-native-provider-"));
    const provider = path.join(root, "provider space");
    const manifests = path.join(root, "trusted");
    const cargo = `[package]\nname = "tauri-plugin-wdio-webdriver"\nversion = "${cargoVersion}"\n`;
    const originalSource = "original provider\n";
    const nativeSource = "native overlay\n";
    try {
      await mkdir(path.join(provider, "src"), { recursive: true });
      await mkdir(manifests);
      await writeFile(path.join(provider, "Cargo.toml"), cargo);
      await writeFile(path.join(provider, "src/lib.rs"), nativeSource);
      await writeFile(
        path.join(manifests, "original-inventory.json"),
        JSON.stringify({
          package: "tauri-plugin-wdio-webdriver",
          version: "1.2.0",
          registryChecksum: upstreamChecksum,
          files: [row("Cargo.toml", cargo), row("src/lib.rs", originalSource)],
        }),
      );
      await writeFile(
        path.join(manifests, "overlay-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          upstreamPackage: "tauri-plugin-wdio-webdriver",
          upstreamVersion: "1.2.0",
          files: [row("src/lib.rs", nativeSource)],
        }),
      );
      await run({
        provider,
        manifests,
        nativeSource,
        validate: () =>
          validateNativeWebdriverSource(provider, {
            manifestDirectory: manifests,
            platform: "darwin",
          }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("does not add an override to ordinary test commands on any platform", () => {
    expect(nativeWebdriverOption(["--spec", "example.spec.mjs"], "linux")).toBeUndefined();
    expect(nativeWebdriverOption(["--native-webdriver-source", "/source space"], "darwin")).toBe(
      "/source space",
    );
  });

  it.each([
    [["--native-webdriver-source"], "darwin", /requires a path/],
    [["--native-webdriver-source", "--project", "/game"], "darwin", /requires a path/],
    [
      ["--native-webdriver-source", "/one", "--native-webdriver-source", "/two"],
      "darwin",
      /only once/,
    ],
    [["--native-webdriver-source", "/one"], "linux", /only on macOS/],
  ])("rejects malformed or unsupported opt-in arguments %#", (args, platform, message) => {
    expect(() => nativeWebdriverOption(args, platform)).toThrow(message);
  });

  it("binds the overlaid source and preserves one escaped Cargo argument", async () => {
    await fixture(async ({ validate }) => {
      const result = await validate();
      expect(result.cargoArguments).toEqual([
        "--",
        "--config",
        `patch.crates-io.tauri-plugin-wdio-webdriver.path=${JSON.stringify(result.provenance.source)}`,
      ]);
      expect(result.provenance).toMatchObject({
        package: "tauri-plugin-wdio-webdriver",
        version: "1.2.0",
        upstreamChecksum,
        fileCount: 2,
      });
      expect(result.provenance.materializedInventorySha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it.each(["modified", "missing", "extra"])("rejects a %s materialized input", async (kind) => {
    await fixture(async ({ provider, validate }) => {
      if (kind === "modified") await writeFile(path.join(provider, "src/lib.rs"), "tampered\n");
      if (kind === "missing") await rm(path.join(provider, "src/lib.rs"));
      if (kind === "extra") await writeFile(path.join(provider, "unexpected.rs"), "extra\n");
      await expect(validate()).rejects.toThrow(/identity mismatch|missing or unexpected/);
    });
  });

  it("rejects symlinked input even if its target has the expected bytes", async () => {
    await fixture(async ({ provider, manifests, nativeSource, validate }) => {
      const target = path.join(manifests, "native.rs");
      await writeFile(target, nativeSource);
      await rm(path.join(provider, "src/lib.rs"));
      await symlink(target, path.join(provider, "src/lib.rs"));
      await expect(validate()).rejects.toThrow(/symlinks/);
    });
  });

  it("rejects empty-directory nesting independently of the file count", async () => {
    await fixture(async ({ provider, validate }) => {
      await mkdir(path.join(provider, ...Array.from({ length: 17 }, () => "nested")), {
        recursive: true,
      });
      await expect(validate()).rejects.toThrow(/nesting is too deep/);
    });
  });

  it("rejects a source file that grew beyond the byte cap before hashing", async () => {
    await fixture(async ({ provider, validate }) => {
      await writeFile(path.join(provider, "src/lib.rs"), Buffer.alloc(2 * 1024 * 1024 + 1));
      await expect(validate()).rejects.toThrow(/bounded regular file/);
    });
  });

  it("rejects an unsafe or duplicate trusted overlay row", async () => {
    for (const kind of ["unsafe", "duplicate"]) {
      await fixture(async ({ manifests, validate }) => {
        const filename = path.join(manifests, "overlay-manifest.json");
        const manifest = JSON.parse(await readFile(filename, "utf8"));
        if (kind === "unsafe") manifest.files[0].path = "../outside";
        else manifest.files.push(manifest.files[0]);
        await writeFile(filename, JSON.stringify(manifest));
        await expect(validate()).rejects.toThrow(/unsafe file path|duplicate file path/);
      });
    }
  });

  it("checks Cargo package identity even when the supplied file digest matches", async () => {
    await fixture(async ({ validate }) => {
      await expect(validate()).rejects.toThrow(/Cargo package must be/);
    }, "9.9.9");
  });
});
