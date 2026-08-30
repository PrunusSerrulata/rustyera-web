/* global console */
import {
  nativeWebdriverOption,
  validateNativeWebdriverSource,
} from "../scripts/tauri-native-webdriver-support.mjs";
import {
  fileIdentity,
  recordBuiltArtifact,
  reusableArtifact,
  reusableBuildEnvironment,
} from "../scripts/tauri-build-cache.mjs";
import {
  observePendingCanvas,
  assertCancelledLifecycle,
  lifecycleRestartReady,
  lifecycleSession,
} from "../scripts/snake-service-lifecycle-races.mjs";
import {
  assertLifecyclePointer,
  assertSampledLifecyclePointer,
  assertBlurPointer,
  hoverLifecycleTarget,
  installPointerObservation,
  observeRealWindowBlur,
  setLifecyclePrompt,
  lifecycleViewport,
  pageUpLifecycleViewport,
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
import { Encoder } from "cbor-x";
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
  serviceOracleExportReady,
  serviceOracleReadyMarker,
} from "../scripts/snake-service-capture-client.mjs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSnakeDisplayState,
  assertSnakeDataState,
  runSnakeDataClient,
  SNAKE_DATA_MARKERS,
  SNAKE_DATA_START,
} from "../scripts/snake-data-test-support.mjs";
import {
  assertSnapshotProgress,
  captureCompleteTauriSnapshot,
  focusCurrentTauriWindow,
  resolveTauriBinary,
  snapshotProgressSignature,
  startTauriSessionMonitor,
} from "../scripts/tauri-test-support.mjs";
import { assertStructuredSnakeProfileNotifications } from "./tauri/structured-profile-notifications.mjs";

