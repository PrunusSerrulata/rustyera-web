import {
  configureServiceLifecycle,
  serviceLifecycleSummary,
  serviceLifecycleSnapshot,
  type ServiceLifecycleConfiguration,
} from "@/testing/serviceLifecycle";
import type { Pinia } from "pinia";
import {
  NativeEvidenceCollector,
  mergeNativeEvidence,
  compareProtocolIdentity,
  compactStorageRecords,
  type NativeEvidencePage,
} from "@/testing/nativeEvidence";

import { observedLineText } from "@/testing/presentationText";
import { performancePresentationInventory } from "@/testing/performancePresentationInventory";
import { hex } from "@/platform/browserProjectFilesystem";
import { currentGameViewportMeasurement } from "@/platform/viewportMeasurement";
import type { RuntimeTestConfiguration } from "@/stores/runtime";
import { useRuntimeStore } from "@/stores/runtime";
import {
  calibratePerformanceFrames,
  installPerformanceAuditObservers,
  performanceAuditEnabled,
  performanceAuditProgress,
  performanceAuditSnapshot,
  resetPerformanceAudit,
  takePerformanceAudit,
  waitForPendingPerformanceObservations,
} from "@/testing/performanceAudit";

export interface WebTestControl {
  configure(configuration: RuntimeTestConfiguration): void;
  configureServiceLifecycle(configuration: ServiceLifecycleConfiguration): void;
  openProject(): Promise<void>;
  waitForStableObservation(
    timeoutMs?: number,
    summary?: boolean,
    progressOnly?: boolean,
  ): Promise<Record<string, unknown>>;
  snapshot(): Record<string, unknown>;
  snapshotSummary(): Record<string, unknown>;
  performanceProgress(): Record<string, unknown>;
  performancePresentationInventory(): Record<string, number | boolean>;
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
  takePerformanceAudit(limit?: number, includeIdentity?: boolean): Promise<Record<string, unknown>>;
  waitForPendingPerformanceObservations(timeoutMs?: number): Promise<void>;
  resetPerformanceAudit(): Promise<{ frontendEpoch: number; nativeEpoch: number }>;
  takeNativeReplayBytes(
    id: number,
    offset: number,
  ): { offset: number; totalBytes: number; hex: string };
  frontendPerformanceAudit(): Record<string, unknown>;
  frontendPerformanceAuditProgress(): Record<string, number>;
  resetFrontendPerformanceAudit(): { frontendEpoch: number };
  performanceCheckpoint(
    watches: string[],
    protocolCursor?: number | null,
  ): Promise<Record<string, unknown>>;
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
  // Servicing the background pump and observing it must not keep an otherwise
  // ready input boundary unstable. The complete-snapshot watchdog still keeps
  // these fields, so hangs remain visible in persisted evidence.
  delete observed.cooperativeBackgroundWorkRevision;
  delete observed.performanceAudit;
  delete observed.memory;
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

/** Prefer a rendered frame, but keep native WebViews that temporarily suppress
 * animation callbacks from deadlocking a test observation indefinitely. */
export function waitForObservationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const handles: { frame?: number; timer?: number } = {};
    const finish = () => {
      if (finished) return;
      finished = true;
      if (handles.frame !== undefined) cancelAnimationFrame(handles.frame);
      if (handles.timer !== undefined) window.clearTimeout(handles.timer);
      resolve();
    };
    handles.timer = window.setTimeout(finish, 16);
    handles.frame = requestAnimationFrame(finish);
    if (finished) {
      cancelAnimationFrame(handles.frame);
      window.clearTimeout(handles.timer);
    }
  });
}

/** Revision-based progress only. Never read DOM geometry, output bodies, resources,
 * debugger values, live memory, or the wire ledger on the measured polling path. */
