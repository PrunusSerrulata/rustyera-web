import {
  configureServiceLifecycle,
  serviceLifecycleSummary,
  serviceLifecycleSnapshot,
  type ServiceLifecycleConfiguration,
} from "@/testing/serviceLifecycle";
import type { Pinia } from "pinia";

import { observedLineText } from "@/testing/presentationText";
import { hex } from "@/platform/browserProjectFilesystem";
import type { RuntimeTestConfiguration } from "@/stores/runtime";
import { useRuntimeStore } from "@/stores/runtime";
import {
  calibratePerformanceFrames,
  installPerformanceAuditObservers,
  performanceAuditEnabled,
  performanceAuditProgress,
  performanceAuditSnapshot,
  resetPerformanceAudit,
} from "@/testing/performanceAudit";

export interface WebTestControl {
  configure(configuration: RuntimeTestConfiguration): void;
  configureServiceLifecycle(configuration: ServiceLifecycleConfiguration): void;
  openProject(): Promise<void>;
  waitForStableObservation(timeoutMs?: number, summary?: boolean): Promise<Record<string, unknown>>;
  snapshot(): Record<string, unknown>;
  snapshotSummary(): Record<string, unknown>;
  protocolEvidence(messageTypes: string[]): Record<string, unknown>;
  mediaPlacements(): Record<string, unknown>;
  mediaReplay(resourceName: string): Record<string, unknown>;
  inspect(watches: string[]): Promise<Record<string, unknown>>;
  inspectTyped(watches: string[]): Promise<Record<string, unknown>>;
  exportSnapshot(): Promise<void>;
  exportTraditionalSave(): Promise<void>;
  takeDownload(timeoutMs?: number): Promise<{ name: string; bytes: number[] }>;
  replaceProjectSource(relativePath: string, expected: string, replacement: string): Promise<void>;
  reloadProject(scope: "all" | "folder" | "script", path?: string): Promise<void>;
  exportDiagnosis(): Promise<void>;
  calibratePerformanceFrames(frameCount?: number): Promise<Record<string, unknown>>;
  performanceAudit(): Promise<Record<string, unknown>>;
  resetPerformanceAudit(): Promise<{ frontendEpoch: number; nativeEpoch: number }>;
  frontendPerformanceAudit(): Record<string, unknown>;
  frontendPerformanceAuditProgress(): Record<string, number>;
  resetFrontendPerformanceAudit(): { frontendEpoch: number };
  performanceCheckpoint(watches: string[]): Promise<Record<string, unknown>>;
}

export function isStableObservationCandidate(
  phase: string,
  canInteract: boolean,
  fault: unknown,
  modalReady = false,
  backgroundBusy = false,
): boolean {
  return (
    !backgroundBusy &&
    (canInteract ||
      modalReady ||
      fault != null ||
      ["debug_paused", "stopped", "faulted", "shutting_down"].includes(phase))
  );
}

export function stableObservationSignature(snapshot: Record<string, unknown>): string {
  const observed = { ...snapshot };
  // Servicing the background pump does not change an otherwise ready input boundary.
  // This affects only action settling; the complete-snapshot watchdog keeps this field.
  delete observed.cooperativeBackgroundWorkRevision;
  if (observed.audioProvider && typeof observed.audioProvider === "object")
    observed.audioProvider = Object.fromEntries(
      Object.entries(observed.audioProvider).map(([channel, state]) => [
        channel,
        state && typeof state === "object"
          ? { ...(state as Record<string, unknown>), positionMs: 0 }
          : state,
      ]),
    );
  return JSON.stringify(observed);
}

