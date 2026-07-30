import type { Pinia } from "pinia";

import { plainLine } from "@/core/presentation";
import type { RuntimeTestConfiguration } from "@/stores/runtime";
import { useRuntimeStore } from "@/stores/runtime";

export interface WebTestControl {
  configure(configuration: RuntimeTestConfiguration): void;
  openProject(): Promise<void>;
  waitForStableObservation(timeoutMs?: number): Promise<Record<string, unknown>>;
  snapshot(): Record<string, unknown>;
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
): boolean {
  return (
    canInteract ||
    modalReady ||
    fault != null ||
    ["debug_paused", "stopped", "faulted", "shutting_down"].includes(phase)
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
      canInteract: store.canInteract,
      wait: store.presentation.inputWait,
      presentationRevision: store.presentation.revision,
      output: store.presentation.lines.map(plainLine),
      htmlIsland: store.presentation.htmlIsland,
      fault: store.fault,
      logs: store.logs.slice(-100),
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

function downloadSummary(download?: { name: string; bytes: Uint8Array }): unknown {
  if (!download) return null;
  return {
    name: download.name,
    size: download.bytes.length,
    magic: [...download.bytes.slice(0, 4)],
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
