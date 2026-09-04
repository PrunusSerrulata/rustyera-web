import * as runtimeSupport from "@/core/runtimeSupport";
import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  blake3,
  emptyBatch,
  projectConfigurationReport,
  stateExportChunkEvent,
  stateExportReadyEvent,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store settings-export", () => {
  installRuntimeStoreTestHarness();

  it("aborts a prepared transaction when the host write fails and does not hot-apply it", async () => {
    let messageId = 40;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.writeProjectConfiguration.mockRejectedValueOnce(new Error("disk full"));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(5, 6, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    bridge.applyProjectConfiguration.mockClear();
    const saving = store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "[text]\nfont_size = 18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 5,
              expected_source_digest: new Uint8Array(32).fill(6),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            41,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: projectConfigurationReport(5, 6, "12").configuration },
            42,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 41, outcome: "abort" },
      },
      undefined,
    );
    expect(bridge.applyProjectConfiguration).not.toHaveBeenCalled();
    expect(store.projectSettingsError).toContain("disk full");
  });

  it("clears a rejected finalization so a later save can start", async () => {
    let messageId = 60;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(8, 9, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    const firstSave = store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "[text]\nfont_size = 18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 8,
              expected_source_digest: new Uint8Array(32).fill(9),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            61,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "finalize rejected" }, 62)],
      });
    await vi.advanceTimersByTimeAsync(64);
    await firstSave;
    expect(store.projectSettingsError).toContain("finalize rejected");

    void store.saveProjectSettings([{ code: "FontSize", value: "20" }]);
    await Promise.resolve();

    const prepareCalls = bridge.submitRuntime.mock.calls.filter(
      (call: unknown[]) => (call[0] as any).type === "prepare_configuration_update",
    );
    expect(prepareCalls).toHaveLength(2);
  });

  it("uses the browser close gesture for the WASM exit action", async () => {
    bridge.kind = "browser";
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const store = useRuntimeStore();

    await store.shutdown();

    expect(close).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status).toContain("请手动关闭此标签页");
  });

  it("uses the TUI snapshot filename format in local time", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 0, 30, 7));
    const store = useRuntimeStore();

    await store.exportSnapshot();

    expect(store.testTransferState()).toMatchObject({
      export: { name: "runtime_20260730-003007.snapshot" },
    });
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "normal" },
      },
      undefined,
    );
  });

  it("exports the core operation sequence as a timestamped JSONL download", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 0, 30, 7));
    const store = useRuntimeStore();
    await store.enableDebug();

    await store.exportInputReplay();

    expect(store.testTransferState()).toMatchObject({
      export: { name: "input-replay_20260730-003007.jsonl" },
    });
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "input_replay", snapshot_purpose: "normal" },
      },
      undefined,
    );

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("input_replay", 17, [1, 2, 3]),
        stateExportChunkEvent(17, [1, 2, 3]),
      ],
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.beginStateExport).toHaveBeenCalledWith("input-replay_20260730-003007.jsonl", 3);
    expect(bridge.writeStateExportChunk.mock.calls).toEqual([
      [Uint8Array.of(1, 2, 3), true, false],
      [new Uint8Array(), false, true],
    ]);
    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("已导出 input-replay_20260730-003007.jsonl");
  });

  it("accepts the traditional-save transfer kind for the test download", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    const store = useRuntimeStore();
    await store.enableDebug();

    await store.exportTraditionalSaveForTest();
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        stateExportReadyEvent("traditional_save", 18, [1, 2, 3]),
        stateExportChunkEvent(18, [1, 2, 3]),
      ],
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.beginStateExport).toHaveBeenCalledWith("save00.sav", 3);
    expect(store.testTransferState().export).toBeNull();
    expect(store.fault).toBeNull();
  });

  it("releases a failed operation-sequence request so it can be retried", async () => {
    bridge.submitRuntime.mockRejectedValueOnce(new Error("transport unavailable"));
    const store = useRuntimeStore();

    await store.exportInputReplay();

    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("操作序列导出失败：Error: transport unavailable");

    await store.exportInputReplay();
    expect(store.testTransferState().export).not.toBeNull();
  });

  it.each([
    {
      label: "suppresses the exact state-export warning mirror",
      runtimeWarning: "state export is ineligible: [StableWaitRequired]",
      expectedNotifications: 1,
    },
    {
      label: "keeps an unrelated adjacent state-export warning",
      runtimeWarning: "an unrelated export warning",
      expectedNotifications: 2,
    },
  ])("$label", async ({ runtimeWarning, expectedNotifications }) => {
    const store = useRuntimeStore();
    await store.enableDebug();
    await store.exportSnapshot();
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("log", { level: "warning", message: runtimeWarning }),
        runtimeEvent(
          "state_export_ready",
          {
            kind: "vm_snapshot",
            result: { type: "ineligible", reasons: ["stable_wait_required"] },
          },
          1,
        ),
      ],
    });

    await vi.advanceTimersByTimeAsync(16);

    expect(store.testTransferState().export).toBeNull();
    expect(store.logs.map((entry) => entry.message).slice(-2)).toEqual([
      runtimeWarning,
      "当前状态不能导出快照：stable_wait_required",
    ]);
    expect(store.logNotifications).toHaveLength(expectedNotifications);
  });

  it("streams a titled project file through the host export boundary", async () => {
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "测试项目",
            history: { logical_lines: [] },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("full_project_file", 7, [1, 2, 3]),
          {
            ...stateExportChunkEvent(7, []),
            dataBytes: Uint8Array.of(1, 2, 3),
          },
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    const concatenate = vi.spyOn(runtimeSupport, "concatenateChunks");
    await store.exportProjectFile();
    expect(store.gameInteractionsBlocked).toBe(true);
    expect(store.canInteract).toBe(false);
    expect(store.canOpenProject).toBe(false);
    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.beginProjectFileExport).toHaveBeenCalledWith("测试项目.reraproj");
    expect(bridge.stageFullProjectManifest).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(
      bridge.submitRuntime.mock.calls
        .map(
          ([message]: unknown[]) =>
            message as { type?: string; value?: { maximum_bytes?: number } },
        )
        .filter((message) => message.type === "state_export_chunk_request")
        .map((message) => message.value?.maximum_bytes),
    ).toEqual([1024 * 1024]);
    expect(bridge.writeProjectFileChunk).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3), true, true);
    expect(concatenate).not.toHaveBeenCalled();
    concatenate.mockRestore();
    expect(store.gameInteractionsBlocked).toBe(false);
  });

  it("imports a full manifest in chunks before requesting project packaging", async () => {
    const manifest = Uint8Array.of(1, 2, 3, 4, 5);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: manifest.byteLength });
    bridge.readFullProjectManifestChunk.mockImplementationOnce(async (offset, maximumBytes) =>
      manifest.slice(offset, offset + maximumBytes),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce(emptyBatch())
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "full_project_manifest" }, 1),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(80);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "state_import_begin",
      value: {
        kind: "full_project_manifest",
        total_bytes: manifest.byteLength,
        digest: null,
        artifact_id: null,
      },
    });
    expect(messages).toContainEqual({
      type: "state_import_chunk",
      value: { transfer_id: 19, offset: 0, data: manifest },
    });
    expect(messages).toContainEqual({
      type: "state_import_commit",
      value: { transfer_id: 19, digest: blake3(manifest) },
    });
    expect(messages).toContainEqual({
      type: "state_export_request",
      value: { kind: "full_project_file", snapshot_purpose: "normal" },
    });
    await store.cancelProjectFileExport();
  });

  it("ignores a cancelled project's late writer rejection instead of faulting the pump", async () => {
    let rejectWrite!: (error: Error) => void;
    bridge.writeProjectFileChunk.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("full_project_file", 7, [1, 2, 3]),
          stateExportChunkEvent(7, [1, 2, 3]),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(16);
    await store.cancelProjectFileExport();
    rejectWrite(new DOMException("writer aborted", "AbortError"));
    await vi.advanceTimersByTimeAsync(32);
    expect(store.fault).toBeNull();
    expect(store.projectFileExporting).toBe(false);
    expect(store.status).toBe("已取消导出全量项目文件");
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
  });

  it("does not start a full project export when the active WASM project file is ineligible", async () => {
    bridge.kind = "browser";
    bridge.fullProjectExportSupported.mockReturnValue(false);
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.exportProjectFile();

    expect(store.canExportProjectFile).toBe(false);
    expect(bridge.beginProjectFileExport).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
  });

  it("refreshes full project export eligibility when the active project source changes", () => {
    let supported = true;
    bridge.fullProjectExportSupported.mockImplementation(() => supported);
    const store = useRuntimeStore();
    store.projectOpen = true;

    expect(store.fullProjectExportSupported).toBe(true);
    supported = false;
    store.projectSource = "file";
    expect(store.fullProjectExportSupported).toBe(false);
    supported = true;
    store.projectSource = "directory";
    expect(store.fullProjectExportSupported).toBe(true);
  });

  it("reads full manifests larger than four MiB through exact bounded bridge chunks", async () => {
    const manifest = new Uint8Array(4 * 1024 * 1024 + 3).fill(7);
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: manifest.byteLength });
    bridge.readFullProjectManifestChunk.mockImplementation(async (offset, maximumBytes) =>
      manifest.slice(offset, offset + maximumBytes),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce(emptyBatch())
      .mockResolvedValueOnce(emptyBatch())
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "full_project_manifest" }, 4),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(80);

    expect(bridge.readFullProjectManifestChunk.mock.calls).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 3],
    ]);
    const chunks = bridge.submitRuntime.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "state_import_chunk");
    expect(chunks.map((message) => [message.value.offset, message.value.data.byteLength])).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 3],
    ]);
    expect(bridge.releaseFullProjectManifest).toHaveBeenCalledOnce();
    await store.cancelProjectFileExport();
  });

  it("does not package a project for mismatched manifest Ready events", async () => {
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.stageFullProjectManifest.mockResolvedValue({ totalBytes: 1 });
    bridge.readFullProjectManifestChunk.mockResolvedValueOnce(Uint8Array.of(1));
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce(emptyBatch())
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 20, kind: "full_project_manifest" }, 3),
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "vm_snapshot" }, 3),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(80);

    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]) =>
          message.type === "state_export_request" && message.value.kind === "full_project_file",
      ),
    ).toBe(false);
    await store.cancelProjectFileExport();
  });

  it("does not submit manifest chunks after cancelling an in-flight host read", async () => {
    let finishRead!: (data: Uint8Array) => void;
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: 1 });
    bridge.readFullProjectManifestChunk.mockReturnValueOnce(
      new Promise<Uint8Array>((resolve) => {
        finishRead = resolve;
      }),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(32);
    await store.cancelProjectFileExport();
    finishRead(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(0);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "state_transfer_cancel",
      value: { transfer_id: 19 },
    });
    expect(messages.some((message) => message.type === "state_import_chunk")).toBe(false);
    expect(messages.some((message) => message.type === "state_import_commit")).toBe(false);
  });

  it("drains each full-manifest chunk before reading the next and stops on rejection", async () => {
    let messageId = 1;
    let queuedChunk: number | undefined;
    bridge.submitRuntime.mockImplementation(async (message) => {
      const id = messageId++;
      if (message.type === "state_import_chunk") {
        expect(queuedChunk, "only one chunk may await a runtime pump").toBeUndefined();
        queuedChunk = id;
      }
      return id;
    });
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: 12 * 1024 * 1024 });
    bridge.readFullProjectManifestChunk.mockImplementation(async (_offset, maximum) => {
      expect(queuedChunk).toBeUndefined();
      return new Uint8Array(maximum).fill(7);
    });
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockImplementationOnce(async () => {
        expect(queuedChunk).toBe(2);
        queuedChunk = undefined;
        return emptyBatch();
      })
      .mockImplementationOnce(async () => {
        const rejected = queuedChunk;
        queuedChunk = undefined;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "command_rejected",
              { code: "invalid_value", message: "rejected chunk" },
              rejected,
            ),
          ],
        };
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(80);

    expect(bridge.readFullProjectManifestChunk.mock.calls).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 4 * 1024 * 1024],
    ]);
    expect(
      bridge.submitRuntime.mock.calls.some(([message]) => message.type === "state_import_commit"),
    ).toBe(false);
    expect(store.projectFileExporting).toBe(false);
    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
  });

  it("aborts host staging before waiting for runtime cancellation and keeps replacement blocked", async () => {
    let rejectStaging!: (error: Error) => void;
    let finishCancel!: (id: number) => void;
    bridge.stageFullProjectManifest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStaging = reject;
        }),
    );
    bridge.cancelProjectFileExport.mockImplementationOnce(async () => {
      rejectStaging(new DOMException("Export cancelled", "AbortError"));
    });
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "state_export_cancel")
        return new Promise<number>((resolve) => {
          finishCancel = resolve;
        });
      return 1;
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    const exporting = store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(0);
    const cancelling = store.cancelProjectFileExport();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.cancelProjectFileExport).toHaveBeenCalledOnce();
    expect(store.projectFileExporting).toBe(true);
    await store.exportProjectFile();
    expect(bridge.beginProjectFileExport).toHaveBeenCalledOnce();
    await store.cancelProjectFileExport();
    finishCancel(2);
    await Promise.all([exporting, cancelling]);
    expect(store.projectFileExporting).toBe(false);
    expect(store.status).toBe("已取消导出全量项目文件");
  });
});
