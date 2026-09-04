import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  emptyBatch,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store settings-export", () => {
  installRuntimeStoreTestHarness();

  it("cancels a late manifest Accepted after cancellation during begin submission", async () => {
    let finishBegin!: (messageId: number) => void;
    let beginCount = 0;
    let messageId = 2;
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "state_import_begin" && beginCount++ === 0)
        return new Promise<number>((resolve) => {
          finishBegin = resolve;
        });
      return messageId++;
    });
    bridge.stageFullProjectManifest.mockResolvedValue({ totalBytes: 1 });
    bridge.readFullProjectManifestChunk.mockResolvedValue(Uint8Array.of(1));
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            { code: "stale_request", message: "state transfer is stale" },
            3,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    const exporting = store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(0);
    await store.cancelProjectFileExport();
    finishBegin(1);
    await exporting;
    await vi.advanceTimersByTimeAsync(64);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    expect(messages.filter((message) => message.type === "state_transfer_cancel")).toEqual([
      { type: "state_transfer_cancel", value: { transfer_id: 19 } },
    ]);
    expect(messages.some((message) => message.type === "state_import_chunk")).toBe(false);
    expect(
      store.logs.some(
        (entry) =>
          entry.message.includes("no state import is active") ||
          entry.message.includes("state transfer is stale"),
      ),
    ).toBe(false);

    await store.exportProjectFile();
    expect(
      bridge.submitRuntime.mock.calls.filter(([message]) => message.type === "state_import_begin"),
    ).toHaveLength(2);
    await store.cancelProjectFileExport();
  });

  it("orders cancellation after an in-flight manifest chunk submission", async () => {
    let finishChunk!: (messageId: number) => void;
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "state_import_chunk")
        return new Promise<number>((resolve) => {
          finishChunk = resolve;
        });
      return messageId++;
    });
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
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            { code: "stale_request", message: "state transfer is stale" },
            3,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(32);

    const cancelling = store.cancelProjectFileExport();
    messageId = 3;
    finishChunk(2);
    await cancelling;
    await vi.advanceTimersByTimeAsync(32);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    const chunkIndex = messages.findIndex((message) => message.type === "state_import_chunk");
    const cancelIndex = messages.findIndex((message) => message.type === "state_transfer_cancel");
    expect(chunkIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeGreaterThan(chunkIndex);
    expect(messages.some((message) => message.type === "state_import_commit")).toBe(false);
    expect(
      store.logs.some(
        (entry) =>
          entry.message.includes("no state import is active") ||
          entry.message.includes("state transfer is stale"),
      ),
    ).toBe(false);
    await store.exportProjectFile();
    expect(
      bridge.submitRuntime.mock.calls.filter(([message]) => message.type === "state_import_begin"),
    ).toHaveLength(2);
    await store.cancelProjectFileExport();
  });

  it("cancels a committed manifest before Ready without starting packaging", async () => {
    let finishCommit!: (messageId: number) => void;
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "state_import_commit")
        return new Promise<number>((resolve) => {
          finishCommit = resolve;
        });
      return messageId++;
    });
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
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "full_project_manifest" }, 3),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            { code: "stale_request", message: "state transfer is stale" },
            4,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(32);

    const cancelling = store.cancelProjectFileExport();
    messageId = 4;
    finishCommit(3);
    await cancelling;
    await vi.advanceTimersByTimeAsync(64);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    expect(messages.filter((message) => message.type === "state_transfer_cancel")).toEqual([
      { type: "state_transfer_cancel", value: { transfer_id: 19 } },
    ]);
    expect(
      messages.some(
        (message) =>
          message.type === "state_export_request" && message.value.kind === "full_project_file",
      ),
    ).toBe(false);
    expect(
      store.logs.some(
        (entry) =>
          entry.message.includes("no state import is active") ||
          entry.message.includes("state transfer is stale"),
      ),
    ).toBe(false);
    await store.exportProjectFile();
    expect(
      bridge.submitRuntime.mock.calls.filter(([message]) => message.type === "state_import_begin"),
    ).toHaveLength(2);
    await store.cancelProjectFileExport();
  });

  it.each([
    { phase: "begin", rejectionBatch: 2, correlation: 1, accepted: false },
    { phase: "chunk", rejectionBatch: 3, correlation: 2, accepted: true },
    { phase: "commit", rejectionBatch: 4, correlation: 3, accepted: true },
  ])(
    "cleans a rejected full-manifest $phase command",
    async ({ phase, rejectionBatch, correlation, accepted }) => {
      let messageId = 1;
      bridge.submitRuntime.mockImplementation(async () => messageId++);
      bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: 1 });
      bridge.readFullProjectManifestChunk.mockResolvedValueOnce(Uint8Array.of(1));
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
      if (accepted) {
        bridge.pump.mockResolvedValueOnce({
          ...emptyBatch(),
          events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
        });
      }
      if (phase === "commit") bridge.pump.mockResolvedValueOnce(emptyBatch());
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            { code: "invalid_value", message: "rejected" },
            correlation,
          ),
        ],
      });
      const store = useRuntimeStore();
      store.projectOpen = true;
      await store.enableDebug();
      await vi.advanceTimersByTimeAsync(0);

      await store.exportProjectFile();
      await vi.advanceTimersByTimeAsync(rejectionBatch * 16);

      expect(bridge.releaseFullProjectManifest).toHaveBeenCalled();
      expect(bridge.cancelProjectFileExport).toHaveBeenCalled();
      if (accepted)
        expect(bridge.submitRuntime).toHaveBeenCalledWith(
          { type: "state_transfer_cancel", value: { transfer_id: 19 } },
          undefined,
        );
      expect(store.gameInteractionsBlocked).toBe(false);
    },
  );
});