export function installWebTestControl(pinia: Pinia): void {
  const store = useRuntimeStore(pinia);
  installPerformanceAuditObservers();
  const createSnapshot = (summary: boolean): Record<string, unknown> =>
    serialize({
      bridgeKind: store.bridgeKind,
      serviceEvidence: summary ? store.testRuntimeEvidenceSummary() : store.testRuntimeEvidence(),
      serviceLifecycle: summary ? serviceLifecycleSummary() : serviceLifecycleSnapshot(),
      buildIdentity: {
        corePin: import.meta.env.VITE_RUSTYERA_CORE_FULL_REVISION,
        wasmRevision: import.meta.env.VITE_RUSTYERA_WASM_REVISION,
        frontendVersion: import.meta.env.VITE_RUSTYERA_FRONTEND_VERSION,
      },
      phase: store.phase,
      cooperativeBackgroundWorkRevision: store.testBackgroundWorkRevision(),
      runtimeEpoch: store.runtimeEpoch,
      status: store.status,
      projectOpen: store.projectOpen,
      projectLoading: store.projectLoading,
      startupTelemetry: store.startupTelemetry,
      performanceAudit: performanceAuditEnabled() ? performanceAuditProgress() : undefined,
      memory: store.liveMemoryCounters(),
      canInteract: store.canInteract,
      wait: store.presentation.inputWait,
      presentationRevision: store.presentation.revision,
      historyRevision: store.presentation.historyRevision,
      output: store.presentation.lines.map(observedLineText),
      htmlIsland: store.presentation.htmlIsland,
      audio: Object.fromEntries(
        store.presentation.audio.map((channel) => [
          channel.channel.type === "sound"
            ? `sound:${String(channel.channel.channel)}`
            : channel.channel.type,
          {
            resourceId: channel.resourceId,
            state: channel.state,
            playing: channel.state === "playing",
            revision: channel.revision,
          },
        ]),
      ),
      audioPlayback: store.testAudioPlaybackState(),
      audioProvider: store.testAudioProviderState(),
      fault: store.fault,
      logs: store.logs.slice(-100),
      logNotifications: store.logNotifications,
      debug: {
        enabled: store.debugEnabled,
        singleStepEnabled: store.singleStepEnabled,
        canStep: store.canStepDebug,
        stop: store.debugStop,
        variables: store.debugVariables,
        variablesLoading: store.debugVariablesLoading,
        values: store.debugVariableValues,
        fibers: store.debugFibers,
        frames: store.debugFrames,
      },
      transfer: store.testTransferState(),
      diagnosis: {
        exporting: store.diagnosisExporting,
        progress: store.diagnosisProgress,
        label: store.diagnosisProgressLabel,
        result: store.diagnosisResult,
        canExport: store.canExportDiagnosis,
      },
      saveTransfer: {
        mode: store.traditionalSaveDialogMode,
        busy: store.traditionalSaveTransferBusy,
        error: store.traditionalSaveTransferError,
        overwriteSlot: store.traditionalSaveOverwriteSlot,
      },
      lastDownload: downloadSummary(window.__RUSTYERA_TEST_DOWNLOADS__?.at(-1)),
    });
  const snapshot = (): Record<string, unknown> => createSnapshot(false);
  const snapshotSummary = (): Record<string, unknown> => createSnapshot(true);

  window.__RUSTYERA_TEST__ = {
    configure: (configuration) => store.configureTestRun(configuration),
    configureServiceLifecycle,
    openProject: () => store.openProject(),
    snapshot,
    snapshotSummary,
    protocolEvidence: (messageTypes) => serialize(store.testRuntimeEvidence(messageTypes)),
    mediaPlacements: () => presentationMedia(store.presentation),
    mediaReplay: (resourceName) => mediaReplay(store.presentation.resources, resourceName),
    inspect: (watches) => store.inspectWatches(watches),
    inspectTyped: async (watches) => serialize(await store.inspectTypedWatches(watches)),
    exportSnapshot: () => store.exportSnapshot("normal"),
    exportTraditionalSave: () => store.exportTraditionalSaveForTest(),
    async replaceProjectSource(relativePath, expected, replacement) {
      if (!window.__RUSTYERA_TEST_FS_REPLACE__)
        throw new Error("测试项目文件系统未安装源码替换入口");
      await window.__RUSTYERA_TEST_FS_REPLACE__({ relativePath, expected, replacement });
    },
    reloadProject: (scope, path) =>
      store.reloadProject(scope === "all" ? { type: "all" } : { type: scope, path: path ?? "" }),
    exportDiagnosis: () => store.exportDiagnosis(),
    calibratePerformanceFrames,
    frontendPerformanceAudit() {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      return serialize(performanceAuditSnapshot());
    },
    frontendPerformanceAuditProgress() {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      return performanceAuditProgress();
    },
    resetFrontendPerformanceAudit() {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      return { frontendEpoch: resetPerformanceAudit() };
    },
    async resetPerformanceAudit() {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      const frontendEpoch = resetPerformanceAudit();
      const { invoke } = await import("@tauri-apps/api/core");
      const nativeEpoch = await invoke<number>("performance_audit_reset");
      return { frontendEpoch, nativeEpoch };
    },
    async performanceAudit() {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      const { invoke } = await import("@tauri-apps/api/core");
      const resources = store.presentation.resources as Record<string, unknown>;
      const lines = store.presentation.lines as Array<{ runs?: unknown[] }>;
      const native = await invoke<{
        schemaVersion: number;
        epoch: number;
        dropped: number;
        pumps: Array<{
          epoch: number;
          sequence: number;
          operation: string;
          requestDecodeMs: number;
          nativeDriveMs: number;
          jsonSerializeMs: number;
        }>;
      }>("performance_audit_telemetry");
      const frontend = performanceAuditSnapshot() as {
        schemaVersion: number;
        epoch: number;
        nextSequence: number;
        timingSamplesDropped: number;
        timings: Array<{
          epoch: number;
          sequence: number;
          phase: string;
          operation: string;
          elapsedMs: number;
          startedAtMs: number;
          detail?: Record<string, unknown>;
        }>;
        segments: Record<string, { timingSamples: number }>;
      };
      if (native.epoch !== frontend.epoch)
        throw new Error(
          `performance audit epoch mismatch: frontend=${frontend.epoch} native=${native.epoch}`,
        );
      if (native.dropped !== 0)
        throw new Error(`performance audit native telemetry dropped ${native.dropped} samples`);
      if (frontend.timingSamplesDropped !== 0)
        throw new Error(
          `performance audit frontend telemetry dropped ${frontend.timingSamplesDropped} samples`,
        );
      const invokes = frontend.timings.filter((sample) => sample.phase === "invoke");
      if (invokes.length !== native.pumps.length)
        throw new Error(
          `performance audit invoke/native sample mismatch: frontend=${invokes.length} native=${native.pumps.length}`,
        );
      for (const [index, pump] of native.pumps.entries()) {
        const invokeSample = invokes[index];
        if (
          !invokeSample ||
          invokeSample.operation !== pump.operation ||
          pump.epoch !== native.epoch ||
          pump.sequence !== index
        )
          throw new Error(
            `performance audit invoke/native ordering mismatch at ${index}: ${JSON.stringify({ invokeSample, pump })}`,
          );
        frontend.timings.push({
          epoch: frontend.epoch,
          sequence: frontend.nextSequence++,
          phase: "transport",
          operation: pump.operation,
          elapsedMs: Math.max(
            0,
            invokeSample.elapsedMs -
              pump.requestDecodeMs -
              pump.nativeDriveMs -
              pump.jsonSerializeMs,
          ),
          startedAtMs: invokeSample.startedAtMs,
          detail: { derived: true, nativeEpoch: pump.epoch, nativeSequence: pump.sequence },
        });
      }
      frontend.segments = {
        loading: {
          timingSamples: frontend.timings.filter((sample) => sample.phase === "loading").length,
        },
        runtime: {
          timingSamples: frontend.timings.filter((sample) => sample.phase !== "loading").length,
        },
      };
      return serialize({
        frontend,
        native,
        state: {
          domNodes: document.querySelectorAll("*").length,
          lineCount: lines.length,
          runCount: lines.reduce((total, line) => total + (line.runs?.length ?? 0), 0),
          historyRevision: store.presentation.historyRevision,
          sceneLayers: store.presentation.scene?.layers?.length ?? 0,
          sprites: Array.isArray(resources.sprites) ? resources.sprites.length : 0,
          canvases: Array.isArray(resources.canvases) ? resources.canvases.length : 0,
        },
      });
    },
    async performanceCheckpoint(watches) {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      const wait = store.presentation.inputWait as
        { kind?: string; wait_id?: unknown; generation?: unknown } | undefined;
      const variables = await store.inspectTypedWatches(watches);
      const protocol = store.testRuntimeEvidence() as { records?: unknown[] };
      return serialize({
        runtimeEpoch: store.runtimeEpoch,
        phase: store.phase,
        wait: wait
          ? { kind: wait.kind, waitId: wait.wait_id ?? null, generation: wait.generation ?? null }
          : null,
        output: store.presentation.lines.map(observedLineText),
        scene: store.presentation.scene,
        resources: store.presentation.resources,
        variables,
        service: store.testRuntimeEvidenceSummary(),
        storage: store.testRuntimeEvidence(["storage_request", "storage_response"]),
        transfer: store.testTransferState(),
        saveTransfer: {
          mode: store.traditionalSaveDialogMode,
          busy: store.traditionalSaveTransferBusy,
          error: store.traditionalSaveTransferError,
          overwriteSlot: store.traditionalSaveOverwriteSlot,
        },
        coreProjection: coreCheckpointProjection(protocol.records ?? [], {
          phase: store.phase,
          wait: store.presentation.inputWait,
          lines: store.presentation.lines,
          resources: store.presentation.resources,
          scene: store.presentation.scene,
          variables,
        }),
      });
    },
    async takeDownload(timeoutMs = 30_000) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const download = window.__RUSTYERA_TEST_DOWNLOADS__?.shift();
        if (download) return { name: download.name, bytes: [...download.bytes] };
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      throw new Error(
        `等待测试下载超时（${timeoutMs} ms）：${JSON.stringify(
          serialize({ transfer: store.testTransferState(), logs: store.logs.slice(-10) }),
        )}`,
      );
    },
    async waitForStableObservation(timeoutMs = 30_000, summary = false) {
      const deadline = performance.now() + timeoutMs;
      let previous = "";
      let stableFrames = 0;
      while (performance.now() < deadline) {
        const current = stableObservationSignature(snapshotSummary());
        const observable = isStableObservationCandidate(
          store.phase,
          store.canInteract,
          store.fault,
          store.traditionalSaveDialogMode != null && !store.traditionalSaveTransferBusy,
          store.diagnosisExporting,
        );
        if (observable && current === previous) stableFrames += 1;
        else stableFrames = 0;
        if (stableFrames >= 2) return summary ? snapshotSummary() : snapshot();
        previous = current;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error(`等待稳定输入状态超时（${timeoutMs} ms）`);
    },
  };
}

