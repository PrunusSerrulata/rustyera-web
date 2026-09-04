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
  return JSON.stringify(observed);
}

export function installWebTestControl(pinia: Pinia): void {
  const store = useRuntimeStore(pinia);
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