export function capturePerformanceProgress(
  store: ReturnType<typeof useRuntimeStore>,
): Record<string, unknown> {
  return serialize({
    bridgeKind: store.bridgeKind,
    phase: store.phase,
    runtimeEpoch: store.runtimeEpoch,
    status: store.status,
    projectOpen: store.projectOpen,
    projectLoading: store.projectLoading,
    loadingProgress: store.projectLoading
      ? { label: store.projectLoadProgressLabel, value: store.projectLoadProgressValue }
      : null,
    canInteract: store.canInteract,
    wait: store.presentation.inputWait,
    presentationRevision: store.presentation.revision,
    historyRevision: store.presentation.historyRevision,
    sceneRevision: store.presentation.scene.revision,
    fault: store.fault,
    logs: store.logs.slice(-100),
    serviceEvidence: store.testRuntimeEvidenceSummary(),
    transfer: store.testTransferState(),
    diagnosisExporting: store.diagnosisExporting,
    saveTransfer: {
      mode: store.traditionalSaveDialogMode,
      busy: store.traditionalSaveTransferBusy,
      error: store.traditionalSaveTransferError,
      overwriteSlot: store.traditionalSaveOverwriteSlot,
    },
  });
}

export function installWebTestControl(pinia: Pinia): void {
  const store = useRuntimeStore(pinia);
  let nativeEvidence = new NativeEvidenceCollector();
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
      viewport: {
        observed: store.viewportMeasurement,
        current: currentGameViewportMeasurement(),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        assistanceHeight:
          document.querySelector<HTMLElement>(".interaction-assist-slot")?.clientHeight ?? null,
        windowGeometry: store.clientWindowGeometrySnapshot(),
      },
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
        store.presentation.audio.map((channel: (typeof store.presentation.audio)[number]) => [
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
  const performanceProgress = (): Record<string, unknown> => capturePerformanceProgress(store);

  window.__RUSTYERA_TEST__ = {
    configure: (configuration) => store.configureTestRun(configuration),
    configureServiceLifecycle,
    openProject: () => store.openProject(),
    snapshot,
    snapshotSummary,
    performanceProgress,
    performancePresentationInventory: () => {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      return performancePresentationInventory(store.presentation);
    },
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
      nativeEvidence = new NativeEvidenceCollector();
      return { frontendEpoch, nativeEpoch };
    },
    async waitForPendingPerformanceObservations(timeoutMs = 30_000) {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      await waitForPendingPerformanceObservations(timeoutMs);
    },
    takeNativeReplayBytes(id: number, offset: number) {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      return nativeEvidence.takeReplayBytes(id, offset);
    },
    async takePerformanceAudit(limit = 512, includeIdentity = false) {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
        throw new Error("performance telemetry chunk limit must be between 1 and 1024");
      const { invoke } = await import("@tauri-apps/api/core");
      const native = await invoke<{ nativeEvidence: NativeEvidencePage }>(
        "performance_audit_take",
        { limit, includeIdentity },
      );
      nativeEvidence.accept(native.nativeEvidence);
      const exported = nativeEvidence.exportPage(native.nativeEvidence);
      // These are independent observation boundaries, not an atomic cross-host snapshot.
      // Never add synthetic transport records to the authority's sequence space.
      return {
        native: {
          ...native,
          nativeEvidence: exported.page,
          nativeEvidencePendingPages: exported.remainingPages,
        },
        frontend: takePerformanceAudit(limit),
        atomic: false,
      };
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
    async performanceCheckpoint(watches, protocolCursor = null) {
      if (!performanceAuditEnabled()) throw new Error("performance audit telemetry is disabled");
      const wait = store.presentation.inputWait as
        { kind?: string; wait_id?: unknown; generation?: unknown } | undefined;
      const variables = await store.inspectTypedWatches(watches);
      const initialCheckpoint = protocolCursor == null;
      const protocol = store.testRuntimeEvidence(
        undefined,
        initialCheckpoint ? 0 : protocolCursor,
      ) as { recordCursor?: number; records?: unknown[] };
      if (!Number.isSafeInteger(protocol.recordCursor))
        throw new Error("performance protocol evidence omitted its cursor");
      let nativeRecords: ReturnType<NativeEvidenceCollector["take"]> = [];
      if (store.bridgeKind === "tauri") {
        const { invoke } = await import("@tauri-apps/api/core");
        const deadline = performance.now() + 30_000;
        let complete = false;
        for (let page = 0; page < 1024; page++) {
          if (performance.now() >= deadline)
            throw new Error("native evidence drain deadline exceeded");
          const chunk = await invoke<{ nativeEvidence: NativeEvidencePage; evidenceOnly: boolean }>(
            "performance_audit_take",
            {
              limit: 512,
              includeIdentity: false,
              evidenceOnly: true,
            },
          );
          if (chunk.evidenceOnly !== true)
            throw new Error("performance_audit_take evidenceOnly routing is not installed");
          nativeEvidence.accept(chunk.nativeEvidence);
          if (performance.now() >= deadline)
            throw new Error("native evidence drain deadline exceeded");
          if (chunk.nativeEvidence.remainingRecords === 0) {
            complete = true;
            break;
          }
        }
        if (!complete) throw new Error("native evidence drain page limit exceeded");
        nativeRecords = nativeEvidence.take();
      }
      const protocolRecords = mergeNativeEvidence(protocol.records ?? [], nativeRecords);
      const replayActions = initialCheckpoint
        ? []
        : nativeEvidence.projectReplayActions(coreProtocolActions(protocolRecords));
      const checkpoint = serialize({
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
        storage: {
          ...store.testRuntimeEvidenceSummary(),
          records: compactStorageRecords(protocolRecords),
        },
        transfer: store.testTransferState(),
        saveTransfer: {
          mode: store.traditionalSaveDialogMode,
          busy: store.traditionalSaveTransferBusy,
          error: store.traditionalSaveTransferError,
          overwriteSlot: store.traditionalSaveOverwriteSlot,
        },
      });
      // The Core projection already returns JSON-safe values. Do not walk its
      // full scene/resource tree a second time in the generic serializer.
      return {
        ...checkpoint,
        coreProjection: {
          ...coreCheckpointProjection(
            protocolRecords,
            {
              phase: store.phase,
              wait: store.presentation.inputWait,
              lines: store.presentation.lines,
              resources: store.presentation.resources,
              scene: store.presentation.scene,
              variables,
            },
            store.bridgeKind === "tauri",
            initialCheckpoint,
            false,
          ),
          protocolActions: initialCheckpoint ? [] : coreSerialize(replayActions),
          protocolCursor: protocol.recordCursor,
        },
      };
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
    async waitForStableObservation(timeoutMs = 30_000, summary = false, progressOnly = false) {
      if (progressOnly && !performanceAuditEnabled())
        throw new Error("performance progress requires an audit build");
      const deadline = performance.now() + timeoutMs;
      let previous = "";
      let stableFrames = 0;
      while (performance.now() < deadline) {
        const current = stableObservationSignature(
          progressOnly ? performanceProgress() : snapshotSummary(),
        );
        const observable = isStableObservationCandidate(
          store.phase,
          store.canInteract,
          store.fault,
          store.traditionalSaveDialogMode != null && !store.traditionalSaveTransferBusy,
          store.diagnosisExporting,
        );
        if (observable && current === previous) stableFrames += 1;
        else stableFrames = 0;
        if (stableFrames >= 2)
          return progressOnly ? performanceProgress() : summary ? snapshotSummary() : snapshot();
        previous = current;
        await waitForObservationFrame();
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

export function coreSerialize(value: unknown, path = "$"): any {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`Core companion integer at ${path} exceeds the exact JSON range: ${value}`);
    return Number(value);
  }
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value))
    return value.map((child, index) => coreSerialize(child, `${path}[${index}]`));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        coreSerialize(child, coreSerializePath(path, key)),
      ]),
    );
  return value;
}

