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

  it("uses the newest grant in a batch and renegotiates a stale grant", async () => {
    const oldToken = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const newToken = { grant_id: { high: 1, low: 2 }, program_generation: 2 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: oldToken }),
          debugEvent("grant", { token: newToken }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent("error", {
            code: "permission_denied",
            message: "debug grant is stale or belongs to another session generation",
          }),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: newToken, command: { type: "pause" } },
    });

    await vi.advanceTimersByTimeAsync(16);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
  });
});

function runtimeEvent(type: string, value: unknown) {
  return {
    channel: "runtime" as const,
    sequence: 0,
    messageId: 0,
    message: { type, value },
  };
}

function debugEvent(type: string, value: unknown) {
  return {
    channel: "debug" as const,
    sequence: 0,
    messageId: 0,
    message: { type, value },
  };
}