function presentationMedia(presentation: any): Record<string, unknown> {
  const images: Array<Record<string, unknown>> = [];
  const visitNode = (node: any, lineId: unknown): void => {
    if (node?.semantic?.type === "image") {
      images.push({
        lineId,
        source: node.semantic.source,
        width: node.semantic.width,
        height: node.semantic.height,
        y: node.semantic.y,
      });
    }
    for (const child of node?.children ?? []) visitNode(child, lineId);
  };
  for (const line of presentation.lines ?? []) {
    for (const run of line.runs ?? []) {
      if (run.type === "image") images.push({ lineId: line.line_id, ...run.placement });
      if (run.type === "html_document")
        for (const node of run.document?.nodes ?? []) visitNode(node, line.line_id);
    }
  }
  return serialize({ images, scene: presentation.scene ?? { revision: 0, layers: [] } });
}

function mediaReplay(resources: any, resourceName: string): Record<string, unknown> {
  const sprites = resources.sprites ?? [];
  const canvases = resources.canvases ?? [];
  const sprite = sprites.find(
    (item: any) => String(item.name).toUpperCase() === resourceName.toUpperCase(),
  );
  const canvasIds = new Set<number>();
  const spriteNames = new Set<string>(sprite ? [String(sprite.name)] : []);
  if (sprite?.canvas_id != null) canvasIds.add(Number(sprite.canvas_id));
  for (const frame of sprite?.frames ?? [])
    if (frame.canvas_id != null) canvasIds.add(Number(frame.canvas_id));
  for (const canvasId of canvasIds) {
    const canvas = canvases.find((item: any) => Number(item.canvas_id) === canvasId);
    for (const command of canvas?.commands ?? []) {
      if (command.type === "draw_sprite") spriteNames.add(String(command.name));
      if (command.type === "draw_canvas") {
        canvasIds.add(Number(command.source_canvas_id));
        if (command.mask_canvas_id != null) canvasIds.add(Number(command.mask_canvas_id));
      }
    }
  }
  return serialize({
    sprite,
    referencedSprites: sprites.filter((item: any) =>
      [...spriteNames].some(
        (name) => String(item.name).toUpperCase() === String(name).toUpperCase(),
      ),
    ),
    referencedSpriteGeometry: Object.fromEntries(
      sprites
        .filter((item: any) =>
          [...spriteNames].some(
            (name) => String(item.name).toUpperCase() === String(name).toUpperCase(),
          ),
        )
        .map((item: any) => [
          String(item.name).toUpperCase(),
          {
            size: item.size,
            position: item.position,
            firstFrame: item.frames?.[0]
              ? {
                  source_rectangle: item.frames[0].source_rectangle,
                  offset: item.frames[0].offset,
                }
              : null,
          },
        ]),
    ),
    canvases: canvases.filter((item: any) => canvasIds.has(Number(item.canvas_id))),
  });
}