function coreSerializePath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export function coreProtocolActions(records: unknown[]): unknown[] {
  const services = new Map<string, { kind: unknown; operation: unknown }>();
  const storage = new Map<string, { namespace: unknown; relativePath: unknown }>();
  const actions: unknown[] = [];
  const typed = records as Array<{
    direction?: string;
    channel?: string;
    epoch?: unknown;
    messageId?: unknown;
    nativeCompletion?: boolean;
    message?: { type?: string; value?: Record<string, any> };
  }>;
  const requestKey = (record: (typeof typed)[number]) =>
    `${record.channel ?? "runtime"}/${record.epoch ?? "none"}/${record.message?.value?.request_id ?? ""}`;
  // Index complete requests before interpreting submits: fused native IPC can expose
  // its incoming envelopes before the frontend learns its own submitted message ID.
  for (const record of typed) {
    const value = record.message?.value;
    if (record.direction === "receive" && record.message?.type === "service_request")
      services.set(requestKey(record), { kind: value?.kind, operation: value?.operation });
    if (record.direction === "receive" && record.message?.type === "storage_request")
      storage.set(requestKey(record), {
        namespace: value?.namespace,
        relativePath: value?.relative_path,
      });
  }
  const sends = typed.filter(
    (record) => record.direction === "send" && (record.channel ?? "runtime") === "runtime",
  );
  if (typed.some((record) => record.nativeCompletion))
    sends.sort(
      (a, b) =>
        compareProtocolIdentity(a.epoch, b.epoch) ||
        compareProtocolIdentity(a.messageId, b.messageId),
    );
  for (const record of sends) {
    const message = record.message;
    const value = message?.value;
    const requestId = requestKey(record);
    if (message?.type === "input")
      actions.push({
        kind: "input",
        intent: value?.intent,
        messageSkip: value?.message_skip ?? false,
      });
    else if (record.direction === "send" && message?.type === "service_response") {
      const service = services.get(requestId);
      if (!service) throw new Error(`Core companion cannot resolve service request ${requestId}`);
      actions.push({
        kind: "service_response",
        service,
        result: value?.result,
        ...(record.nativeCompletion ? { nativeCompletion: true } : {}),
      });
    } else if (record.direction === "send" && message?.type === "storage_response") {
      const request = storage.get(requestId);
      if (!request) throw new Error(`Core companion cannot resolve storage request ${requestId}`);
      actions.push({
        kind: "storage_response",
        storage: request,
        result: value?.result,
        ...(record.nativeCompletion ? { nativeCompletion: true } : {}),
      });
    }
  }
  return actions;
}

