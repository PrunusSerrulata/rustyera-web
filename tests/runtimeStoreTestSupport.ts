import { blake3 } from "@noble/hashes/blake3.js";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { plainLine } from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  defaultPreferences,
  type Preferences,
  type ProjectOpenMetrics,
  type ProjectPreferences,
} from "@/core/types";
import { normalizePreferences } from "@/platform/database";
import { bridge } from "./runtimeStoreBridgeMock";

export const emptyBatch = () => ({
  state: "idle" as const,
  vmInstructions: 0,
  runtimeTransitions: 0,
  events: [],
});

export function stubRunningAudioContext(
  resumeImplementation: () => Promise<void> = async () => undefined,
): { resume: ReturnType<typeof vi.fn> } {
  const resumeAudio = vi.fn(resumeImplementation);
  vi.stubGlobal(
    "Audio",
    class extends EventTarget {
      preservesPitch = true;
      preload = "";
      paused = true;
      ended = false;
      duration = 1;
      currentTime = 0;
      playbackRate = 1;
      loop = false;
      src = "";
      readyState = 1;
      error = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn(async () => {
        this.paused = false;
      });
      pause = vi.fn(() => {
        this.paused = true;
      });
      load = vi.fn();
      removeAttribute = vi.fn(() => {
        this.src = "";
      });
    },
  );
  const OriginalUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalUrl {
      static createObjectURL = vi.fn(() => "blob:audio");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = resumeAudio;
      close = vi.fn(async () => {});
      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(() => ({ connect: vi.fn() })),
          disconnect: vi.fn(),
        };
      }
      createMediaElementSource() {
        return {
          connect: vi.fn(() => ({ connect: vi.fn() })),
          disconnect: vi.fn(),
        };
      }
    },
  );
  return { resume: resumeAudio };
}
import { useRuntimeStore } from "@/stores/runtime";

export {
  blake3,
  bridge,
  decodeServicePayload,
  defaultPreferences,
  encodeServicePayload,
  normalizePreferences,
  plainLine,
  useRuntimeStore,
};

export function mockProjectSelection(
  metrics:
    | (Omit<ProjectOpenMetrics, "projectFonts"> & {
        projectFonts?: ProjectOpenMetrics["projectFonts"];
      })
    | undefined,
  method: "openProject" | "openProjectFile" = "openProject",
): void {
  bridge[method].mockImplementation(async (onSubmitted, prepareAfterSelection) => {
    if (!metrics) return undefined;
    onSubmitted?.(performance.now());
    await prepareAfterSelection?.();
    return { ...metrics, projectFonts: metrics.projectFonts ?? { fonts: [], errors: [] } };
  });
}