function downloadSummary(download?: {
  name: string;
  bytes: Uint8Array;
  size?: number;
  projectMagic?: Uint8Array;
  projectManifest?: import("@/platform/browserProject").BrowserManifest;
  projectIdentity?: import("@/platform/projectFileManifestTransfer").ProjectFileIdentitySummary;
  inputReplay?: Uint8Array;
}): unknown {
  if (!download) return null;
  const inputReplay =
    download.inputReplay ??
    (/^input-replay_\d{8}-\d{6}\.jsonl$/.test(download.name) ? download.bytes : undefined);
  const replay = inputReplay ? inputReplaySummary(inputReplay) : undefined;
  return {
    name: download.name,
    size: download.size ?? download.bytes.length,
    magic: [...download.bytes.slice(0, 4)],
    ...(download.projectMagic ? { projectMagic: [...download.projectMagic] } : {}),
    ...(download.projectManifest
      ? {
          projectHashes: Object.fromEntries(
            download.projectManifest.files
              .filter((file) => file.category !== "resource")
              .map((file) => [file.relative_path, hex(file.content_hash)]),
          ),
          projectRevision: download.projectManifest.project_revision,
          projectIdentityFiles: download.projectManifest.files.map((file) => ({
            relativePath: file.relative_path,
            category: file.category,
            // For source text this is the submitted UTF-8 payload digest; for Resource it is raw.
            contentHash: hex(file.content_hash),
            payloadKind: file.payload.type,
            byteLength:
              file.payload.type === "external"
                ? file.payload.byteLength
                : file.payload.type === "bytes"
                  ? file.payload.value.length
                  : new TextEncoder().encode(file.payload.value).length,
          })),
        }
      : {}),
    ...replay,
    ...(download.projectIdentity
      ? {
          projectRevision: download.projectIdentity.projectRevision,
          projectHashes: Object.fromEntries(
            download.projectIdentity.files
              .filter((file) => file.category !== "resource")
              .map((file) => [file.relativePath, file.contentHash]),
          ),
          projectIdentityFiles: download.projectIdentity.files,
        }
      : {}),
  };
}