function coreCheckpointProjection(
  records: unknown[],
  presentation: Record<string, unknown>,
  nativePreparedProject: boolean,
  includeSetupMessages = true,
  includeProtocolActions = true,
): Record<string, unknown> {
  const typed = records as Array<{
    nativeCompletion?: boolean;
    channel?: string;
    direction?: string;
    epoch?: unknown;
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
  const requestKey = (record: (typeof typed)[number]) =>
    `${record.epoch ?? "none"}/${record.message?.type?.replace("_response", "_request")}/${record.message?.value?.request_id}`;
  const completed = new Set(
    typed
      .filter(
        (record) =>
          record.direction === "send" &&
          ["service_response", "storage_response"].includes(record.message?.type ?? ""),
      )
      .map(requestKey),
  );
  for (const record of checkpointRecords) {
    // A completed request is not outstanding, regardless of which host route handled it.
    if (completed.has(requestKey(record))) continue;
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
  return {
    normalizedState: coreNormalizeCheckpointValue({
      ...presentation,
      wait: coreStableInputWait(presentation.wait),
      variables: coreCheckpointVariables(presentation.variables),
      services,
      storage,
      otherOutboundTags,
    }),
    protocolActions: includeProtocolActions ? coreSerialize(coreProtocolActions(records)) : [],
    setupMessages: includeSetupMessages
      ? coreSerialize(capturedCoreSetupMessages(typed, nativePreparedProject))
      : [],
  };
}

export function coreNormalizeCheckpointValue(value: unknown): any {
  if (typeof value === "bigint")
    return value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)
      ? value.toString()
      : Number(value);
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(coreNormalizeCheckpointValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, coreNormalizeCheckpointValue(child)]),
    );
  return value;
}