export function installRuntimeStoreTestHarness(): void {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.clearAllMocks();
    bridge.openProject.mockReset();
    bridge.openProjectFile.mockReset();
    bridge.pump.mockReset();
    bridge.submitRuntime.mockReset();
    bridge.submitRuntimeAndPump = undefined;
    bridge.kind = "tauri";
    bridge.snapshotRestoreMode = "in_place";
    bridge.prewarmRuntimeOnInitialize = false;
    bridge.automaticCompiledCacheExport = true;
    bridge.fullProjectExportSupported.mockReturnValue(true);
    bridge.createSession.mockResolvedValue(emptyBatch());
    bridge.prepareSessionReplacement.mockResolvedValue(undefined);
    bridge.runtimeMemoryCounters.mockReturnValue({
      workerGeneration: null,
      wasmLinearMemoryBytes: null,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });
    bridge.submitRuntime.mockResolvedValue(1);
    bridge.prepareProjectReloadBaseline.mockResolvedValue(undefined);
    let nextDebugMessageId = 1;
    bridge.submitDebug.mockImplementation(async () => nextDebugMessageId++);
    bridge.pump.mockResolvedValue(emptyBatch());
    bridge.saveDownload.mockResolvedValue(true);
    bridge.beginStateExport.mockResolvedValue(true);
    bridge.writeStateExportChunk.mockResolvedValue(undefined);
    bridge.cancelStateExport.mockResolvedValue(undefined);
    bridge.beginProjectFileExport.mockResolvedValue(true);
    bridge.traditionalSaves.listSlots.mockResolvedValue([
      { slot: 0, occupied: false },
      { slot: 1, occupied: true },
    ]);
    bridge.traditionalSaves.exportSlot.mockResolvedValue(undefined);
    bridge.traditionalSaves.pickImport.mockResolvedValue(undefined);
    bridge.traditionalSaves.inspect.mockResolvedValue({ description: "valid" });
    bridge.traditionalSaves.writeSlot.mockResolvedValue(undefined);
    bridge.saveDiagnosis.mockImplementation(async (_name, _input, reportProgress) => {
      reportProgress?.({ completed: 100, total: 100 });
      return true;
    });
    bridge.writeCompiledCacheChunk.mockResolvedValue(undefined);
    bridge.cancelCompiledCacheExport.mockResolvedValue(undefined);
    bridge.dispose.mockResolvedValue(undefined);
    bridge.listFonts.mockResolvedValue({ kind: "ready", fonts: [] });
    bridge.reloadProject.mockResolvedValue({ fonts: [], errors: [], messageId: 77 });
    bridge.finalizeProjectReload.mockResolvedValue({ fonts: [], errors: [] });
    bridge.projectReloadTargets.mockResolvedValue({
      folders: ["ERB/events"],
      scripts: ["ERB/events/day.erb"],
    });
    bridge.savePreferences.mockImplementation(async (value: Preferences) => value);
    bridge.currentProjectPreferences.mockReturnValue(undefined);
    bridge.saveProjectPreferences.mockImplementation(async (value: ProjectPreferences) => value);
    bridge.projectPreferencesWritable.mockReturnValue(true);
    bridge.projectConfigurationWritable.mockReturnValue(true);
    bridge.writeProjectConfiguration.mockResolvedValue(undefined);
    bridge.applyProjectConfiguration.mockResolvedValue(undefined);
    bridge.restartProject.mockResolvedValue({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
      projectFonts: { fonts: [], errors: [] },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
}
export async function runningBrowserStore() {
  bridge.pump.mockResolvedValueOnce({
    ...emptyBatch(),
    events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
  });
  const store = useRuntimeStore();
  store.projectOpen = true;
  await store.enableDebug();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.canManageTraditionalSaves).toBe(true);
  return store;
}

export async function storeWithPendingCompiledCacheWrite(write: Promise<void>) {
  stubRunningAudioContext();
  let nextRuntimeMessageId = 1;
  let activeExportMessageId = 0;
  bridge.submitRuntime.mockImplementation(async (...args: unknown[]) => {
    const message = args[0] as { type?: string };
    const messageId = nextRuntimeMessageId++;
    if (message.type === "state_export_request") activeExportMessageId = messageId;
    return messageId;
  });
  bridge.writeCompiledCacheChunk.mockReturnValueOnce(write);
  mockProjectSelection({
    submittedAtMs: 0,
    quickScanMs: 1,
    cacheReadMs: 0,
    sourceReadMs: 1,
    submitMs: 1,
    cacheImported: false,
  });
  let reportSent = false;
  let preparationRejected = false;
  let readySent = false;
  let chunkSent = false;
  bridge.pump.mockImplementation(async () => {
    if (!reportSent) {
      reportSent = true;
      return {
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      };
    }
    const commands = bridge.submitRuntime.mock.calls.map(
      ([message]: unknown[]) => (message as { type?: string }).type,
    );
    if (!preparationRejected && commands.includes("state_export_request")) {
      preparationRejected = true;
      return {
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            {
              code: "invalid_state",
              message: "compiled project cache preparation started",
            },
            activeExportMessageId,
          ),
        ],
      };
    }
    if (!readySent && commands.includes("state_export_request")) {
      readySent = true;
      return {
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "state_export_ready",
            {
              kind: "compiled_project_cache",
              result: {
                type: "ready",
                transfer: {
                  transfer_id: 7,
                  kind: "compiled_project_cache",
                  total_bytes: 6,
                },
              },
            },
            activeExportMessageId,
          ),
        ],
      };
    }
    if (!chunkSent && commands.includes("state_export_chunk_request")) {
      chunkSent = true;
      return {
        ...emptyBatch(),
        events: [
          runtimeEvent("state_export_chunk", {
            transfer_id: 7,
            offset: 0,
            data: [1, 2, 3],
            complete: false,
          }),
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("wait_changed", {
            type: "opened",
            value: {
              kind: "enter_key",
              wait_id: 17,
              submission_token: { epoch: 2, id: 5 },
            },
          }),
        ],
      };
    }
    return emptyBatch();
  });
  const store = useRuntimeStore();

  await store.openProject();
  await vi.advanceTimersByTimeAsync(1_100);
  expect(bridge.writeCompiledCacheChunk).toHaveBeenCalledOnce();
  return store;
}

