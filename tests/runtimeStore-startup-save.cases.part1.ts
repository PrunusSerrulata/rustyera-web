import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  emptyBatch,
  encodeServicePayload,
  flushMicrotasks,
  mockProjectSelection,
  runningBrowserStore,
  stubRunningAudioContext,
  useRuntimeStore,
  runtimeEvent,
  stateExportReadyEvent,
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
    expect(store.testRuntimeEvidence().sessionGeneration).toBe(1);
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

  it("advances snake AWAIT time after acknowledging its device pump", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_changed", { phase: "waiting_external", epoch: 2 }),
        runtimeEvent(
          "service_request",
          {
            request_id: 7,
            kind: "input_state",
            operation: "device_pump",
            operation_version: { major: 1, minor: 0 },
            payload: [
              ...encodeServicePayload(
                new Map<number, unknown>([
                  [0, 2],
                  [1, 0],
                ]),
              ),
            ],
          },
          41,
          2,
        ),
      ],
    });
    let reportedRunning = false;
    let reportedVmProgress = false;
    bridge.pump.mockImplementation(async () => {
      const advances = bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      );
      if (advances.length === 0) return emptyBatch();
      if (!reportedRunning) {
        reportedRunning = true;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("state_changed", { phase: "running", epoch: 2 })],
        };
      }
      if (advances.length < 3 || reportedVmProgress) return emptyBatch();
      reportedVmProgress = true;
      return { ...emptyBatch(), vmInstructions: 1 };
    });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "new_game", seed: 42 },
      monotonicStartNs: 1_000_000,
    });

    await store.enableDebug();
    await advanceUntil(
      () =>
        bridge.submitRuntime.mock.calls.some(
          ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
        ) && reportedVmProgress,
    );

    const responses = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "service_response",
    );
    const advances = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
    );
    expect(responses).toHaveLength(1);
    expect(reportedRunning).toBe(true);
    expect(advances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(64);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      ),
    ).toHaveLength(3);
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
    expect(bridge.prepareSessionReplacement).toHaveBeenCalledOnce();
    expect(bridge.prepareSessionReplacement.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createSession.mock.invocationCallOrder[0]!,
    );
    expect(bridge.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.restartProject.mock.invocationCallOrder[0]!,
    );
    expect(store.projectSource).toBe("file");
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" }),
      expect.anything(),
    );
    expect(store.testRuntimeEvidence().sessionGeneration).toBe(1);

    await store.restart();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.testRuntimeEvidence().sessionGeneration).toBe(2);
  });

  it("recreates a constrained browser session before importing a selected VM snapshot", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    bridge.kind = "browser";
    bridge.snapshotRestoreMode = "fresh_session";
    bridge.openUpload.mockResolvedValueOnce(bytes);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.projectSource = "file";

    await store.restoreSnapshot();

    expect(bridge.prepareSessionReplacement).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.restartProject).toHaveBeenCalledOnce();
    expect(bridge.prepareSessionReplacement.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createSession.mock.invocationCallOrder[0]!,
    );
    expect(bridge.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.restartProject.mock.invocationCallOrder[0]!,
    );
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "state_import_begin" }),
      undefined,
    );

    await advanceUntil(() =>
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) => (message as { type?: string }).type === "state_import_begin",
      ),
    );

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_import_begin",
        value: expect.objectContaining({ kind: "vm_snapshot", total_bytes: bytes.length }),
      }),
      undefined,
    );
  });

  it("recreates the Tauri session before restoring a VM snapshot", async () => {
    const bytes = Uint8Array.of(5, 6, 7);
    bridge.kind = "tauri";
    bridge.snapshotRestoreMode = "fresh_session";
    bridge.openUpload.mockResolvedValueOnce(bytes);
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.restoreSnapshot();

    expect(bridge.prepareSessionReplacement).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.restartProject).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "state_import_begin" }),
      undefined,
    );
  });

  it.each([
    runtimeEvent("command_rejected", { message: "snapshot rejected" }, 1),
    runtimeEvent("fault", { code: "snapshot_restore", message: "snapshot fault" }),
    runtimeEvent("state_changed", { phase: "stopped", epoch: 2 }),
  ])("releases pending snapshot bytes when import terminates with $type", async (event) => {
    bridge.openUpload.mockResolvedValueOnce(Uint8Array.of(1, 2, 3, 4));
    bridge.createSession.mockResolvedValueOnce({ ...emptyBatch(), events: [event] });
    const store = useRuntimeStore();

    await store.restoreSnapshot();
    expect(store.testTransferState()).toMatchObject({
      importKind: "vm_snapshot",
      importBytes: 4,
    });

    await store.enableDebug();

    expect(store.testTransferState()).toMatchObject({ importKind: undefined, importBytes: 0 });
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
    stubRunningAudioContext();
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
          memoryConstrained: true,
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
    await flushMicrotasks();
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
      memoryBytes: 64 * 1024 * 1024,
    });
    bridge.projectProgressListener?.({ stage: "compiling", completed: 7, total: 10 });
    expect(store.projectLoadProgressLabel).toBe("正在编译脚本函数：7/10（70%）");
    expect(store.projectLoadProgressValue).toBe(70);
    bridge.projectProgressListener?.({
      stage: "compiling",
      completed: 10,
      total: 10,
      elapsedMs: 60,
      memoryBytes: 96 * 1024 * 1024,
    });
    bridge.projectProgressListener?.({ stage: "validating", completed: 1, total: 2 });
    expect(store.startupTelemetry?.durations.compileMs).toBe(50);
    expect(store.startupTelemetry?.wasmMemory).toMatchObject({
      peakBytes: 96 * 1024 * 1024,
      stages: { compiling: 96 * 1024 * 1024 },
    });
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%）");
    expect(store.projectLoadProgressValue).toBe(50);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%） · 已等待 5 秒");

    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        memoryBytes: 112 * 1024 * 1024,
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
      wasmMemory: { constrained: true, peakBytes: 112 * 1024 * 1024 },
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

  it("releases the old title timeline before pumping and resynchronizes a rejected transition", async () => {
    const store = useRuntimeStore();
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    bridge.submitRuntime.mockClear();
    bridge.pump.mockClear();
    bridge.submitRuntime.mockResolvedValueOnce(41).mockResolvedValueOnce(42);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "title unavailable" }, 41)],
    });
    store.projectOpen = true;
    store.phase = "waiting_input";
    store.presentation.lines.push({ id: "old-line", runs: [] } as any);
    store.prompt = "old prompt";
    const resourceGeneration = store.projectResourceGeneration;

    await store.returnToTitle();

    expect(store.presentation.lines).toEqual([]);
    expect(store.prompt).toBe("");
    expect(store.projectResourceGeneration).toBe(resourceGeneration + 1);
    expect(bridge.pump).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitRuntime).toHaveBeenNthCalledWith(
      2,
      { type: "resynchronize", value: { after_sequence: null } },
      undefined,
    );
    expect(store.status).toContain("返回标题被 Runtime 拒绝");
  });

  it("retires an active state-export sink only after ReturnToTitle is accepted", async () => {
    const store = useRuntimeStore();
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    bridge.submitRuntime.mockClear();
    bridge.submitRuntime.mockResolvedValue(1);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [stateExportReadyEvent("input_replay", 17, [1, 2, 3], 1)],
    });
    store.projectOpen = true;
    store.phase = "waiting_input";

    await store.exportInputReplay();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.beginStateExport).toHaveBeenCalledOnce();
    const pumpCount = bridge.pump.mock.calls.length;

    await store.returnToTitle();

    const returnCall = bridge.submitRuntime.mock.calls.findIndex(
      ([message]: unknown[]) => (message as { type?: string }).type === "return_to_title",
    );
    expect(returnCall).toBeGreaterThanOrEqual(0);
    expect(bridge.submitRuntime.mock.invocationCallOrder[returnCall]!).toBeLessThan(
      bridge.cancelStateExport.mock.invocationCallOrder[0]!,
    );
    expect(bridge.cancelStateExport).toHaveBeenCalledOnce();
    expect(store.testTransferState().export).toBeNull();
    expect(bridge.pump).toHaveBeenCalledTimes(pumpCount);
  });
});
