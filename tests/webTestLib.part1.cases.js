import {
  SNAKE_DATA_MARKERS,
  TraceWriter,
  assertAtomicPresentationTransition,
  assertAnimationPerformance,
  assertSampleExpectations,
  compactTraceEvent,
  describe,
  expect,
  focusNativeBrowser,
  goalStatus,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  installRemoteFileSystem,
  it,
  loadScenario,
  mkdtemp,
  measureAnimationPerformance,
  nativeFirefoxCapabilities,
  path,
  readFile,
  rm,
  runAction,
  runInNewContext,
  snakeAudioRelations,
  snakeAudioStressRelations,
  tmpdir,
  vi,
  waitForWebDriverDocument,
  writeFile,
} from "./webTestLib.testHarness";

describe("web game test scenario", () => {
  it("preserves explicit initial wait pacing and rejects non-boolean overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-initial-wait-"));
    try {
      const file = path.join(root, "scenario.json");
      const scenario = {
        schema_version: 1,
        project: ".",
        mode: "fixed",
        initial_auto_enter: false,
      };
      await writeFile(file, JSON.stringify(scenario));
      expect((await loadScenario(file)).initial_auto_enter).toBe(false);
      await writeFile(file, JSON.stringify({ ...scenario, initial_auto_enter: "false" }));
      await expect(loadScenario(file)).rejects.toThrow("initial_auto_enter must be a boolean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires every animation frame to publish and synchronize within the script cadence", () => {
    const revisions = [10, 12, 14, 16];
    const publishes = revisions.map((revision, index) => ({
      phase: "presentation",
      operation: "publish",
      startedAtMs: index * 28,
      elapsedMs: 1,
      detail: { presentationRevision: String(revision) },
    }));
    const mutations = revisions.map((revision, index) => ({
      phase: "dom_mutation",
      operation: "observer_callback",
      startedAtMs: index * 28 + 1,
      elapsedMs: 0,
      detail: { presentationRevision: String(revision) },
    }));
    const paint = {
      phase: "next_paint",
      operation: "presentation",
      startedAtMs: 0,
      elapsedMs: 20,
      detail: { timedOut: false },
    };
    const audit = { timingSamplesDropped: 0, timings: [...publishes, ...mutations, paint] };
    const limits = { minimumFrames: 4, maximumFrameIntervalMs: 33, maximumPaintMs: 33 };

    expect(assertAnimationPerformance(audit, limits)).toMatchObject({
      frames: 4,
      maximumIntervalMs: 28,
      revisionStep: "2",
      domSynchronizedFrames: 4,
    });
    expect(measureAnimationPerformance(audit)).toMatchObject({
      frames: 4,
      averageIntervalMs: 28,
      medianIntervalMs: 28,
      maximumIntervalMs: 28,
      revisionStep: "2",
      revisionStepConstant: true,
      domSynchronizedFrames: 4,
    });
    expect(() =>
      assertAnimationPerformance(
        {
          ...audit,
          timings: [
            publishes[0],
            { ...publishes[1], startedAtMs: 34 },
            { ...publishes[2], startedAtMs: 62 },
            { ...publishes[3], startedAtMs: 90 },
            ...mutations,
            paint,
          ],
        },
        limits,
      ),
    ).toThrow("frame interval");
    expect(() =>
      assertAnimationPerformance(
        {
          ...audit,
          timings: [
            publishes[0],
            publishes[1],
            { ...publishes[2], detail: { presentationRevision: "15" } },
            publishes[3],
            ...mutations,
            paint,
          ],
        },
        limits,
      ),
    ).toThrow("skipped a frame");
    expect(() =>
      assertAnimationPerformance(
        { ...audit, timings: [...publishes, ...mutations.slice(0, -1), paint] },
        limits,
      ),
    ).toThrow("did not reach the DOM");
    expect(() =>
      assertAnimationPerformance(
        {
          ...audit,
          timings: [...publishes, ...mutations, { ...paint, detail: { timedOut: true } }],
        },
        limits,
      ),
    ).toThrow("paint checkpoint timed out");
  });

  it("waits for a stable real-client observation without a fixed sleep", async () => {
    const stable = { phase: "waiting_input", canInteract: true };
    const page = { evaluate: vi.fn().mockResolvedValue(stable) };

    await expect(
      runAction(page, { type: "wait_stable_observation", timeout_ms: 12_000 }),
    ).resolves.toEqual({ state: stable });
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 12_000);
  });

  it("bounds sampled projection time and intervals between animated changes", () => {
    const sample = (at, duration, revision, signature) => ({
      runtime: {
        sampled_at_ms: at,
        sample_duration_ms: duration,
        presentation_revision: revision,
      },
      map: { content_signature: signature },
    });
    const samples = [
      sample(0, 20, 1, "a"),
      sample(250, 30, 2, "b"),
      sample(500, 25, 3, "c"),
      sample(750, 35, 4, "d"),
    ];
    const expected = {
      maximum_sample_duration_ms: 50,
      maximum_change_interval_ms: {
        "runtime.presentation_revision": 300,
        "map.content_signature": 300,
      },
    };

    expect(() => assertSampleExpectations(samples, expected)).not.toThrow();
    expect(() =>
      assertSampleExpectations(
        samples.map((entry) => ({ ...entry, map: { content_signature: "still" } })),
        expected,
      ),
    ).toThrow("maximum_change_interval_ms.map.content_signature");
    expect(() =>
      assertSampleExpectations(
        [
          { ...samples[0], runtime: { ...samples[0].runtime, sample_duration_ms: 75 } },
          ...samples.slice(1),
        ],
        expected,
      ),
    ).toThrow("maximum_sample_duration_ms");
  });

  it("finishes export cancellation when background cache generation resumes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-export-cancel-"));
    const evidencePath = path.join(root, "evidence.json");
    let dialog = false;
    let state = {
      memory: { wasmLinearMemoryBytes: 1234 },
      fault: null,
      canInteract: true,
      status: "background cache",
      transfer: { export: { name: "compiled-project.reracache" }, fullManifest: null },
    };
    const run = (callback) =>
      runInNewContext(`(${callback.toString()})()`, {
        window: {
          __RUSTYERA_TEST__: {
            snapshotSummary: () => state,
            protocolEvidence: () => ({
              failure: null,
              records: [{ direction: "send", message: { type: "state_transfer_cancel" } }],
            }),
          },
        },
        document: { querySelector: () => (dialog ? {} : null) },
      });
    const page = {
      evaluate: async (callback) => run(callback),
      waitForFunction: async (callback) => expect(run(callback)).toBe(true),
      locator: () => ({
        waitFor: async () => expect(dialog).toBe(true),
        click: async () => {
          dialog = true;
          state = {
            ...state,
            canInteract: false,
            transfer: {
              export: { name: "project.reraproj" },
              fullManifest: { submittedBytes: 8 * 1024 * 1024 },
            },
          };
        },
      }),
      getByRole: () => ({
        getByRole: () => ({
          click: async () => {
            dialog = false;
            state = {
              ...state,
              canInteract: true,
              transfer: { export: { name: "compiled-project.reracache" }, fullManifest: null },
            };
          },
        }),
      }),
    };
    try {
      await runAction(page, {
        type: "cancel_project_export",
        selector: "export",
        evidence_path: evidencePath,
      });
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      expect(evidence.status).toBe("passed");
      expect(evidence.samples.map((sample) => sample.phase)).toEqual([
        "before",
        "before-cancel",
        "cancel-submitted",
        "finished",
      ]);
      expect(evidence.samples.at(-1).transfer.export.name).toBe("compiled-project.reracache");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps complete snapshots in the file event while compacting console output", () => {
    const event = {
      type: "browser-game-snapshot",
      capturedAt: "2026-09-01T00:00:00Z",
      document: [{ tag: "html" }, { tag: "body" }],
      runtime: { phase: "waiting_input" },
    };

    expect(compactTraceEvent(event)).toEqual({
      ...event,
      document: { elementCount: 2 },
    });
    expect(event.document).toHaveLength(2);
  });

  it("streams complete snapshot elements without interleaving later trace events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-trace-writer-"));
    const tracePath = path.join(root, "trace.ndjson");
    const output = vi.spyOn(globalThis.process.stdout, "write").mockReturnValue(true);
    try {
      const writer = new TraceWriter(tracePath);
      const document = Array.from({ length: 130 }, (_, index) => ({
        tag: "span",
        attributes: { "data-index": String(index) },
        text: `cell-${index}`,
        value: null,
        visible: true,
      }));
      writer.emit({
        type: "browser-game-snapshot",
        capturedAt: "2026-09-01T00:00:00Z",
        document,
        runtime: { phase: "waiting_input" },
      });
      writer.emit({ type: "result", status: "input_exhausted" });
      await writer.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect(events[0].document).toEqual(document);
      expect(events[1]).toEqual({ type: "result", status: "input_exhausted" });
    } finally {
      output.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks state string prefixes separately from structural expectations", async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        fault: { code: "vm_fault", message: "rustyera.sql/open/invalid_source:6:reason=61" },
        output: [],
      })),
    };
    const action = {
      type: "assert_state",
      expect: { fault: { code: "vm_fault" }, output: [] },
      expect_prefix: { fault: { message: "rustyera.sql/open/invalid_source:" } },
    };

    await expect(runAction(page, action)).resolves.toMatchObject({ state: { output: [] } });
    action.expect_prefix.fault.message = "rustyera.sql/open/quota_exceeded:";
    await expect(runAction(page, action)).rejects.toThrow(
      "assertion failed at fault.message: expected prefix",
    );
  });

  it("checks ordinary runtime state without materializing protocol records", async () => {
    const state = { canInteract: true, wait: { stability: "stable_input" }, fault: null };
    const snapshot = vi.fn(() => {
      throw new Error("full protocol ledger must not be materialized");
    });
    const snapshotSummary = vi.fn(() => state);
    const page = {
      evaluate: (callback, argument) =>
        runInNewContext(`(${callback.toString()})(argument)`, {
          argument,
          window: { __RUSTYERA_TEST__: { snapshot, snapshotSummary } },
        }),
    };
    await expect(runAction(page, { type: "assert_state", expect: state })).resolves.toEqual({
      state,
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(snapshotSummary).toHaveBeenCalledOnce();
  });

  it.each([
    ["expect", "serviceEvidence"],
    ["expect_prefix", "serviceEvidence"],
    ["expect", "serviceLifecycle"],
    ["expect_prefix", "serviceLifecycle"],
  ])("retains full evidence for %s assertions on %s", async (assertion, field) => {
    const state = { [field]: { records: [{ message: "observed wire payload" }] } };
    const snapshot = vi.fn(() => state);
    const snapshotSummary = vi.fn(() => {
      throw new Error("an explicit evidence assertion requires full records");
    });
    const page = {
      evaluate: (callback, argument) =>
        runInNewContext(`(${callback.toString()})(argument)`, {
          argument,
          window: { __RUSTYERA_TEST__: { snapshot, snapshotSummary } },
        }),
    };
    const expected =
      assertion === "expect_prefix"
        ? { [field]: { records: { 0: { message: "observed wire" } } } }
        : state;
    await expect(runAction(page, { type: "assert_state", [assertion]: expected })).resolves.toEqual(
      {
        state,
      },
    );
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshotSummary).not.toHaveBeenCalled();
  });

  it.each(["safari", "firefox"])(
    "selects %s without OS activation or document focus assertions",
    async (name) => {
      const browser = {
        getWindowHandle: vi.fn(async () => "automation"),
        switchToWindow: vi.fn(async () => {}),
        execute: vi.fn(() => {
          throw new Error("document is locked");
        }),
        waitUntil: vi.fn(),
        action: vi.fn(),
      };
      await focusNativeBrowser(browser, name);
      expect(browser.switchToWindow).toHaveBeenCalledWith("automation");
      expect(browser.execute).not.toHaveBeenCalled();
      expect(browser.waitUntil).not.toHaveBeenCalled();
      expect(browser.action).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported browser contexts and failed context switches", async () => {
    const browser = {
      getWindowHandle: vi.fn(async () => "automation"),
      switchToWindow: vi.fn(async () => {
        throw new Error("switch");
      }),
    };
    await expect(focusNativeBrowser(browser, "unknown")).rejects.toThrow("unsupported");
    expect(browser.getWindowHandle).not.toHaveBeenCalled();
    await expect(focusNativeBrowser(browser, "safari")).rejects.toThrow("switch");
  });

  it("rejects a missing remote directory before storage traversal starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-remote-directory-"));
    const remoteWindow = {};
    try {
      await writeFile(path.join(root, "file.txt"), "resource");
      await installRemoteFileSystem(
        {
          exposeBinding: async (name, callback) => {
            remoteWindow[name] = (request) => callback({}, request);
          },
          addInitScript: async (initialize) => {
            runInNewContext(`(${initialize.toString()})()`, {
              window: remoteWindow,
              DOMException: globalThis.DOMException,
            });
          },
        },
        root,
      );
      const directory = await remoteWindow.showDirectoryPicker();
      await expect(directory.getDirectoryHandle("data")).rejects.toMatchObject({
        name: "NotFoundError",
      });
      await expect(directory.getDirectoryHandle("file.txt")).rejects.toMatchObject({
        name: "TypeMismatchError",
      });
      const created = await directory.getDirectoryHandle("data", { create: true });
      expect(created.kind).toBe("directory");
      await expect(directory.getDirectoryHandle("data")).resolves.toMatchObject({
        kind: "directory",
        name: "data",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires all data integration stages after the visible startup input", async () => {
    const scenario = await loadScenario("tools/runtime-tester/scenarios/snake-data.json");
    expect(scenario.actions).toEqual([
      { type: "input", value: "1", when: { output_contains: "SNAKE_DATA_START" } },
    ]);
    const observation = { output: [...SNAKE_DATA_MARKERS], wait: { kind: "integer_value" } };
    expect(goalStatus(observation, scenario.goal).satisfied).toBe(true);
    expect(
      goalStatus({ ...observation, output: ["SNAKE_DATA_READY"] }, scenario.goal).satisfied,
    ).toBe(false);
    expect(goalStatus({ ...observation, wait: { kind: "any_key" } }, scenario.goal).satisfied).toBe(
      false,
    );
  });

  it("checks snake audio values as relations and requires released provider targets", () => {
    const output = [
      "playing=0,sound_play_duration=5000,sound_play_position=300,volume=37",
      "omitted=5000,r0=5000,r1=301,r2=1,r3=37,r4=100",
      "paused_is=-1,pause_pos_a=320,pause_pos_b=321",
      "resumed_is=0,resume_pos=600",
      "rate_omitted=1,speed=250,pitch_zero=1,pitch_nonzero=1",
      "all_busy_overwrite_0_duration=750",
      "paused_reused_3_duration=750",
      "short_natural_state=-1,duration=0,position=0",
      "corrupt_decode_continued=1",
      "final_pitch_nonzero=1",
      "bgm_playing=1,bgm_duration=5000",
      "bgm_paused=0,pos_a=250,pos_b=251",
      "bgm_rate_omitted=1,bgm_pitch_zero=1,bgm_pitch_nonzero=1,bgm_resumed=1,bgm_speed=250",
    ];
    const target = {
      resourceId: null,
      pending: false,
      state: "stopped",
      revision: 30,
      rateMillionths: 1_000_000,
      preservePitch: true,
      failure: null,
    };
    const observation = {
      output,
      frontend: {
        audioProvider: Object.fromEntries(
          [...Array(10).keys()]
            .map((index) => [`sound:${index}`, target])
            .concat([["bgm", target]]),
        ),
        audioPlayback: { "sound/batch5-short.wav": { starts: 2, active: 0 } },
        memory: { audioBuffers: { count: 0, estimatedBytes: 0 } },
        logs: [{ message: "frontend.audio_decode_failed: corrupt" }],
      },
    };
    observation.frontend.audioProvider["sound:0"] = {
      ...target,
      rateMillionths: 2_500_000,
      preservePitch: false,
    };

    expect(Object.values(snakeAudioRelations(observation))).not.toContain(false);
    observation.frontend.audioProvider["sound:3"] = { ...target, pending: true };
    expect(snakeAudioRelations(observation)["snake_audio:provider_released"]).toBe(false);
  });

  it("checks the combined snake audio stress outcome and exact playback counts", () => {
    const target = {
      resourceId: null,
      pending: false,
      state: "stopped",
      revision: 30,
      failure: null,
    };
    const observation = {
      output: [
        "stress_channels=0,1,2,3,4,5,6,7,8,9",
        "stress_overwrite_duration=750",
        "stress_bgm=1,duration=5000",
        "BATCH5_STRESS_DONE",
      ],
      frontend: {
        audioProvider: Object.fromEntries(
          [...Array(10).keys()]
            .map((index) => [`sound:${index}`, target])
            .concat([["bgm", target]]),
        ),
        audioPlayback: {
          "sound/batch5-long.wav": { starts: 11, active: 0 },
          "sound/batch5-short.wav": { starts: 1, active: 0 },
        },
        memory: { audioBuffers: { count: 0, estimatedBytes: 0 } },
        logs: [{ message: "frontend.audio_decode_failed: corrupt" }],
      },
    };

    expect(Object.values(snakeAudioStressRelations(observation))).not.toContain(false);
    observation.frontend.audioPlayback["sound/batch5-long.wav"].active = 1;
    expect(snakeAudioStressRelations(observation)["snake_audio_stress:playback_released"]).toBe(
      false,
    );
  });

  it("accepts only the starting and completed presentation revisions across painted frames", () => {
    const samples = [
      {
        revision: "10",
        historyRevision: "10",
        waitId: "4",
        canInteract: true,
        outputTail: ["command"],
      },
      {
        revision: "10",
        historyRevision: "10",
        waitId: null,
        canInteract: false,
        outputTail: ["command"],
      },
      {
        revision: "14",
        historyRevision: "14",
        waitId: "5",
        canInteract: true,
        outputTail: ["complete"],
      },
    ];
    const completed = { revision: "14", historyRevision: "14" };

    expect(assertAtomicPresentationTransition(samples, completed)).toMatchObject({
      startRevision: "10",
      endRevision: "14",
      paintedRevisions: ["10", "14"],
    });
    expect(() =>
      assertAtomicPresentationTransition(
        [
          samples[0],
          samples[1],
          {
            revision: "12",
            historyRevision: "12",
            waitId: null,
            canInteract: false,
            outputTail: ["incomplete"],
          },
          samples[2],
        ],
        completed,
      ),
    ).toThrow("painted intermediate history revisions");
    expect(() => assertAtomicPresentationTransition(samples.slice(0, 2), completed)).toThrow(
      "did not paint completed revision",
    );
    expect(() =>
      assertAtomicPresentationTransition(samples.slice(0, 2), {
        revision: "10",
        historyRevision: "10",
      }),
    ).toThrow("did not advance");
  });

  it.each(["\n", "\r\n"])("injects the save flow using the fixture's %j newline", (newline) => {
    const source = `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}RETURN${newline}`;

    expect(injectInGameSaveFlow(source)).toBe(
      `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}SAVEGAME${newline}RETURN${newline}${newline}@SAVEINFO${newline}SAVEDATA_TEXT = "browser game save"${newline}RETURN${newline}`,
    );
  });

  it.each(["\n", "\r\n"])(
    "injects an interaction-assist button using the fixture's %j newline",
    (newline) => {
      const source = `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}INPUT${newline}RETURN${newline}`;

      expect(injectInteractionAssistFlow(source)).toBe(
        `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}$RUSTYERA_INTERACTION_ASSIST_WAIT${newline}PRINTBUTTON "ASSISTED_ACTION", 0${newline}INPUT${newline}GOTO RUSTYERA_INTERACTION_ASSIST_WAIT${newline}INPUT${newline}RETURN${newline}`,
      );
      expect(injectInteractionAssistFlow(`PRINTL ORACLE_READY${newline}SAVEGAME${newline}`)).toBe(
        `PRINTL ORACLE_READY${newline}SAVEGAME${newline}$RUSTYERA_INTERACTION_ASSIST_WAIT${newline}PRINTBUTTON "ASSISTED_ACTION", 0${newline}INPUT${newline}GOTO RUSTYERA_INTERACTION_ASSIST_WAIT${newline}`,
      );
      expect(() => injectInteractionAssistFlow("@SYSTEM_TITLE\nINPUT\n")).toThrow(
        "lacks ORACLE_READY",
      );
      expect(() => injectInteractionAssistFlow(injectInteractionAssistFlow(source))).toThrow(
        "already exposes",
      );
    },
  );

  it.each(["win32", "linux"])("lets WebDriver discover Firefox on %s", (platform) => {
    const capabilities = nativeFirefoxCapabilities(platform);
    expect(capabilities.webSocketUrl).toBeUndefined();
    expect(capabilities.pageLoadStrategy).toBe("none");
    expect(capabilities["wdio:enforceWebDriverClassic"]).toBe(true);
    expect(capabilities["wdio:geckodriverOptions"]).toEqual({
      binary: path.resolve(".rustyera", "webdriver", "geckodriver-0.37.1"),
      geckoDriverVersion: "0.37.1",
    });
    expect(capabilities["moz:firefoxOptions"]).toEqual({
      args: ["-headless"],
    });
  });

  it.each([true, false])("uses native Firefox on macOS with headless=%s", (headless) => {
    const capabilities = nativeFirefoxCapabilities("darwin", { headless });
    expect(capabilities.webSocketUrl).toBeUndefined();
    expect(capabilities.pageLoadStrategy).toBe("none");
    expect(capabilities["wdio:enforceWebDriverClassic"]).toBe(true);
    expect(capabilities["wdio:geckodriverOptions"]).toEqual({
      binary: path.resolve(".rustyera", "webdriver", "geckodriver-0.37.1"),
      geckoDriverVersion: "0.37.1",
    });
    expect(capabilities["moz:firefoxOptions"]).toEqual({
      args: headless ? ["-headless"] : [],
      binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
    });
  });

  it("waits for the target WebDriver document instead of accepting about:blank", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ url: "about:blank", readyState: "complete" })
      .mockResolvedValueOnce({ url: "http://127.0.0.1:4173/", readyState: "interactive" });

    await expect(
      waitForWebDriverDocument({ execute }, "http://127.0.0.1:4173", {
        timeoutMs: 1_000,
        stage: "test navigation",
      }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4173/",
      readyState: "interactive",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("resizes the real Chromium layout viewport through a declared action", async () => {
    const page = { evaluate: vi.fn(async () => undefined), setViewportSize: vi.fn() };

    await expect(
      runAction(page, { type: "set_viewport", width: 600, height: 800 }),
    ).resolves.toEqual({ query: { viewport: { width: 600, height: 800 } } });
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 600, height: 800 });
    expect(page.evaluate).toHaveBeenCalledOnce();
    await expect(runAction(page, { type: "set_viewport", width: 0, height: 800 })).rejects.toThrow(
      "positive integer",
    );
  });

  it("validates and preserves declared touch capability", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-touch-scenario-"));
    const scenario = path.join(directory, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        schema_version: 1,
        mode: "fixed",
        project: ".",
        has_touch: true,
        limits: { max_steps: 1, timeout_seconds: 1 },
      }),
    );
    await expect(loadScenario(scenario)).resolves.toMatchObject({ has_touch: true });

    await writeFile(
      scenario,
      JSON.stringify({
        schema_version: 1,
        mode: "fixed",
        project: ".",
        has_touch: "yes",
      }),
    );
    await expect(loadScenario(scenario)).rejects.toThrow("has_touch must be a boolean");
  });

  it("drives declared gestures through real Chromium touch input", async () => {
    const send = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const locator = {
      boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 80 })),
    };
    const page = {
      locator: vi.fn(() => locator),
      context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({ send, detach })) })),
      waitForTimeout: vi.fn(async () => undefined),
    };

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "two_finger_tap",
        locator: { css: ".game-viewport" },
      }),
    ).resolves.toEqual({ semanticInput: undefined });
    expect(send).toHaveBeenNthCalledWith(1, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 42, y: 60, id: 1, radiusX: 8, radiusY: 8, force: 1 },
        { x: 78, y: 60, id: 2, radiusX: 8, radiusY: 8, force: 1 },
      ],
    });
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(80);
    expect(detach).toHaveBeenCalledOnce();

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "unsupported",
        locator: { css: ".game-viewport" },
      }),
    ).rejects.toThrow("requires two_finger_tap or long_press");
  });

  it("releases Chromium touch input when a gesture action fails", async () => {
    const failure = new Error("gesture wait failed");
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("touch cleanup failed"));
    const detach = vi.fn(async () => undefined);
    const page = {
      locator: vi.fn(() => ({
        boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 80 })),
      })),
      context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({ send, detach })) })),
      waitForTimeout: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "long_press",
        locator: { css: ".game-viewport" },
      }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(detach).toHaveBeenCalledOnce();
  });
});