export function inputReplaySummary(bytes: Uint8Array): Record<string, unknown> {
  let lines: string[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd();
    if (!text) return { replayParseError: "input replay is empty" };
    lines = text.split("\n");
  } catch {
    return { replayParseError: "input replay is not valid UTF-8" };
  }
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const record = JSON.parse(line) as unknown;
      if (record == null || typeof record !== "object" || Array.isArray(record))
        return { replayParseError: `input replay line ${index + 1} is not an object` };
      records.push(record as Record<string, unknown>);
    } catch {
      return { replayParseError: `input replay line ${index + 1} is not valid JSON` };
    }
  }
  return { replayHeader: records[0], replaySteps: records.slice(1) };
}

function serialize(value: unknown): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  return value;
}

function coreSerialize(value: unknown): any {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`Core companion integer exceeds the exact JSON range: ${value}`);
    return Number(value);
  }
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(coreSerialize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, coreSerialize(child)]),
    );
  return value;
}

function coreProtocolActions(records: unknown[]): unknown[] {
  const services = new Map<string, { kind: unknown; operation: unknown }>();
  const storage = new Map<string, { namespace: unknown; relativePath: unknown }>();
  const actions: unknown[] = [];
  for (const record of records as Array<{
    direction?: string;
    message?: { type?: string; value?: Record<string, any> };
  }>) {
    const message = record.message;
    const value = message?.value;
    const requestId = String(value?.request_id ?? "");
    if (record.direction === "receive" && message?.type === "service_request")
      services.set(requestId, { kind: value?.kind, operation: value?.operation });
    else if (record.direction === "receive" && message?.type === "storage_request")
      storage.set(requestId, {
        namespace: value?.namespace,
        relativePath: value?.relative_path,
      });
    else if (record.direction === "send" && message?.type === "input")
      actions.push({
        kind: "input",
        intent: value?.intent,
        messageSkip: value?.message_skip ?? false,
      });
    else if (record.direction === "send" && message?.type === "service_response") {
      const service = services.get(requestId);
      if (!service) throw new Error(`Core companion cannot resolve service request ${requestId}`);
      actions.push({ kind: "service_response", service, result: value?.result });
    } else if (record.direction === "send" && message?.type === "storage_response") {
      const request = storage.get(requestId);
      if (!request) throw new Error(`Core companion cannot resolve storage request ${requestId}`);
      actions.push({ kind: "storage_response", storage: request, result: value?.result });
    }
  }
  return actions;
}

