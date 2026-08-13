import type { FrontendBridge } from "@/core/types";
import type { ExportState, LogNotificationPolicy } from "@/stores/runtimeState";

interface RuntimeCompiledCacheContext {
  bridge: Pick<FrontendBridge, "cancelCompiledCacheExport" | "writeCompiledCacheChunk">;
  exportState(): ExportState | undefined;
  replaceExportState(state: ExportState | undefined): void;
  request(activeExport: ExportState): Promise<void>;
  requestNextChunk(): Promise<void>;
  finishTransfer(activeExport: ExportState): Promise<void>;
  cancelRuntimeExport(): Promise<void>;
  beginStatus(message: string): number;
  finishStatus(token: number | undefined, message: string): void;
  clearStatus(token?: number): void;
  projectLoading(): boolean;
  diagnosisExporting(): boolean;
  resumeDiagnosisExport(): Promise<void>;
  logWarning(message: string, notificationPolicy?: LogNotificationPolicy): void;
}

/** Own the compiled-cache-only timer, status, and host-write lifecycle. */
export class RuntimeCompiledCacheExportState {
  private timer: number | undefined;

  constructor(private readonly context: RuntimeCompiledCacheContext) {}

  clearTimer(): void {
    if (this.timer == null) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(delayMs = 0): void {
    if (this.timer != null) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.begin();
    }, delayMs);
  }

  async begin(): Promise<void> {
    if (this.context.exportState()) return;
    const activeExport: ExportState = {
      name: "compiled-project.reracache",
      kind: "compiled_cache",
      chunks: [],
      received: 0,
    };
    this.context.replaceExportState(activeExport);
    activeExport.statusToken = this.context.beginStatus(
      "正在后台生成项目缓存，可继续游戏，但游戏运行和响应速度可能暂时受到影响…",
    );
    try {
      await this.context.request(activeExport);
    } catch (error) {
      await this.fail(activeExport, error);
    }
  }

  enqueueHostWrite(
    activeExport: ExportState,
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): void {
    activeExport.hostWrite = (activeExport.hostWrite ?? Promise.resolve()).then(async () => {
      if (activeExport.hostWriteFailure) return;
      try {
        await this.context.bridge.writeCompiledCacheChunk(bytes, reset, complete);
      } catch (error) {
        activeExport.hostWriteFailure = { error };
      }
    });
  }

  continue(activeExport: ExportState, complete: boolean): void {
    void (async () => {
      await activeExport.hostWrite;
      if (this.context.exportState() !== activeExport) return;
      if (activeExport.hostWriteFailure) throw activeExport.hostWriteFailure.error;
      if (complete) await this.context.finishTransfer(activeExport);
      else await this.context.requestNextChunk();
    })().catch((error) => {
      void this.fail(activeExport, error);
    });
  }

  async fail(
    activeExport: ExportState,
    error: unknown,
    notificationPolicy: LogNotificationPolicy = "all",
  ): Promise<void> {
    if (this.context.exportState() !== activeExport) return;
    this.finish(activeExport, "failed");
    try {
      await this.context.bridge.cancelCompiledCacheExport();
    } catch (cancelError) {
      this.context.logWarning(`清理项目缓存失败：${String(cancelError)}`);
    }
    this.context.logWarning(`项目缓存生成失败：${String(error)}`, notificationPolicy);
    if (this.context.diagnosisExporting() && !this.context.exportState())
      await this.context.resumeDiagnosisExport();
  }

  finish(activeExport: ExportState, outcome: "success" | "cancelled" | "failed"): void {
    if (this.context.exportState() !== activeExport || activeExport.kind !== "compiled_cache")
      return;
    this.context.replaceExportState(undefined);
    if (outcome === "success" && !this.context.projectLoading())
      this.context.finishStatus(activeExport.statusToken, "项目缓存已保存。");
    else this.context.clearStatus(activeExport.statusToken);
  }

  async cancel(): Promise<void> {
    const current = this.context.exportState();
    const activeExport = current?.kind === "compiled_cache" ? current : undefined;
    if (activeExport) {
      this.finish(activeExport, "cancelled");
      await activeExport.hostWrite;
    } else {
      this.context.clearStatus();
    }
    try {
      await this.context.cancelRuntimeExport();
    } finally {
      await this.context.bridge.cancelCompiledCacheExport();
    }
  }
}
