import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences } from "@/core/types";

const emptyBatch = () => ({
  state: "idle" as const,
  vmInstructions: 0,
  runtimeTransitions: 0,
  events: [],
});
const bridge = vi.hoisted(() => ({
  kind: "tauri" as const,
  createSession: vi.fn(),
  submitRuntime: vi.fn(async () => 1),
  submitDebug: vi.fn(async () => 1),
  pump: vi.fn(),
  openProject: vi.fn(),
  restartProject: vi.fn(),
  submitProjectSource: vi.fn(),
  reloadProject: vi.fn(),
  readResource: vi.fn(),
  readImageMetadata: vi.fn(),
  handleStorage: vi.fn(),
  listFonts: vi.fn(async () => []),
  loadPreferences: vi.fn(async () => defaultPreferences()),
  savePreferences: vi.fn(),
  openUpload: vi.fn(),
  saveDownload: vi.fn(),
  writeCompiledCacheChunk: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/platform", () => ({ platformBridge: () => bridge }));

import { useRuntimeStore } from "@/stores/runtime";

describe("runtime store session lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.clearAllMocks();
    bridge.createSession.mockResolvedValue(emptyBatch());
    let nextDebugMessageId = 1;
    bridge.submitDebug.mockImplementation(async () => nextDebugMessageId++);
    bridge.pump.mockResolvedValue(emptyBatch());
    bridge.restartProject.mockResolvedValue({
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the fatal-error diagnosis export for manual diagnosis requests", async () => {
    const store = useRuntimeStore();

    await store.exportDiagnosis();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "diagnosis" },
      },
      undefined,
    );
    expect(store.testTransferState().export).toEqual(
      expect.objectContaining({ name: "runtime-diagnosis.snapshot" }),
    );
  });

  it("starts a test new game with the configured deterministic seed", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.openProject.mockResolvedValue({
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
    store.configureTestRun({ start: { type: "new_game", seed: 42 } });

    await store.enableDebug();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "start",
        value: { mode: { type: "new_game", seed: 42 } },
      },
      undefined,
    );
  });

  it("imports a traditional save before starting the test runtime", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.openProject.mockResolvedValue({
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: true,
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [] }),
        runtimeEvent("state_import_accepted", { transfer_id: 9 }),
        runtimeEvent("state_import_ready", { transfer_id: 9, kind: "traditional_save" }),
      ],
    });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "traditional_save", bytes: new Uint8Array([1, 2, 3]) },
    });

    await store.enableDebug();

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

  it("recreates the runtime and reopens the same project for Restart", async () => {
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.restart();

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.restartProject).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" }),
      expect.anything(),
    );
  });

  it("attaches without pausing and retries a requested pause with a renewed grant", async () => {
    const oldToken = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const newToken = { grant_id: { high: 1, low: 2 }, program_generation: 2 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: oldToken }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent("grant", { token: newToken }),
          runtimeEvent("log", {
            level: "warning",
            message:
              "debug request failed [PermissionDenied]: debug grant is stale or belongs to another session generation",
          }),
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(1);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));

    await store.openDebugDialog("variables");
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: oldToken, command: { type: "pause" } },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: newToken, command: { type: "pause" } },
    });
    expect(store.logs).toEqual([]);
  });

  it("renegotiates when the runtime rejects the current grant", async () => {
    const token = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
  });

  it("loads open debugger surfaces after stopping and selects a populated call stack", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent("stopped", { stop, selected_fiber: 7 }, 2),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "variable_page",
              value: {
                stop,
                variables: [
                  {
                    symbol_key: [1],
                    name: "RESULT",
                    storage: "global",
                    value_kind: "integer",
                    dimensions: [],
                  },
                ],
              },
            },
            4,
          ),
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "debug_paused", frame_count: 2 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "call_stack",
              value: {
                stop,
                fiber_id: 7,
                frames: [{ frame_id: 9, function_name: "EVENTFIRST", instruction: 12 }],
              },
            },
            5,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.openDebugDialog("variables");
    await store.openDebugDialog("stack");
    await vi.advanceTimersByTimeAsync(48);

    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_variables", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_fibers", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "read_call_stack", stop, fiber_id: 7 } },
    });
    expect(store.debugVariables.map((variable) => variable.name)).toEqual(["RESULT"]);
    expect(store.debugFibers.map((fiber) => fiber.fiber_id)).toEqual([7]);
    expect(store.debugFrames.map((frame) => frame.function_name)).toEqual(["EVENTFIRST"]);
  });

  it("steps only runnable fibers and restores the stop when the runtime rejects the step", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent("stopped", { stop, selected_fiber: 7 }, 2),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "waiting_host", frame_count: 1 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            { code: "invalid_state", message: "only a runnable fiber can be stepped" },
            4,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(32);

    expect(store.canStepDebug).toBe(false);
    store.debugFibers = [{ fiber_id: 7, state: "runnable", frame_count: 1 }];
    expect(store.canStepDebug).toBe(true);

    const stepping = store.stepDebug();
    const rejectedStep = expect(stepping).rejects.toThrow("only a runnable fiber can be stepped");
    await vi.advanceTimersByTimeAsync(16);
    await rejectedStep;
    expect(store.debugStop).toEqual(expect.objectContaining({ stop }));
  });

  it("uses the newest envelope epoch across presentation snapshots", async () => {
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "presentation_snapshot",
          {
            revision: 1,
            title: "first",
            history: { logical_lines: [] },
          },
          undefined,
          8,
        ),
        runtimeEvent(
          "presentation_snapshot",
          {
            revision: 2,
            title: "title",
            history: { logical_lines: [] },
          },
          undefined,
          9,
        ),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.runtimeEpoch).toBe(9);
  });
});

function runtimeEvent(type: string, value: unknown, correlationId?: number, epoch?: number) {
  return {
    channel: "runtime" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    epoch,
    message: { type, value },
  };
}

function debugEvent(type: string, value: unknown, correlationId?: number) {
  return {
    channel: "debug" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    message: { type, value },
  };
}