function coreCheckpointProjection(
  records: unknown[],
  presentation: Record<string, unknown>,
): Record<string, unknown> {
  const typed = records as Array<{
    channel?: string;
    direction?: string;
    message?: { type?: string; value?: Record<string, any> };
  }>;
  const actionTypes = new Set(["start", "input", "service_response", "storage_response"]);
  const boundaries: number[] = [];
  for (const [index, record] of typed.entries())
    if (record.direction === "send" && actionTypes.has(record.message?.type ?? ""))
      boundaries.push(index);
  const boundary = boundaries.at(-1) ?? -1;
  const precedingBoundary = boundaries.at(-2) ?? -1;
  const afterBoundary = typed.slice(boundary + 1);
  // submit_runtime_and_pump records the fused response before its submitted message id is known.
  // If no runtime output follows the latest action record, use the bounded preceding window.
  const checkpointRecords = afterBoundary.some(
    (record) => record.direction === "receive" && (record.channel ?? "runtime") === "runtime",
  )
    ? afterBoundary
    : typed.slice(precedingBoundary + 1, boundary);
  const services: unknown[] = [];
  const storage: unknown[] = [];
  const otherOutboundTags: number[] = [];
  for (const record of checkpointRecords) {
    if (record.direction !== "receive" || (record.channel ?? "runtime") !== "runtime") continue;
    const message = record.message;
    const value = message?.value;
    if (message?.type === "service_request")
      services.push({
        kind: value?.kind,
        operation: value?.operation,
        operationVersion: value?.operation_version,
        payload: value?.payload,
      });
    else if (message?.type === "storage_request")
      storage.push({
        namespace: value?.namespace,
        relativePath: value?.relative_path,
        operation: value?.operation,
      });
    else if (message?.type) otherOutboundTags.push(runtimeMessageTag(message.type));
  }
  return coreSerialize({
    normalizedState: { ...presentation, services, storage, otherOutboundTags },
    protocolActions: coreProtocolActions(records),
    setupMessages: capturedCoreSetupMessages(typed),
  });
}

