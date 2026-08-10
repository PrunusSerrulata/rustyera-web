import type { Pinia } from "pinia";

import { plainLine } from "@/core/presentation";
import type { RuntimeTestConfiguration } from "@/stores/runtime";
import { useRuntimeStore } from "@/stores/runtime";

export interface WebTestControl {
  configure(configuration: RuntimeTestConfiguration): void;
  openProject(): Promise<void>;
  waitForStableObservation(timeoutMs?: number): Promise<Record<string, unknown>>;
  snapshot(): Record<string, unknown>;
  mediaPlacements(): Record<string, unknown>;
  mediaReplay(resourceName: string): Record<string, unknown>;
  inspect(watches: string[]): Promise<Record<string, unknown>>;
  exportSnapshot(): Promise<void>;
  exportTraditionalSave(): Promise<void>;
  takeDownload(timeoutMs?: number): Promise<{ name: string; bytes: number[] }>;
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

export function installWebTestControl(pinia: Pinia): void {
  const store = useRuntimeStore(pinia);
  const snapshot = (): Record<string, unknown> =>
    serialize({
      bridgeKind: store.bridgeKind,
      phase: store.phase,
      runtimeEpoch: store.runtimeEpoch,
      status: store.status,
      projectOpen: store.projectOpen,
      startupTelemetry: store.startupTelemetry,
      canInteract: store.canInteract,
      wait: store.presentation.inputWait,
      presentationRevision: store.presentation.revision,
      historyRevision: store.presentation.historyRevision,
      output: store.presentation.lines.map(plainLine),
      htmlIsland: store.presentation.htmlIsland,
      audio: Object.fromEntries(
        store.presentation.audio.map((channel: any) => [
          String(channel.channel_id),
          { resourceId: channel.resource_id, playing: channel.playing },
        ]),
      ),
      audioPlayback: store.testAudioPlaybackState(),
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
        notification: store.diagnosisNotification,
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

  window.__RUSTYERA_TEST__ = {
    configure: (configuration) => store.configureTestRun(configuration),
    openProject: () => store.openProject(),
    snapshot,
    mediaPlacements: () => presentationMedia(store.presentation),
    mediaReplay: (resourceName) => mediaReplay(store.presentation.resources, resourceName),
    inspect: (watches) => store.inspectWatches(watches),
    exportSnapshot: () => store.exportSnapshot("normal"),
    exportTraditionalSave: () => store.exportTraditionalSaveForTest(),
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
    async waitForStableObservation(timeoutMs = 30_000) {
      const deadline = performance.now() + timeoutMs;
      let previous = "";
      let stableFrames = 0;
      while (performance.now() < deadline) {
        const current = JSON.stringify(snapshot());
        const observable = isStableObservationCandidate(
          store.phase,
          store.canInteract,
          store.fault,
          store.traditionalSaveDialogMode != null && !store.traditionalSaveTransferBusy,
          store.diagnosisExporting,
        );
        if (observable && current === previous) stableFrames += 1;
        else stableFrames = 0;
        if (stableFrames >= 2) return snapshot();
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
  return serialize({ images, backgrounds: presentation.backgrounds ?? [] });
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
    canvases: canvases.filter((item: any) => canvasIds.has(Number(item.canvas_id))),
  });
}

function downloadSummary(download?: {
  name: string;
  bytes: Uint8Array;
  size?: number;
  projectMagic?: Uint8Array;
}): unknown {
  if (!download) return null;
  return {
    name: download.name,
    size: download.size ?? download.bytes.length,
    magic: [...download.bytes.slice(0, 4)],
    ...(download.projectMagic ? { projectMagic: [...download.projectMagic] } : {}),
  };
}

function serialize(value: unknown): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  return value;
}