export async function storeWithInputWait(
  wait: Record<string, unknown>,
  extraEvents: (ReturnType<typeof runtimeEvent> | ReturnType<typeof debugEvent>)[] = [],
) {
  bridge.pump.mockResolvedValueOnce({
    ...emptyBatch(),
    events: [
      runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      runtimeEvent("presentation_snapshot", {
        revision: 1,
        title: "input gate",
        history: { logical_lines: [] },
        input_wait: wait,
      }),
      runtimeEvent("wait_changed", { type: "opened", value: wait }),
      ...extraEvents,
    ],
  });
  const store = useRuntimeStore();
  store.projectOpen = true;
  await store.enableDebug();
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

export async function storeCompletingDiagnosis() {
  const store = await storeWithInputWait({
    kind: "integer_value",
    wait_id: 1,
    submission_token: { epoch: 2, id: 3 },
  });
  bridge.pump.mockResolvedValueOnce({
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

  await store.exportDiagnosis();
  await advanceUntil(() => store.diagnosisExporting === false);
  return store;
}

export function runtimeEvent(type: string, value: unknown, correlationId?: number, epoch?: number) {
  return {
    channel: "runtime" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    epoch,
    message: { type, value },
  };
}

export function stateExportReadyEvent(
  kind: string,
  transferId: number,
  bytes: number[],
  correlationId = 1,
) {
  return runtimeEvent(
    "state_export_ready",
    {
      kind,
      result: {
        type: "ready",
        transfer: {
          transfer_id: transferId,
          kind,
          total_bytes: bytes.length,
          digest: [...blake3(Uint8Array.from(bytes))],
        },
      },
    },
    correlationId,
  );
}

export function stateExportChunkEvent(
  transferId: number,
  bytes: number[],
  offset = 0,
  complete = true,
) {
  return runtimeEvent("state_export_chunk", {
    transfer_id: transferId,
    offset,
    data: bytes,
    complete,
  });
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

export async function advanceUntil(predicate: () => boolean, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) {
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(16);
  }
  expect(predicate()).toBe(true);
}

export function projectConfigurationReport(revision: number, digestByte: number, fontSize: string) {
  return {
    success: true,
    diagnostics: [],
    configuration: {
      project_revision: revision,
      source_digest: new Uint8Array(32).fill(digestByte),
      restart_pending: false,
      generated_source: null,
      entries: [configurationEntry("FontSize", fontSize)],
    },
  };
}

export function configurationEntry(code: string, value: string) {
  return {
    code,
    japanese: code === "FontSize" ? "フォントサイズ" : code,
    english: code === "FontSize" ? "Font size" : code,
    value,
    effective_value: value,
    preference_eligible: true,
    client_effective_value: value,
    default_value: code === "FontSize" ? "18" : value,
    application: "hot",
    kind: "integer",
    allowed: [],
    fixed: false,
    applicability: 8,
  };
}

export function debugEvent(type: string, value: unknown, correlationId?: number) {
  return {
    channel: "debug" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    message: { type, value },
  };
}