export function coreStableInputWait(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Core companion input wait is malformed");
  const wait = value as Record<string, unknown>;
  // Keep this mapping aligned with runtime-tester's StableInputWait. Session-local
  // wait IDs, submission tokens, generations, and deadlines are deliberately excluded.
  return {
    kind: wait.kind,
    stability: wait.stability,
    oneInput: wait.one_input,
    stopMessageSkip: wait.stop_message_skip,
    systemInput: wait.system_input,
    mouseInput: wait.mouse_input,
    defaultValue: wait.default_value ?? null,
    displayTime: wait.display_time,
    timeoutMessage: wait.timeout_message ?? null,
    viewportPolicy: wait.viewport_policy,
  };
}

export function coreCheckpointVariables(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Core companion typed variables are malformed");
  const observations = (value as { values?: unknown }).values;
  if (observations == null || typeof observations !== "object" || Array.isArray(observations))
    throw new Error("Core companion typed variables omitted values");
  return Object.fromEntries(
    Object.entries(observations).map(([watch, observation]) => {
      const typed = observation as {
        present?: boolean;
        value?: { type?: string; value?: unknown };
      };
      if (typed?.present !== true || typed.value == null)
        throw new Error(`Core companion watch ${watch} is unavailable`);
      const scalar = typed.value.value;
      const valid =
        (typed.value.type === "integer" &&
          (typeof scalar === "bigint" ||
            (typeof scalar === "number" && Number.isSafeInteger(scalar)))) ||
        (typed.value.type === "string" && typeof scalar === "string") ||
        (typed.value.type === "boolean" && typeof scalar === "boolean");
      if (!valid) throw new Error(`Core companion watch ${watch} has an unsupported value`);
      return [watch, scalar];
    }),
  );
}

export function capturedCoreSetupMessages(
  records: Array<{
    channel?: string;
    direction?: string;
    message?: { type?: string; value?: Record<string, any> };
  }>,
  nativePreparedProject = false,
): unknown[] {
  const runtime = records.filter((record) => (record.channel ?? "runtime") === "runtime");
  const serverHello = runtime.findIndex(
    (record) => record.direction === "receive" && record.message?.type === "server_hello",
  );
  if (serverHello < 0)
    throw new Error("Core companion capture did not observe the real server_hello boundary");
  const start = runtime.findIndex(
    (record, index) =>
      index > serverHello && record.direction === "send" && record.message?.type === "start",
  );
  if (start < 0) throw new Error("Core companion capture did not observe start after server_hello");
  const manifest = runtime.findIndex(
    (record, index) =>
      index > serverHello &&
      index < start &&
      record.direction === "send" &&
      record.message?.type === "project_manifest",
  );
  if (manifest < 0 && !nativePreparedProject)
    throw new Error("Core companion capture did not observe project_manifest after server_hello");

  const setupEnd = manifest < 0 ? start : manifest;
  const setup = runtime
    .slice(serverHello + 1, setupEnd)
    .filter((record) => record.direction === "send" && record.message?.type != null);
  const lifecycleTypes = new Set(["client_hello", "project_manifest", "project_load", "start"]);
  const invalid = setup.find((record) => lifecycleTypes.has(record.message?.type ?? ""));
  if (invalid)
    throw new Error(
      `Core companion setup contains reserved lifecycle message ${invalid.message?.type ?? "unknown"}`,
    );
  if (manifest < 0) return setup.map((record) => record.message);

  const lifecycleSubmissions = runtime
    .slice(manifest + 1, start)
    .filter((record) => record.direction === "send" && record.message?.type != null);
  if (lifecycleSubmissions.length !== 1 || lifecycleSubmissions[0].message?.type !== "project_load")
    throw new Error(
      "Core companion cannot place messages submitted after project_manifest and before start; expected only project_load",
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