describe("structured snake profile notifications", () => {
  it("accepts every notified structured warning and rejects unstructured or mismatched notices", () => {
    const identity = {
      profile: "emuera.skia.snake",
      semantic_version: 9,
      policy_version: 9,
    };
    const diagnostic = (code, message, stage, generation = null, notification = "default") => ({
      code,
      level: "warning",
      message,
      notification,
      context: { identity, stage, generation },
    });
    const experimental = diagnostic(
      "runtime.experimental_compatibility_profile",
      "profile emuera.skia.snake is experimental",
      "configuration",
    );
    const generated = diagnostic(
      "compat.extra_argument",
      "extra argument was ignored",
      "runtime",
      4,
    );
    const logOnly = diagnostic(
      "compat.portability",
      "portable fallback was selected",
      "runtime",
      4,
      "log_only",
    );
    const notification = (id, value) => ({
      id,
      level: "warning",
      message: `[${value.code}] ${value.message} [profile=emuera.skia.snake@9/9 stage=${value.context.stage}]`,
    });
    const state = {
      logNotifications: [notification(1, experimental), notification(2, generated)],
      serviceEvidence: {
        records: [experimental, generated, logOnly].map((value) => ({
          direction: "receive",
          message: { type: "diagnostic", value },
        })),
      },
    };
    const visible = state.logNotifications.map(({ message }) => `警告${message} ×`);
    expect(assertStructuredSnakeProfileNotifications(state, visible)).toEqual([
      experimental,
      generated,
    ]);

    const extraError = structuredClone(state);
    extraError.logNotifications.push({ id: 3, level: "error", message: "unrelated failure" });
    expect(() => assertStructuredSnakeProfileNotifications(extraError, visible)).toThrow(
      "one-to-one",
    );

    const mismatched = structuredClone(state);
    mismatched.serviceEvidence.records[0].message.value.context.identity.profile = "emuera.em";
    expect(() => assertStructuredSnakeProfileNotifications(mismatched, visible)).toThrow(
      "one-to-one",
    );

    const invalidGeneration = structuredClone(state);
    invalidGeneration.serviceEvidence.records[1].message.value.context.generation = -1;
    expect(() => assertStructuredSnakeProfileNotifications(invalidGeneration, visible)).toThrow(
      "one-to-one",
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete window.__RUSTYERA_TEST__;
});

describe("verified Tauri build reuse", () => {
  it("keeps per-run picker inputs out of the reusable build without changing the test environment", () => {
    const first = {
      PATH: "/tools",
      VITE_RUSTYERA_TAURI_NATIVE_INPUT: "1",
      VITE_RUSTYERA_TEST_PROJECT: "/first/project",
      VITE_RUSTYERA_TEST_PROJECT_FILE: "/first/cache",
      VITE_RUSTYERA_TAURI_EXPORT_PATH: "/first/export",
    };
    const second = {
      PATH: "/tools",
      VITE_RUSTYERA_TAURI_SNAKE_SERVICES: "1",
      VITE_RUSTYERA_TEST_PROJECT: "/second/project",
      VITE_RUSTYERA_TEST_PROJECT_FILE: "/second/cache",
    };
    expect(reusableBuildEnvironment(first, "native-input.spec.mjs", undefined, true)).toEqual(
      reusableBuildEnvironment(second, "snake-services.spec.mjs", undefined, true),
    );
    expect(reusableBuildEnvironment(first, "cache-settings.spec.mjs", undefined, true)).toEqual(
      reusableBuildEnvironment(second, "snake-services.spec.mjs", undefined, true),
    );
    expect(first.VITE_RUSTYERA_TEST_PROJECT).toBe("/first/project");
    expect(reusableBuildEnvironment(first, "other.spec.mjs", undefined, false)).toEqual(first);
    expect(() => reusableBuildEnvironment(first, "other.spec.mjs", undefined, true)).toThrow(
      "supported",
    );
    expect(() => reusableBuildEnvironment(first, "snake-data.spec.mjs", "/state", true)).toThrow(
      "without --state",
    );
  });

  it("rejects strict cache misses before compilation and reports changed environment names", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tauri-required-cache-"));
    try {
      const binary = path.join(directory, "binary");
      const manifest = path.join(directory, "manifest.json");
      const contract = {
        sha256: "original",
        inputs: { environment: { PATH: "/original" }, webSources: [] },
      };
      await expect(
        reusableArtifact(manifest, contract, binary, { required: true }),
      ).rejects.toThrow("manifest missing or invalid; no build was started");
      await writeFile(binary, "verified");
      const recorded = await recordBuiltArtifact(manifest, contract, binary);
      expect(await reusableArtifact(manifest, contract, binary, { required: true })).toEqual(
        recorded,
      );
      const changed = {
        sha256: "changed",
        inputs: { ...contract.inputs, environment: { PATH: "/changed" } },
      };
      await expect(reusableArtifact(manifest, changed, binary, { required: true })).rejects.toThrow(
        "environment.PATH",
      );
      await writeFile(binary, "replaced");
      await expect(
        reusableArtifact(manifest, contract, binary, { required: true }),
      ).rejects.toThrow("executable missing or hash mismatch; no build was started");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses only a completed matching build and rejects source drift or replaced executables", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tauri-build-reuse-"));
    try {
      const binary = path.join(directory, "binary");
      const manifest = path.join(directory, "manifest.json");
      const contract = { sha256: "source-and-toolchain-identity" };
      await writeFile(binary, "executable-one");
      expect(await reusableArtifact(manifest, contract, binary)).toBeUndefined();
      const recorded = await recordBuiltArtifact(manifest, contract, binary);
      expect(await reusableArtifact(manifest, contract, binary)).toEqual(recorded);
      expect(
        await reusableArtifact(manifest, { sha256: "changed-source" }, binary),
      ).toBeUndefined();
      const inputs = {
        args: ["build", "--features", "webdriver"],
        webSources: [
          ["scripts/tauri-test.mjs", "old-harness"],
          ["src/main.ts", "same-app"],
          ["scripts/tauri-test-support.mjs", "old-runtime-helper"],
          ["scripts/vite-wasm-plugin.ts", "same-vite-input"],
          ["scripts/snake-service-lifecycle-races.mjs", "old-race-helper"],
          ["scripts/snake-services-test-support.mjs", "old-services-helper"],
          ["scripts/browser-compat-test.mjs", "old-browser-runner"],
          ["scripts/cache-handoff-test.mjs", "old-cache-handoff-runner"],
          ["scripts/web-test-lib.mjs", "old-browser-helper"],
        ],
        coreSources: [["crates/runtime.rs", "same-core"]],
        environment: { RUSTFLAGS: "same-flags" },
        provider: { sha256: "same-provider" },
      };
      const withSources = { sha256: "with-sources", inputs };
      await recordBuiltArtifact(manifest, withSources, binary);
      const changedHarness = structuredClone(withSources);
      changedHarness.sha256 = "changed-harness";
      changedHarness.inputs.webSources[0][1] = "fixed-retry-policy";
      expect(await reusableArtifact(manifest, changedHarness, binary)).toBeDefined();
      const changedRuntimeHelper = structuredClone(changedHarness);
      changedRuntimeHelper.sha256 = "changed-runtime-helper";
      changedRuntimeHelper.inputs.webSources[2][1] = "native-foreground-precondition";
      changedRuntimeHelper.inputs.webSources[4][1] = "transport-identity-before-image-gate";
      expect(await reusableArtifact(manifest, changedRuntimeHelper, binary)).toBeDefined();
      for (const index of [5, 6, 7, 8]) {
        const changedNodeHelper = structuredClone(changedRuntimeHelper);
        changedNodeHelper.inputs.webSources[index][1] = "node-only-observation-or-foreground";
        expect(await reusableArtifact(manifest, changedNodeHelper, binary)).toBeDefined();
      }
      const changedApp = structuredClone(changedRuntimeHelper);
      changedApp.inputs.webSources[1][1] = "different-app";
      expect(await reusableArtifact(manifest, changedApp, binary)).toBeUndefined();
      const changedBuild = structuredClone(changedHarness);
      changedBuild.inputs.args.push("--release");
      expect(await reusableArtifact(manifest, changedBuild, binary)).toBeUndefined();
      for (const change of [
        (value) => {
          value.inputs.coreSources[0][1] = "different-core";
        },
        (value) => {
          value.inputs.environment.RUSTFLAGS = "different-flags";
        },
        (value) => {
          value.inputs.provider.sha256 = "different-provider";
        },
        (value) => {
          value.inputs.webSources[3][1] = "different-vite-input";
        },
      ]) {
        const changed = structuredClone(changedRuntimeHelper);
        change(changed);
        expect(await reusableArtifact(manifest, changed, binary)).toBeUndefined();
      }
      await writeFile(binary, "replaced-during-helper-repair");
      expect(await reusableArtifact(manifest, changedRuntimeHelper, binary)).toBeUndefined();
      await recordBuiltArtifact(manifest, contract, binary);
      await writeFile(binary, "executable-two");
      expect(await reusableArtifact(manifest, contract, binary)).toBeUndefined();
      await rm(binary);
      expect(await reusableArtifact(manifest, contract, binary)).toBeUndefined();
      await expect(recordBuiltArtifact(manifest, contract, binary)).rejects.toThrow(
        "did not produce",
      );
      await writeFile(manifest, "{truncated");
      expect(await reusableArtifact(manifest, contract, binary)).toBeUndefined();
      await writeFile(manifest, "null");
      expect(await reusableArtifact(manifest, contract, binary)).toBeUndefined();
      await writeFile(binary, "actual");
      const link = path.join(directory, "link");
      await symlink(binary, link);
      await expect(fileIdentity(link)).rejects.toThrow("not a regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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

  it("requires an eligible full-width row and leaves the following blank row unpainted", () => {
    expect(() =>
      assertSnakeDisplayState({
        eligibleBackground: "rgba(17, 34, 51, 0.498)",
        eligibleRgba: [17, 34, 51, 127],
        eligibleWidth: 800,
        viewportWidth: 800,
        blankText: "",
        blankBackground: "rgb(0, 0, 0)",
        blankRgba: [0, 0, 0, 255],
      }),
    ).not.toThrow();
    expect(() =>
      assertSnakeDisplayState({
        eligibleBackground: "rgba(17, 34, 51, 0.498)",
        eligibleRgba: [16, 34, 50, 127],
        eligibleWidth: 800,
        viewportWidth: 800,
        blankText: "",
        blankBackground: "rgba(0, 0, 0, 0)",
        blankRgba: [0, 0, 0, 0],
      }),
    ).not.toThrow();
    expect(() =>
      assertSnakeDisplayState({
        eligibleBackground: "rgba(17, 34, 51, 0.498)",
        eligibleRgba: [15, 34, 51, 127],
        eligibleWidth: 800,
        viewportWidth: 800,
        blankText: "",
        blankBackground: "rgba(0, 0, 0, 0)",
        blankRgba: [0, 0, 0, 0],
      }),
    ).toThrow("was not projected");
    expect(() =>
      assertSnakeDisplayState({
        eligibleBackground: "rgb(0, 0, 0)",
        eligibleRgba: [0, 0, 0, 255],
        eligibleWidth: 800,
        viewportWidth: 800,
        blankText: "",
        blankBackground: "rgb(0, 0, 0)",
        blankRgba: [0, 0, 0, 255],
      }),
    ).toThrow("was not projected");
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
      const displayState = {
        eligibleBackground: "rgba(17, 34, 51, 0.498)",
        eligibleRgba: [17, 34, 51, 127],
        eligibleWidth: 800,
        viewportWidth: 800,
        blankText: "",
        blankBackground: "rgb(0, 0, 0)",
        blankRgba: [0, 0, 0, 255],
      };
      const browser = {
        capabilities: { browserName },
        keys: vi.fn(async () => undefined),
        execute: vi.fn(async (callback) => {
          if (states.length === 0) return displayState;
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

      await expect(runSnakeDataClient(browser, bridgeKind)).resolves.toEqual({
        ...complete,
        displayState,
      });
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
      expect(browser.execute).toHaveBeenCalledTimes(4);
    },
  );
});

describe("snake service client prompt submission", () => {
  it("observes actual native prompt text and focus before moving the pointer", async () => {
    document.body.innerHTML = '<form class="prompt-bar"><input></form>';
    const element = document.querySelector("input");
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const input = { waitForEnabled: vi.fn(), setValue: vi.fn() };
    const browser = {
      execute: async (read) => read(),
      waitUntil: async (ready) => {
        expect(await ready()).toBe(false);
        element.value = "2";
        element.focus();
        expect(await ready()).toBe(true);
      },
    };
    try {
      await setLifecyclePrompt(browser, input, "2");
      expect(input.setValue).toHaveBeenCalledExactlyOnceWith("2");
      browser.waitUntil = async (ready, options) => {
        element.value = "";
        expect(await ready()).toBe(false);
        throw new Error(options.timeoutMsg);
      };
      await expect(setLifecyclePrompt(browser, input, "2")).rejects.toThrow('actual={"value":""');
    } finally {
      focused.mockRestore();
      document.body.innerHTML = "";
    }
  });

  it.each([
    ["firefox", "41"],
    ["safari", "41"],
    ["wry", "41"],
    ["wry", ""],
  ])(
    "uses real prompt actions on %s and preserves button expectation %s",
    async (browserName, buttonValue) => {
      document.body.innerHTML =
        '<main class="game-viewport"><button aria-label="SNAKE_POINTER_TARGET">SNAKE_POINTER_TARGET</button></main>';
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
          output: [
            ...SNAKE_SERVICE_MARKERS,
            `SNAKE_POINTER=1/-2/${buttonValue}`,
            "SNAKE_SERVICES_READY",
          ],
          serviceEvidence: {
            sessionGeneration: 1,
            records: [
              {
                index: 0,
                message: {
                  type: "service_request",
                  value: {
                    request_id: "7",
                    kind: "input_state",
                    operation: "pointer_state",
                  },
                },
              },
            ],
            pointerSamples: [{ requestId: "7", context: { presentationRevision: "3" } }],
          },
        },
      ].map((state) => ({ ...state, bridgeKind: "browser" }));
      let stage = 0;
      window.__RUSTYERA_TEST__ = { snapshot: () => states[stage] };
      const input = { waitForDisplayed: vi.fn(), waitForEnabled: vi.fn(), setValue: vi.fn() };
      const submit = {
        click: vi.fn(() => {
          stage = 1;
        }),
      };
      const target = {
        waitForDisplayed: vi.fn(),
        waitForEnabled: vi.fn(),
        moveTo: vi.fn(() => {
          expect(window.__RUSTYERA_POINTER_OBSERVATION__).toBeTypeOf("function");
        }),
        click: vi.fn(() => {
          stage = 2;
        }),
      };
      const browser = {
        capabilities: { browserName },
        keys: vi.fn(() => {
          stage = 1;
        }),
        execute: vi.fn(async (callback, ...args) => callback(...args)),
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
      if (buttonValue) await runSnakeServicesClient(browser, "browser");
      else {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await expect(runSnakeServicesClient(browser, "browser")).rejects.toThrow(
            "script value 41",
          );
          expect(log).toHaveBeenCalledOnce();
          const report = JSON.parse(log.mock.calls[0][0]);
          expect(report.type).toBe("snake-services-pointer-failure");
          expect(report.evidence.beforeClick.observation.targetSelector).toBe(
            '.game-viewport button[aria-label="SNAKE_POINTER_TARGET"]',
          );
          expect(report.evidence.afterClick.target.label).toBe("SNAKE_POINTER_TARGET");
          expect(report.evidence.failure.state.serviceEvidence).toEqual(states[2].serviceEvidence);
        } finally {
          log.mockRestore();
        }
      }
      expect(window.__RUSTYERA_POINTER_OBSERVATION__).toBeUndefined();
      expect(window.__RUSTYERA_SERVICE_TRACE__).toBeUndefined();
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
    },
  );
});

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

  it("waits past retained old prompts and new-session loading until a fresh integer wait", () => {
    const previous = { sessionGeneration: 4, epoch: "20" };
    const oldReady = {
      ...state(),
      projectLoading: false,
      canInteract: true,
      wait: { kind: "integer_value" },
      output: ["SNAKE_LIFECYCLE_START"],
    };
    expect(lifecycleRestartReady(oldReady, previous)).toBe(false);
    const newReady = {
      ...oldReady,
      // Restart may reuse the numeric epoch, so session generation must remain part of identity.
      serviceEvidence: { ...oldReady.serviceEvidence, sessionGeneration: 5 },
    };
    expect(lifecycleRestartReady({ ...newReady, projectLoading: true }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, canInteract: false }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, wait: { kind: "void" } }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, output: [] }, previous)).toBe(false);
    expect(lifecycleRestartReady(newReady, previous)).toBe(true);
    // The first restart precedes arming the image gate, so decoder observations are not enabled.
    const beforeGate = {
      ...newReady,
      serviceLifecycle: { enabled: false, failure: null, records: [] },
    };
    expect(lifecycleSession(beforeGate)).toEqual({ sessionGeneration: 5, epoch: "20" });
    expect(lifecycleRestartReady(beforeGate, previous)).toBe(true);
    expect(() => observePendingCanvas(beforeGate, sourceUrl, 7)).toThrow(
      "complete real lifecycle/transport evidence",
    );
    for (const invalid of [
      { ...beforeGate, runtimeEpoch: undefined },
      { ...beforeGate, serviceEvidence: { ...beforeGate.serviceEvidence, enabled: false } },
      { ...beforeGate, serviceEvidence: { ...beforeGate.serviceEvidence, overflow: true } },
    ])
      expect(() => lifecycleSession(invalid)).toThrow("transport session evidence");
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
