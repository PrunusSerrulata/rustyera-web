import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import type { ProjectOpenMetrics } from "@/core/types";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  deferred,
  emptyBatch,
  flushMicrotasks,
  mockProjectSelection,
  runningBrowserStore,
  stubRunningAudioContext,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";

describe("runtime store startup-save", () => {
  installRuntimeStoreTestHarness();

  it("uses the runtime-reported core product version", async () => {
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("server_hello", { implementation_version: "9.8.7" })],
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.coreVersion).toBe(`9.8.7 (${import.meta.env.VITE_RUSTYERA_CORE_REVISION})`);
  });

  it("advances deadline waits from the frontend monotonic clock without user input", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    const wait = {
      kind: "void",
      wait_id: 17,
      submission_token: { epoch: 2, id: 4 },
      deadline_ns: 11_000_000,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("wait_changed", { type: "opened", value: wait }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
      });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "new_game", seed: 42 },
      monotonicStartNs: 1_000_000,
    });

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "advance_time",
        value: { monotonic_time_ns: 17_000_000 },
      },
      undefined,
    );
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );

    await vi.advanceTimersByTimeAsync(32);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        (call) => (call as unknown as [{ type?: string }])[0]?.type === "advance_time",
      ),
    ).toHaveLength(1);
  });

  it("imports a traditional save before starting the test runtime", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: true,
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
    });
    let accepted = false;
    let ready = false;
    bridge.pump.mockImplementation(async () => {
      const commands = bridge.submitRuntime.mock.calls.map(
        ([message]: unknown[]) => (message as { type?: string }).type,
      );
      if (!accepted && commands.includes("state_import_begin")) {
        accepted = true;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("state_import_accepted", { transfer_id: 9 })],
        };
      }
      if (!ready && commands.includes("state_import_commit")) {
        ready = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("state_import_ready", { transfer_id: 9, kind: "traditional_save" }),
          ],
        };
      }
      return emptyBatch();
    });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "traditional_save", bytes: new Uint8Array([1, 2, 3]) },
    });

    await store.enableDebug();
    await advanceUntil(() =>
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) => (message as { type?: string }).type === "start",
      ),
    );

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_import_begin",
        value: expect.objectContaining({ kind: "traditional_save", total_bytes: 3 }),
      }),
      undefined,
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "start", value: { mode: { type: "traditional_save", transfer_id: 9 } } },
      undefined,
    );
  });

  it("exports only an occupied browser save slot", async () => {
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("export");
    expect(store.traditionalSaveSlots).toEqual([
      { slot: 0, occupied: false },
      { slot: 1, occupied: true },
    ]);

    await store.confirmTraditionalSaveTransfer(0);
    expect(bridge.traditionalSaves.exportSlot).not.toHaveBeenCalled();

    await store.confirmTraditionalSaveTransfer(1);
    expect(bridge.traditionalSaves.exportSlot).toHaveBeenCalledWith(1);
    expect(store.status).toBe("已导出 save01.sav");
    expect(store.traditionalSaveDialogMode).toBeNull();
  });

  it("validates an imported save before asking to overwrite an occupied slot", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    bridge.traditionalSaves.pickImport.mockResolvedValue({ name: "incoming.sav", bytes });
    bridge.traditionalSaves.listSlots
      .mockResolvedValueOnce([{ slot: 0, occupied: true }])
      .mockResolvedValueOnce([{ slot: 0, occupied: true }]);
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("import");
    await store.pickTraditionalSaveImport();
    await store.confirmTraditionalSaveTransfer(0);

    expect(bridge.traditionalSaves.inspect).toHaveBeenCalledWith(bytes);
    expect(bridge.traditionalSaves.writeSlot).not.toHaveBeenCalled();
    expect(store.traditionalSaveOverwriteSlot).toBe(0);

    await store.confirmTraditionalSaveOverwrite();

    expect(bridge.traditionalSaves.writeSlot).toHaveBeenCalledWith(0, bytes);
    expect(store.status).toBe("已导入 save00.sav");
    expect(store.traditionalSaveDialogMode).toBeNull();
  });

  it("keeps the import dialog open when runtime validation rejects a save", async () => {
    bridge.traditionalSaves.pickImport.mockResolvedValue({
      name: "broken.sav",
      bytes: Uint8Array.of(9),
    });
    bridge.traditionalSaves.inspect.mockRejectedValue(new Error("traditional save is invalid"));
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("import");
    await store.pickTraditionalSaveImport();
    await store.confirmTraditionalSaveTransfer(0);

    expect(bridge.traditionalSaves.writeSlot).not.toHaveBeenCalled();
    expect(store.traditionalSaveTransferError).toContain("traditional save is invalid");
    expect(store.traditionalSaveDialogMode).toBe("import");
  });

  it("recreates the runtime and reopens the same project for Restart", async () => {
    bridge.kind = "browser";
    bridge.listFonts.mockResolvedValue({ kind: "ready", fonts: ["Late Browser Font"] });
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.projectSource = "file";
    bridge.restartProject.mockImplementationOnce(async () => {
      expect(store.startupTelemetry).toMatchObject({
        outcome: "loading",
        client: "browser",
        selection: "file",
      });
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 1,
        cacheReadMs: 2,
        sourceReadMs: 0,
        submitMs: 3,
        cacheImported: true,
      };
    });

    await store.restart();

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.createSession.mock.calls[0]![0].availableFonts).toEqual([
      "system-ui",
      "sans-serif",
      "serif",
      "monospace",
    ]);
    await store.requestSystemFonts();
    expect(store.systemFonts).toEqual(["Late Browser Font"]);
    expect(bridge.createSession.mock.calls[0]![0].availableFonts).toEqual([
      "system-ui",
      "sans-serif",
      "serif",
      "monospace",
    ]);
    expect(bridge.restartProject).toHaveBeenCalledOnce();
    expect(store.projectSource).toBe("file");
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" }),
      expect.anything(),
    );
  });

  it("requires explicit confirmation before restarting or returning to the title", async () => {
    stubRunningAudioContext();
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
    });
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 3,
      submitMs: 4,
      cacheImported: true,
    });
    const store = useRuntimeStore();
    await store.openProject();
    store.projectLoading = false;

    store.requestRestart();
    await store.openProject();
    await store.confirmOpenProject();
    expect(store.gameProgressLossConfirmation).toBeNull();
    await store.confirmGameProgressLossAction();
    expect(bridge.restartProject).not.toHaveBeenCalled();

    store.phase = "waiting_input";
    store.projectLoading = false;
    store.requestRestart();
    expect(store.gameProgressLossConfirmation).toBe("restart");
    store.cancelGameProgressLossAction();
    expect(store.gameProgressLossConfirmation).toBeNull();
    expect(bridge.restartProject).not.toHaveBeenCalled();

    store.requestRestart();
    await store.confirmGameProgressLossAction();
    expect(store.gameProgressLossConfirmation).toBeNull();
    expect(bridge.restartProject).toHaveBeenCalledOnce();

    store.phase = "waiting_input";
    store.projectLoading = false;
    store.requestReturnToTitle();
    expect(store.gameProgressLossConfirmation).toBe("title");
    store.cancelGameProgressLossAction();
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "return_to_title" }),
    );

    store.requestReturnToTitle();
    await store.confirmGameProgressLossAction();
    expect(store.gameProgressLossConfirmation).toBeNull();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ type: "return_to_title", value: {} }),
      undefined,
    );
  });

  it("confirms project replacement, clears the viewport, and blocks opening through compilation", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        resume = vi.fn(async () => {});
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        bridge.projectProgressListener?.({ stage: "scanning", completed: 3, total: 4 });
        return {
          submittedAtMs: 0,
          quickScanMs: 1,
          cacheReadMs: 2,
          sourceReadMs: 3,
          submitMs: 4,
          cacheImported: true,
        };
      },
    );
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.projectSource = "file";
    store.presentation.lines.push({ id: "old-line", runs: [] } as any);

    await store.openProject();

    expect(store.openProjectConfirmationOpen).toBe(true);
    expect(bridge.openProject).not.toHaveBeenCalled();

    store.cancelOpenProject();
    expect(store.openProjectConfirmationOpen).toBe(false);
    expect(store.presentation.lines).toHaveLength(1);
    expect(store.projectOpen).toBe(true);
    expect(store.projectSource).toBe("file");

    await store.openProject();

    const replacement = store.confirmOpenProject();
    expect(store.openProjectConfirmationOpen).toBe(false);
    expect(store.presentation.lines).toHaveLength(0);
    expect(store.projectLoading).toBe(false);
    expect(store.canOpenProject).toBe(false);
    await replacement;

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.openProject).toHaveBeenCalledOnce();
    expect(store.projectOpen).toBe(true);
    expect(store.projectSource).toBe("directory");
    expect(store.projectLoading).toBe(true);
    expect(store.canOpenProject).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("项目缓存命中，正在加载缓存…");
    expect(store.projectLoadProgressValue).toBeUndefined();

    bridge.projectProgressListener?.({
      stage: "compiling",
      completed: 0,
      total: 10,
      elapsedMs: 10,
    });
    bridge.projectProgressListener?.({ stage: "compiling", completed: 7, total: 10 });
    expect(store.projectLoadProgressLabel).toBe("正在编译脚本函数：7/10（70%）");
    expect(store.projectLoadProgressValue).toBe(70);
    bridge.projectProgressListener?.({
      stage: "compiling",
      completed: 10,
      total: 10,
      elapsedMs: 60,
    });
    bridge.projectProgressListener?.({ stage: "validating", completed: 1, total: 2 });
    expect(store.startupTelemetry?.durations.compileMs).toBe(50);
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%）");
    expect(store.projectLoadProgressValue).toBe(50);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%） · 已等待 5 秒");

    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("project_load_report", {
            success: true,
            diagnostics: [
              { code: "runtime.compiled_cache_hit", level: "info", message: "cache hit" },
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_external", epoch: 2 })],
      });
    await advanceUntil(() => store.startupTelemetry?.outcome === "success");

    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.canOpenProject).toBe(true);
    expect(bridge.prepareProjectReloadBaseline).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "start", value: { mode: { type: "new_game", seed: null } } },
      undefined,
    );
    const startCall = bridge.submitRuntime.mock.calls.findIndex(
      ([message]: unknown[]) => (message as { type?: string }).type === "start",
    );
    expect(bridge.prepareProjectReloadBaseline.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.submitRuntime.mock.invocationCallOrder[startCall]!,
    );
    expect(store.startupTelemetry).toMatchObject({
      scenario: "warm",
      cacheHit: true,
      outcome: "success",
      bridge: { quickScanMs: 1, cacheReadMs: 2, sourceReadMs: 3, submitMs: 4 },
    });
    expect(store.startupTelemetry?.observedStages.scanning).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.runtimeValidationReportedMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.frontendReadyToStartMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.startSubmittedMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.firstGamePhaseMs).toBeTypeOf("number");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
      ),
    ).toHaveLength(0);
    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("游戏运行中");
  });

  it("terminates startup telemetry when a bridge fails after submission", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        throw new Error("scan failed");
      },
    );
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toMatchObject({
      scenario: "cold",
      outcome: "failure",
      error: "Error: scan failed",
    });
  });

  it("does not wait for browser audio unlock before opening a project", async () => {
    const resume = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        destination = {};
        resume = resume;
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    mockProjectSelection({
      submittedAtMs: performance.now(),
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(resume).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.openProject).toHaveBeenCalledOnce();
  });

  it("does not create a startup attempt when project selection is cancelled", async () => {
    stubRunningAudioContext();
    mockProjectSelection(undefined);
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toBeUndefined();
  });

  it.each([
    ["directory", "openProject", "openProject"],
    ["file", "openProjectFile", "openProjectFile"],
  ] as const)(
    "opens the %s picker before session preparation",
    async (selection, storeMethod, bridgeMethod) => {
      stubRunningAudioContext();
      let confirmSelection!: () => void;
      const selected = new Promise<void>((resolve) => {
        confirmSelection = resolve;
      });
      bridge[bridgeMethod].mockImplementation(async (onSubmitted, prepareAfterSelection) => {
        await selected;
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 0,
          sourceReadMs: 1,
          submitMs: 1,
          cacheImported: false,
        };
      });
      const store = useRuntimeStore();

      const opening = store[storeMethod]();

      expect(bridge[bridgeMethod]).toHaveBeenCalledOnce();
      expect(bridge.createSession).not.toHaveBeenCalled();

      confirmSelection();
      await opening;

      expect(bridge.createSession).toHaveBeenCalledOnce();
      expect(store.projectSource).toBe(selection);
    },
  );

  it("prewarms and reuses one Runtime session on constrained browser devices", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    const session = deferred<ReturnType<typeof emptyBatch>>();
    bridge.createSession.mockReturnValue(session.promise);
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    const opening = store.openProjectFile();
    await flushMicrotasks();

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("正在初始化 Runtime…");
    session.resolve(emptyBatch());
    await opening;
    expect(bridge.createSession).toHaveBeenCalledOnce();
  });

  it("retries session creation when constrained-browser prewarming fails", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    bridge.createSession.mockRejectedValueOnce(new Error("prewarm failed"));
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    await flushMicrotasks();
    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
  });

  it("retries session creation when the prewarmed initial batch fails", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("service_request", {
          request_id: 1,
          kind: "unsupported",
          operation: "unsupported",
          payload: [],
        }),
      ],
    });
    bridge.submitRuntime.mockRejectedValueOnce(new Error("initial batch failed"));
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    await flushMicrotasks();
    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
  });

  it("keeps the Runtime pump stopped until the selected project is installed by its host", async () => {
    stubRunningAudioContext();
    const selected = deferred<ProjectOpenMetrics | undefined>();
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return selected.promise;
    });
    const store = useRuntimeStore();

    const opening = store.openProjectFile();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(bridge.pump).not.toHaveBeenCalled();
    selected.resolve({
      submittedAtMs: performance.now(),
      quickScanMs: 0,
      cacheReadMs: 0,
      sourceReadMs: 0,
      submitMs: 1,
      cacheImported: true,
      projectFonts: { fonts: [], errors: [] },
    });
    await opening;
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.pump).toHaveBeenCalledOnce();
  });

  it("publishes writable packaged-project preferences before Runtime loading finishes", async () => {
    stubRunningAudioContext();
    bridge.currentProjectPreferences.mockReturnValue({
      settings: { UseMouse: "NO" },
      imageScale: 1.5,
    });
    bridge.projectPreferencesWritable.mockReturnValue(true);
    bridge.saveProjectPreferences.mockImplementation(async (value) => value);
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
        projectFonts: { fonts: [], errors: [] },
      };
    });
    const store = useRuntimeStore();

    await store.openProjectFile();

    expect(store.projectLoading).toBe(true);
    expect(store.projectPreferencesWritable).toBe(true);
    expect(store.projectPreferences).toEqual({
      settings: { UseMouse: "NO" },
      imageScale: 1.5,
    });
    store.openPreferencesFromUser();
    await store.saveClientPreferences("project", {
      settings: { UseMouse: "YES" },
      imageScale: 1.25,
    });
    expect(bridge.saveProjectPreferences).toHaveBeenCalledWith({
      settings: { UseMouse: "YES" },
      imageScale: 1.25,
    });
    expect(store.preferencesOpen).toBe(false);
  });

  it("rebuilds the locked Runtime after host project installation fails", async () => {
    stubRunningAudioContext();
    let attempts = 0;
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      if (attempts++ === 0) throw new Error("host project install failed");
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      };
    });
    const store = useRuntimeStore();

    await store.openProjectFile();

    expect(store.status).toBe("Error: host project install failed");
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(bridge.pump).not.toHaveBeenCalled();
    expect(bridge.createSession.mock.invocationCallOrder[1]).toBeLessThan(
      bridge.pump.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pump).toHaveBeenCalled();
  });

  it("keeps the current project when replacement selection is cancelled", async () => {
    stubRunningAudioContext();
    mockProjectSelection(undefined);
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.projectSource = "file";

    await store.openProject();
    await store.confirmOpenProject();

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(store.projectOpen).toBe(true);
    expect(store.projectSource).toBe("file");
    expect(store.status).toBe("已取消打开项目");
    expect(store.canOpenProject).toBe(true);
  });

  it("does not overwrite the previous project telemetry when the picker fails", async () => {
    stubRunningAudioContext();
    const store = useRuntimeStore();
    store.projectSource = "file";
    const previousTelemetry = {
      scenario: "warm",
      selection: "directory",
      outcome: "loading",
    } as any;
    store.startupTelemetry = previousTelemetry;
    bridge.openProject.mockRejectedValue(new Error("picker failed"));

    await store.openProject();

    expect(store.startupTelemetry).toEqual(previousTelemetry);
    expect(store.projectSource).toBe("file");
    expect(store.status).toBe("Error: picker failed");
  });

  it("classifies a rejected cache followed by source submission as cold", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 2,
          sourceReadMs: 0,
          submitMs: 3,
          cacheImported: true,
        };
      },
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("project_load_report", {
            success: false,
            payload_required: true,
            diagnostics: [],
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(64);

    expect(bridge.submitProjectSource).toHaveBeenCalledOnce();
    expect(store.startupTelemetry).toMatchObject({
      scenario: "cold",
      cacheHit: false,
      outcome: "success",
    });
  });

  it("does not pump a cache-hit load before host project installation finishes", async () => {
    stubRunningAudioContext();
    const hostMetrics = deferred<ProjectOpenMetrics>();
    bridge.openProject.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return hostMetrics.promise;
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [
            { code: "runtime.compiled_cache_hit", level: "info", message: "cache hit" },
          ],
        }),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      ],
    });
    const store = useRuntimeStore();

    const opening = store.openProject();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(bridge.pump).not.toHaveBeenCalled();
    expect(store.status).toBe("正在读取项目…");

    hostMetrics.resolve({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
      projectFonts: { fonts: [], errors: [] },
    });
    await opening;
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("游戏运行中");
    expect(store.startupTelemetry).toMatchObject({
      scenario: "warm",
      cacheHit: true,
      outcome: "success",
    });

    expect(store.projectOpen).toBe(true);
    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.status).toBe("游戏运行中");
    expect(store.startupTelemetry?.bridge).toEqual({
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
    });
  });

  it("fails the active attempt when Runtime rejects its Start command", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 0,
          sourceReadMs: 1,
          submitMs: 1,
          cacheImported: false,
        };
      },
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "start rejected" }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(48);

    expect(store.startupTelemetry).toMatchObject({
      outcome: "failure",
      error: "start rejected",
    });
    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("项目启动失败：start rejected");
  });

  it("settles project loading when Runtime faults during startup", async () => {
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "faulted", epoch: 2 })],
    });
    const store = useRuntimeStore();

    await store.openProject();
    expect(store.projectLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.startupTelemetry).toMatchObject({
      outcome: "failure",
      error: "Runtime entered faulted during startup",
    });
  });

  it("keeps Firefox and Safari directory copying visible through the build handoff", async () => {
    bridge.kind = "browser";
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        resume = vi.fn(async () => {});
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    let resolveOpenProject!: (metrics: {
      submittedAtMs: number;
      quickScanMs: number;
      cacheReadMs: number;
      sourceReadMs: number;
      submitMs: number;
      cacheImported: boolean;
    }) => void;
    bridge.openProject.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return new Promise((resolve) => {
        resolveOpenProject = resolve;
      });
    });
    const store = useRuntimeStore();

    const opening = store.openProject();
    await vi.waitFor(() => expect(bridge.openProject).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(resolveOpenProject).toBeTypeOf("function"));
    expect(store.projectLoading).toBe(false);

    bridge.projectProgressListener?.({ stage: "importing", completed: 12, total: 40 });
    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("正在复制项目文件：12/40（30%）");
    expect(store.projectLoadProgressValue).toBe(30);

    bridge.projectProgressListener?.({ stage: "scanning", completed: 40, total: 40 });
    expect(store.projectLoadProgressLabel).toBe("正在读取项目文件：40/40（100%）");

    resolveOpenProject({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 3,
      submitMs: 4,
      cacheImported: false,
    });
    await opening;

    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("项目文件读取完成，正在准备编译与校验…");
    expect(store.projectLoadProgressValue).toBeUndefined();
  });
});