export function capturedCoreSetupMessages(
  records: Array<{
    channel?: string;
    direction?: string;
    message?: { type?: string; value?: Record<string, any> };
  }>,
): unknown[] {
  const runtime = records.filter((record) => (record.channel ?? "runtime") === "runtime");
  const serverHello = runtime.findIndex(
    (record) => record.direction === "receive" && record.message?.type === "server_hello",
  );
  if (serverHello < 0)
    throw new Error("Core companion capture did not observe the real server_hello boundary");
  const manifest = runtime.findIndex(
    (record, index) =>
      index > serverHello &&
      record.direction === "send" &&
      record.message?.type === "project_manifest",
  );
  if (manifest < 0)
    throw new Error("Core companion capture did not observe project_manifest after server_hello");
  const start = runtime.findIndex(
    (record, index) =>
      index > manifest && record.direction === "send" && record.message?.type === "start",
  );
  if (start < 0)
    throw new Error("Core companion capture did not observe start after project_manifest");

  const lifecycleSubmissions = runtime
    .slice(manifest + 1, start)
    .filter((record) => record.direction === "send" && record.message?.type != null);
  if (lifecycleSubmissions.length !== 1 || lifecycleSubmissions[0].message?.type !== "project_load")
    throw new Error(
      "Core companion cannot place messages submitted after project_manifest and before start; expected only project_load",
    );

  const setup = runtime
    .slice(serverHello + 1, manifest)
    .filter((record) => record.direction === "send" && record.message?.type != null);
  const lifecycleTypes = new Set(["client_hello", "project_manifest", "project_load", "start"]);
  const invalid = setup.find((record) => lifecycleTypes.has(record.message?.type ?? ""));
  if (invalid)
    throw new Error(
      `Core companion setup contains reserved lifecycle message ${invalid.message?.type ?? "unknown"}`,
    );
  return setup.map((record) => record.message);
}

function runtimeMessageTag(type: string): number {
  const tags: Record<string, number> = {
    server_hello: 1,
    version_rejected: 2,
    project_load_report: 11,
    project_analysis_request: 13,
    key_macro_state_changed: 17,
    state_changed: 21,
    exit_requested: 22,
    configuration_update_prepared: 25,
    configuration_update_committed: 27,
    client_preferences_applied: 29,
    wait_changed: 32,
    projection_state: 36,
    input_undo_state_changed: 38,
    presentation_snapshot: 40,
    presentation_delta: 41,
    effect_batch: 42,
    state_export_ready: 61,
    state_import_accepted: 63,
    state_import_ready: 66,
    state_export_chunk: 68,
    shutdown_ready: 91,
    fault: 92,
    acknowledge: 93,
    runtime_resynchronized: 96,
    diagnostic: 97,
    log: 98,
  };
  const tag = tags[type];
  if (tag == null) throw new Error(`Core companion cannot map runtime message tag ${type}`);
  return tag;
}
