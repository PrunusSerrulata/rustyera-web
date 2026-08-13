import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  blake3,
  deferred,
  emptyBatch,
  flushMicrotasks,
  mockProjectSelection,
  stateExportChunkEvent,
  stateExportReadyEvent,
  storeCompletingDiagnosis,
  storeWithInputWait,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";

describe("runtime store diagnosis", () => {
  installRuntimeStoreTestHarness();

  it("exports the TUI-compatible diagnosis archive while locking game interaction", async () => {
    vi.setSystemTime(new Date(2026, 6, 29, 14, 5, 6));
    const stopWait = {
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "eraThe World",
            history: { logical_lines: [] },
          }),
          runtimeEvent("wait_changed", { type: "opened", value: stopWait }),
          runtimeEvent("log", { level: "info", message: "diagnostic detail" }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("input_replay", 11, [1, 2]),
          stateExportChunkEvent(11, [1, 2]),
          stateExportReadyEvent("vm_snapshot", 12, [3, 4]),
          stateExportChunkEvent(12, [3, 4]),
          stateExportReadyEvent("full_project_file", 13, [5, 6]),
          stateExportChunkEvent(13, [5, 6]),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.gameInformation = { title: "GameBase title" };
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.canInteract).toBe(true);
    expect(store.canExportDiagnosis).toBe(true);

    await store.exportDiagnosis();
    expect(store.diagnosisExporting).toBe(true);
    expect(store.canInteract).toBe(false);
    expect(store.promptPlaceholder).toBe("诊断信息导出中……");
    expect(store.diagnosisProgress).toEqual({ stage: "input_replay", completed: 0, total: 0 });
    expect(store.diagnosisProgressLabel).toBe("正在导出输入回放…");
    await store.activate({ epoch: 2, id: 5 });
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );

    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "input_replay", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "diagnosis" },
      },
      undefined,
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(bridge.stageFullProjectManifest).toHaveBeenCalledOnce();
    expect(bridge.saveDiagnosis).toHaveBeenCalledWith(
      "GameBase title-diagnosis_20260729-140506.tar.zst",
      expect.objectContaining({
        projectName: "GameBase title",
        inputReplay: Uint8Array.of(1, 2),
        snapshot: Uint8Array.of(3, 4),
        projectFile: Uint8Array.of(5, 6),
        logs: expect.stringContaining("INFO  diagnostic detail"),
      }),
      expect.any(Function),
    );
    expect(store.diagnosisExporting).toBe(false);
    expect(store.canInteract).toBe(true);
    expect(store.diagnosisProgress).toBeUndefined();
    expect(store.diagnosisResult).toContain("诊断信息已导出");
    expect(store.logNotifications).toEqual([]);
  });

  it("projects actual diagnosis transfer bytes as a percentage", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("input_replay", 11, [1, 2, 3, 4]),
        stateExportChunkEvent(11, [1, 2], 0, false),
      ],
    });

    await store.exportDiagnosis();
    await advanceUntil(() => store.diagnosisProgress?.completed === 2);

    expect(store.diagnosisProgress).toEqual({
      stage: "input_replay",
      completed: 2,
      total: 4,
    });
    expect(store.diagnosisProgressLabel).toBe("正在导出输入回放（50%）");
    expect(store.diagnosisProgressValue).toBe(50);
  });

  it.each([
    ["user cancellation", async () => false, "已取消导出诊断信息"],
    [
      "archive write failure",
      async () => {
        throw new Error("archive write failed");
      },
      "archive write failed",
    ],
  ])(
    "clears progress and suppresses corner notifications after %s",
    async (_kind, save, result) => {
      bridge.saveDiagnosis.mockImplementationOnce(save);
      const store = await storeCompletingDiagnosis();

      expect(store.diagnosisExporting).toBe(false);
      expect(store.diagnosisProgress).toBeUndefined();
      expect(store.diagnosisResult).toContain(result);
      expect(store.canInteract).toBe(true);
      expect(store.logNotifications).toEqual([]);
    },
  );

  it.each([
    ["correlation", stateExportReadyEvent("input_replay", 11, [1, 2], 99)],
    ["outer kind", stateExportReadyEvent("vm_snapshot", 11, [1, 2])],
    [
      "descriptor kind",
      runtimeEvent(
        "state_export_ready",
        {
          kind: "input_replay",
          result: {
            type: "ready",
            transfer: {
              transfer_id: 11,
              kind: "vm_snapshot",
              total_bytes: 2,
              digest: [...blake3(Uint8Array.of(1, 2))],
            },
          },
        },
        1,
      ),
    ],
  ])("restores interaction after a mismatched diagnosis ready %s", async (_label, event) => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    bridge.pump.mockResolvedValueOnce({ ...emptyBatch(), events: [event] });

    await store.exportDiagnosis();
    await advanceUntil(() => store.diagnosisExporting === false);

    expect(store.canInteract).toBe(true);
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "state_export_cancel", value: { kind: "input_replay" } },
      undefined,
    );
  });

  it.each([
    ["transfer", { transfer_id: 99, offset: 0, data: [1, 2], complete: true }],
    ["offset", { transfer_id: 11, offset: 1, data: [1, 2], complete: true }],
    ["truncated", { transfer_id: 11, offset: 0, data: [1], complete: true }],
    ["digest", { transfer_id: 11, offset: 0, data: [2, 1], complete: true }],
  ])("restores interaction after an invalid diagnosis chunk %s", async (_label, chunk) => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("input_replay", 11, [1, 2]),
        runtimeEvent("state_export_chunk", chunk),
      ],
    });

    await store.exportDiagnosis();
    await advanceUntil(() => store.diagnosisExporting === false);

    expect(store.canInteract).toBe(true);
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "state_transfer_cancel", value: { transfer_id: 11 } },
      undefined,
    );
  });

  it("restores interaction even when diagnosis cancellation fails", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    bridge.submitRuntime.mockImplementation(async (...args: unknown[]) => {
      const message = args[0] as { type?: string };
      if (message.type === "state_transfer_cancel") throw new Error("cancel failed");
      return 1;
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("input_replay", 11, [1, 2]),
        runtimeEvent("state_export_chunk", {
          transfer_id: 99,
          offset: 0,
          data: [1, 2],
          complete: true,
        }),
      ],
    });

    await store.exportDiagnosis();
    await advanceUntil(() => store.diagnosisExporting === false);

    expect(store.canInteract).toBe(true);
    expect(store.diagnosisResult).toContain("分块关联");
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
  });

  it("restores interaction when diagnosis project staging fails", async () => {
    bridge.stageFullProjectManifest.mockRejectedValueOnce(new Error("scan failed"));
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "diagnosis fixture",
            history: { logical_lines: [] },
          }),
          runtimeEvent("wait_changed", {
            type: "opened",
            value: {
              kind: "integer_value",
              wait_id: 1,
              submission_token: { epoch: 2, id: 3 },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("input_replay", 11, [1, 2]),
          stateExportChunkEvent(11, [1, 2]),
          stateExportReadyEvent("vm_snapshot", 12, [3, 4]),
          stateExportChunkEvent(12, [3, 4]),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportDiagnosis();
    await vi.advanceTimersByTimeAsync(32);
    await flushMicrotasks();

    expect(store.diagnosisExporting).toBe(false);
    expect(store.canInteract).toBe(true);
    expect(store.diagnosisResult).toContain("scan failed");
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
    expect(store.logNotifications).toEqual([]);
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      }),
      undefined,
    );
  });

  it("restores interaction when the initial diagnosis project submission fails", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    bridge.submitRuntime.mockImplementation((...args: unknown[]) => {
      const message = args[0] as { type?: string; value?: { kind?: string } };
      if (message.type === "state_export_request" && message.value?.kind === "full_project_file")
        return Promise.reject(new Error("transport failed"));
      return Promise.resolve(10);
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("input_replay", 11, [1, 2], 10),
        stateExportChunkEvent(11, [1, 2]),
        stateExportReadyEvent("vm_snapshot", 12, [3, 4], 10),
        stateExportChunkEvent(12, [3, 4]),
      ],
    });

    await store.exportDiagnosis();
    await advanceUntil(() => store.diagnosisExporting === false);

    expect(store.diagnosisResult).toContain("transport failed");
    expect(store.canInteract).toBe(true);
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "state_export_cancel", value: { kind: "full_project_file" } },
      undefined,
    );
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
  });

  it("registers an early correlated diagnosis retry after a VM snapshot export", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    const retrySubmission = deferred<number>();
    let fullProjectRequests = 0;
    bridge.submitRuntime.mockImplementation((...args: unknown[]) => {
      const message = args[0] as { type?: string; value?: { kind?: string } };
      if (message.type === "state_export_request" && message.value?.kind === "full_project_file") {
        fullProjectRequests += 1;
        if (fullProjectRequests === 2) return retrySubmission.promise;
        return Promise.resolve(40 + fullProjectRequests);
      }
      return Promise.resolve(10);
    });
    let normalSnapshotCompleted = false;
    let diagnosisReplayCompleted = false;
    let diagnosisSnapshotCompleted = false;
    let preparationStartedRejected = false;
    let preparationStillRejected = false;
    let fullProjectCompleted = false;
    bridge.pump.mockImplementation(async () => {
      const snapshotRequests = bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "vm_snapshot",
      ).length;
      const replayRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "input_replay",
      );
      if (snapshotRequests >= 1 && !normalSnapshotCompleted) {
        normalSnapshotCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("vm_snapshot", 11, [1, 2], 10),
            stateExportChunkEvent(11, [1, 2]),
          ],
        };
      }
      if (replayRequested && !diagnosisReplayCompleted) {
        diagnosisReplayCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("input_replay", 14, [9, 10], 10),
            stateExportChunkEvent(14, [9, 10]),
          ],
        };
      }
      if (snapshotRequests >= 2 && !diagnosisSnapshotCompleted) {
        diagnosisSnapshotCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("vm_snapshot", 12, [3, 4], 10),
            stateExportChunkEvent(12, [3, 4]),
          ],
        };
      }
      if (fullProjectRequests === 1 && !preparationStartedRejected) {
        preparationStartedRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("command_rejected", { message: "full project preparation started" }, 41),
          ],
        };
      }
      if (fullProjectRequests === 2 && !preparationStillRejected) {
        preparationStillRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "command_rejected",
              { message: "full project is still being prepared" },
              42,
            ),
          ],
        };
      }
      if (fullProjectRequests === 3 && !fullProjectCompleted) {
        fullProjectCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("full_project_file", 13, [5, 6], 43),
            stateExportChunkEvent(13, [5, 6]),
          ],
        };
      }
      return emptyBatch();
    });

    await store.exportSnapshot();
    await advanceUntil(() => bridge.saveDownload.mock.calls.length === 1);
    await store.exportDiagnosis();
    await advanceUntil(() => fullProjectRequests === 2, 20);
    await advanceUntil(() => preparationStillRejected, 20);
    expect(store.logs.some((entry) => entry.message.includes("full project"))).toBe(false);

    retrySubmission.resolve(42);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(49);
    expect(fullProjectRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fullProjectRequests).toBe(3);
    await advanceUntil(() => bridge.saveDiagnosis.mock.calls.length === 1, 20);

    expect(fullProjectRequests).toBe(3);
    expect(bridge.saveDiagnosis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        inputReplay: Uint8Array.of(9, 10),
        snapshot: Uint8Array.of(3, 4),
        projectFile: Uint8Array.of(5, 6),
      }),
      expect.any(Function),
    );
    expect(store.diagnosisExporting).toBe(false);
    expect(store.canInteract).toBe(true);
    expect(store.logNotifications).toEqual([]);
    for (const progress of [
      "full project preparation started",
      "full project is still being prepared",
    ]) {
      expect(store.logs.some((entry) => entry.message.includes(progress))).toBe(false);
      expect(
        store.logNotifications.some((notification) => notification.message.includes(progress)),
      ).toBe(false);
    }
  });

  it("does not consume an early full-project preparation rejection with another correlation", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    const retrySubmission = deferred<number>();
    let fullProjectRequests = 0;
    bridge.submitRuntime.mockImplementation((...args: unknown[]) => {
      const message = args[0] as { type?: string; value?: { kind?: string } };
      if (message.type === "state_export_request" && message.value?.kind === "full_project_file") {
        fullProjectRequests += 1;
        if (fullProjectRequests === 2) return retrySubmission.promise;
        return Promise.resolve(41);
      }
      return Promise.resolve(10);
    });
    let replayCompleted = false;
    let snapshotCompleted = false;
    let preparationStartedRejected = false;
    let mismatchedPreparationRejected = false;
    let allowCorrelatedFailure = false;
    bridge.pump.mockImplementation(async () => {
      const replayRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "input_replay",
      );
      if (replayRequested && !replayCompleted) {
        replayCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("input_replay", 14, [9, 10], 10),
            stateExportChunkEvent(14, [9, 10]),
          ],
        };
      }
      const snapshotRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "vm_snapshot",
      );
      if (snapshotRequested && !snapshotCompleted) {
        snapshotCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("vm_snapshot", 11, [1, 2], 10),
            stateExportChunkEvent(11, [1, 2]),
          ],
        };
      }
      if (fullProjectRequests === 1 && !preparationStartedRejected) {
        preparationStartedRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("command_rejected", { message: "full project preparation started" }, 41),
          ],
        };
      }
      if (fullProjectRequests === 2 && !mismatchedPreparationRejected) {
        mismatchedPreparationRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "command_rejected",
              { message: "full project is still being prepared" },
              999,
            ),
          ],
        };
      }
      if (allowCorrelatedFailure) {
        allowCorrelatedFailure = false;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("command_rejected", { message: "full project failed" }, 42)],
        };
      }
      return emptyBatch();
    });

    await store.exportDiagnosis();
    await advanceUntil(() => mismatchedPreparationRejected, 20);
    retrySubmission.resolve(42);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    expect(fullProjectRequests).toBe(2);
    expect(
      store.logNotifications.some((notification) =>
        notification.message.includes("full project is still being prepared"),
      ),
    ).toBe(true);

    allowCorrelatedFailure = true;
    await advanceUntil(() => store.diagnosisExporting === false);
    expect(store.canInteract).toBe(true);
  });

  it("unlocks diagnosis when a full-project retry submission fails", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    });
    const retrySubmission = deferred<number>();
    let fullProjectRequests = 0;
    bridge.submitRuntime.mockImplementation((...args: unknown[]) => {
      const message = args[0] as { type?: string; value?: { kind?: string } };
      if (message.type === "state_export_request" && message.value?.kind === "full_project_file") {
        fullProjectRequests += 1;
        if (fullProjectRequests === 2) return retrySubmission.promise;
        return Promise.resolve(41);
      }
      return Promise.resolve(10);
    });
    let replayCompleted = false;
    let snapshotCompleted = false;
    let preparationRejected = false;
    let earlyRetryRejection = false;
    bridge.pump.mockImplementation(async () => {
      const replayRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "input_replay",
      );
      if (replayRequested && !replayCompleted) {
        replayCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("input_replay", 14, [9, 10], 10),
            stateExportChunkEvent(14, [9, 10]),
          ],
        };
      }
      const snapshotRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "vm_snapshot",
      );
      if (snapshotRequested && !snapshotCompleted) {
        snapshotCompleted = true;
        return {
          ...emptyBatch(),
          events: [
            stateExportReadyEvent("vm_snapshot", 11, [1, 2], 10),
            stateExportChunkEvent(11, [1, 2]),
          ],
        };
      }
      if (fullProjectRequests === 1 && !preparationRejected) {
        preparationRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("command_rejected", { message: "full project preparation started" }, 41),
          ],
        };
      }
      if (fullProjectRequests === 2 && !earlyRetryRejection) {
        earlyRetryRejection = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "command_rejected",
              { message: "full project is still being prepared" },
              42,
            ),
          ],
        };
      }
      return emptyBatch();
    });

    await store.exportDiagnosis();
    await advanceUntil(() => earlyRetryRejection, 20);
    retrySubmission.reject(new Error("transport failed"));
    await advanceUntil(() => store.diagnosisExporting === false, 20);

    expect(fullProjectRequests).toBe(2);
    expect(store.diagnosisResult).toContain("transport failed");
    expect(store.canInteract).toBe(true);
    expect(
      store.logNotifications.some((notification) =>
        notification.message.includes("full project is still being prepared"),
      ),
    ).toBe(true);
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "state_export_cancel", value: { kind: "full_project_file" } },
      undefined,
    );
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
  });

  it("cancels both sides when a diagnosis project chunk exceeds its descriptor", async () => {
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "diagnosis fixture",
            history: { logical_lines: [] },
          }),
          runtimeEvent("wait_changed", {
            type: "opened",
            value: {
              kind: "integer_value",
              wait_id: 1,
              submission_token: { epoch: 2, id: 3 },
            },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("input_replay", 11, [1, 2]),
          stateExportChunkEvent(11, [1, 2]),
          stateExportReadyEvent("vm_snapshot", 12, [3, 4]),
          stateExportChunkEvent(12, [3, 4]),
          runtimeEvent(
            "state_export_ready",
            {
              kind: "full_project_file",
              result: {
                type: "ready",
                transfer: {
                  transfer_id: 13,
                  kind: "full_project_file",
                  total_bytes: 1,
                  digest: [...blake3(Uint8Array.of(5, 6))],
                },
              },
            },
            1,
          ),
          stateExportChunkEvent(13, [5, 6]),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportDiagnosis();
    await vi.advanceTimersByTimeAsync(32);
    await flushMicrotasks();

    expect(store.diagnosisExporting).toBe(false);
    expect(store.canInteract).toBe(true);
    expect(bridge.saveDiagnosis).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "state_export_cancel", value: { kind: "full_project_file" } },
      undefined,
    );
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
  });

  it.each([
    [42, 42],
    ["18446744073709551615", 18446744073709551615n],
  ])("starts a test new game with the configured deterministic seed %s", async (seed, expected) => {
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
    const store = useRuntimeStore();
    store.configureTestRun({ start: { type: "new_game", seed } });

    await store.enableDebug();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "start",
        value: { mode: { type: "new_game", seed: expected } },
      },
      undefined,
    );
  });
});
