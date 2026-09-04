import {
  SNAKE_DATA_MARKERS,
  SNAKE_DATA_START,
  SNAKE_SERVICE_MARKERS,
  assertSnakeDataState,
  assertSnakeDisplayState,
  assertStructuredSnakeProfileNotifications,
  compiledBuildInputs,
  describe,
  expect,
  fileIdentity,
  it,
  mkdtemp,
  path,
  recordBuiltArtifact,
  reusableArtifact,
  reusableBuildEnvironment,
  rm,
  runSnakeDataClient,
  runSnakeServicesClient,
  setLifecyclePrompt,
  symlink,
  tmpdir,
  vi,
  writeFile,
} from "./tauriTestSupport.testHarness";

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
    expect(reusableBuildEnvironment(first, "snake-audio.spec.mjs", undefined, true)).toEqual(
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
          ["scripts/web-test-runtime.mjs", "old-runtime-observer"],
          ["scripts/prepare-snake-audio-fixture.mjs", "old-audio-fixture-builder"],
          ["scripts/web-test-lib.d.mts", "old-node-helper-types"],
          ["scripts/project-export-cancel.mjs", "old-export-observer"],
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
      expect(compiledBuildInputs(changedHarness.inputs)).toEqual(compiledBuildInputs(inputs));
      const changedRuntimeHelper = structuredClone(changedHarness);
      changedRuntimeHelper.sha256 = "changed-runtime-helper";
      changedRuntimeHelper.inputs.webSources[2][1] = "native-foreground-precondition";
      changedRuntimeHelper.inputs.webSources[4][1] = "transport-identity-before-image-gate";
      expect(await reusableArtifact(manifest, changedRuntimeHelper, binary)).toBeDefined();
      for (const index of [5, 6, 7, 8, 9, 10, 11, 12]) {
        const changedNodeHelper = structuredClone(changedRuntimeHelper);
        changedNodeHelper.inputs.webSources[index][1] = "node-only-observation-or-foreground";
        expect(compiledBuildInputs(changedNodeHelper.inputs)).toEqual(compiledBuildInputs(inputs));
        expect(await reusableArtifact(manifest, changedNodeHelper, binary)).toBeDefined();
      }
      const changedApp = structuredClone(changedRuntimeHelper);
      changedApp.inputs.webSources[1][1] = "different-app";
      expect(compiledBuildInputs(changedApp.inputs)).not.toEqual(compiledBuildInputs(inputs));
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
        expect(compiledBuildInputs(changed.inputs)).not.toEqual(compiledBuildInputs(inputs));
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
