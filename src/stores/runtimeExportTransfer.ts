import { blake3 } from "@noble/hashes/blake3.js";

import { concatenateChunks } from "@/core/runtimeSupport";
import type { RuntimeMessage } from "@/core/types";
import { runtimeExportKind, type ExportState } from "@/stores/runtimeState";

interface RuntimeExportTransferContext {
  exportState(): ExportState | undefined;
  clearExportState(): void;
  send(message: RuntimeMessage): Promise<number | bigint>;
  setDiagnosisProgress(kind: ExportState["kind"], completed: number, total: number): void;
  failDiagnosis(activeExport: ExportState, message: string): Promise<void>;
  beginProjectFilePackaging(total: number): void;
  updateProjectFilePackaging(completed: number, total: number): void;
  writeProjectFileChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
  beginStateDownload(name: string, totalBytes: number): Promise<boolean>;
  writeStateDownload(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
  cancelStateDownload(): Promise<void>;
  failProjectFile(message?: string): Promise<void>;
  enqueueCompiledCacheWrite(
    activeExport: ExportState,
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): void;
  continueCompiledCache(activeExport: ExportState, complete: boolean): void;
  failCompiledCache(activeExport: ExportState, error: unknown): Promise<void>;
  finishExport(activeExport: ExportState): Promise<void>;
  diagnosisRetainedBytes(): number;
  logWarning(message: string): void;
  exportChunkBytes(): number;
}

const MAXIMUM_DIAGNOSIS_TRANSFER_BYTES = 128 * 1024 * 1024;
const MAXIMUM_DIAGNOSIS_RETAINED_BYTES = 256 * 1024 * 1024;

/** Coordinate protocol transfer descriptors and chunks without owning export-specific UI. */
export class RuntimeExportTransferState {
  constructor(private readonly context: RuntimeExportTransferContext) {}

  async handleReady(ready: any, correlationId: unknown): Promise<void> {
    const activeExport = this.context.exportState();
    if (!activeExport) return;
    const expectedKind = runtimeExportKind(activeExport);
    if (
      activeExport.requestMessageId !== String(correlationId) ||
      ready.kind !== expectedKind ||
      (ready.result.type === "ready" && ready.result.transfer?.kind !== expectedKind)
    ) {
      const message = "Runtime 状态导出响应与当前传输不匹配";
      if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, `诊断信息导出失败：${message}`);
        return;
      }
      throw new Error(message);
    }
    activeExport.requestMessageId = undefined;
    if (ready.result.type !== "ready") {
      const label =
        expectedKind === "input_replay"
          ? "操作序列"
          : expectedKind === "traditional_save"
            ? "传统存档"
            : "快照";
      const message = `当前状态不能导出${label}：${(ready.result.reasons ?? []).join(", ")}`;
      const failedKind = activeExport.kind;
      if (failedKind !== "compiled_cache") this.context.logWarning(message);
      if (failedKind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, message);
      } else if (failedKind === "project_file") {
        await this.context.failProjectFile(message);
      } else if (failedKind === "compiled_cache") {
        await this.context.failCompiledCache(activeExport, message);
      } else {
        this.context.clearExportState();
      }
      return;
    }
    const totalBytes = Number(ready.result.transfer.total_bytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      const message = "Runtime 返回了无效的状态导出长度";
      if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, `诊断信息导出失败：${message}`);
        return;
      }
      throw new Error(message);
    }
    if (
      activeExport.kind.startsWith("diagnosis_") &&
      totalBytes > MAXIMUM_DIAGNOSIS_TRANSFER_BYTES
    ) {
      await this.context.failDiagnosis(
        activeExport,
        `诊断信息导出失败：单项数据超过 ${MAXIMUM_DIAGNOSIS_TRANSFER_BYTES / 1024 / 1024} MiB 安全限制`,
      );
      return;
    }
    if (
      activeExport.kind.startsWith("diagnosis_") &&
      this.context.diagnosisRetainedBytes() + totalBytes > MAXIMUM_DIAGNOSIS_RETAINED_BYTES
    ) {
      await this.context.failDiagnosis(
        activeExport,
        `诊断信息导出失败：归档源数据合计超过 ${MAXIMUM_DIAGNOSIS_RETAINED_BYTES / 1024 / 1024} MiB 安全限制`,
      );
      return;
    }
    activeExport.descriptor = ready.result.transfer;
    if (activeExport.kind.startsWith("diagnosis_") && Number.isSafeInteger(totalBytes))
      this.context.setDiagnosisProgress(activeExport.kind, 0, totalBytes);
    if (activeExport.kind === "project_file") this.context.beginProjectFilePackaging(totalBytes);
    if (activeExport.kind === "download" || activeExport.kind === "input_replay_download") {
      try {
        if (!(await this.context.beginStateDownload(activeExport.name, totalBytes))) {
          await this.context.send({ type: "state_export_cancel", value: { kind: expectedKind } });
          this.context.clearExportState();
          return;
        }
        activeExport.digestHasher = blake3.create();
      } catch (error) {
        await this.context.cancelStateDownload();
        this.context.clearExportState();
        throw error;
      }
    }
    if (
      activeExport.kind !== "compiled_cache" &&
      activeExport.kind !== "project_file" &&
      activeExport.kind !== "download" &&
      activeExport.kind !== "input_replay_download"
    )
      activeExport.buffer = new Uint8Array(totalBytes);
    try {
      await this.requestChunk();
    } catch (error) {
      if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, `诊断信息导出失败：${String(error)}`);
      } else if (activeExport.kind === "compiled_cache") {
        await this.context.failCompiledCache(activeExport, error);
      } else if (
        activeExport.kind === "download" ||
        activeExport.kind === "input_replay_download"
      ) {
        await this.context.cancelStateDownload();
        this.context.clearExportState();
        throw error;
      } else {
        throw error;
      }
    }
  }

  async requestChunk(): Promise<void> {
    const activeExport = this.context.exportState();
    if (!activeExport?.descriptor) return;
    await this.context.send({
      type: "state_export_chunk_request",
      value: {
        transfer_id: activeExport.descriptor.transfer_id,
        offset: activeExport.received,
        maximum_bytes: this.context.exportChunkBytes(),
      },
    });
  }

  async handleChunk(chunk: any, dataBytes?: Uint8Array): Promise<void> {
    const activeExport = this.context.exportState();
    if (!activeExport?.descriptor) return;
    if (
      String(chunk.transfer_id) !== String(activeExport.descriptor.transfer_id) ||
      Number(chunk.offset) !== activeExport.received
    ) {
      if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(
          activeExport,
          "诊断信息导出失败：Runtime 分块关联或顺序无效",
        );
        return;
      }
      throw new Error("Runtime 状态导出分块关联或顺序无效");
    }
    const bytes =
      dataBytes ?? Uint8Array.from(chunk.data, (value: number | bigint) => Number(value));
    const reset = activeExport.received === 0;
    activeExport.received += bytes.length;
    if (activeExport.kind.startsWith("diagnosis_")) {
      this.context.setDiagnosisProgress(
        activeExport.kind,
        activeExport.received,
        Number(activeExport.descriptor.total_bytes),
      );
    }
    if (activeExport.kind === "project_file") {
      this.context.updateProjectFilePackaging(
        activeExport.received,
        Number(activeExport.descriptor.total_bytes),
      );
    }
    try {
      if (activeExport.kind === "compiled_cache") {
        this.context.enqueueCompiledCacheWrite(activeExport, bytes, reset, chunk.complete);
      } else if (activeExport.kind === "project_file") {
        await this.context.writeProjectFileChunk(bytes, reset, chunk.complete);
      } else if (
        activeExport.kind === "download" ||
        activeExport.kind === "input_replay_download"
      ) {
        activeExport.digestHasher?.update(bytes);
        // Commit only after the terminal length/digest validation below succeeds.
        await this.context.writeStateDownload(bytes, reset, false);
      } else if (activeExport.buffer) {
        activeExport.buffer.set(bytes, Number(chunk.offset));
      } else {
        activeExport.chunks.push(bytes);
      }
    } catch (error) {
      if (activeExport.kind === "project_file") {
        await this.context.failProjectFile();
      } else if (
        activeExport.kind === "download" ||
        activeExport.kind === "input_replay_download"
      ) {
        await this.context.cancelStateDownload();
      } else if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, `诊断信息导出失败：${String(error)}`);
      } else if (activeExport.kind === "compiled_cache") {
        await this.context.failCompiledCache(activeExport, error);
      } else {
        this.context.clearExportState();
      }
      if (activeExport.kind !== "compiled_cache" && !activeExport.kind.startsWith("diagnosis_"))
        throw error;
      return;
    }
    if (activeExport.kind === "compiled_cache") {
      this.context.continueCompiledCache(activeExport, chunk.complete);
      return;
    }
    try {
      if (!chunk.complete) await this.requestChunk();
      else if (activeExport.kind === "download" || activeExport.kind === "input_replay_download") {
        const expectedLength = Number(activeExport.descriptor.total_bytes);
        const actualDigest = activeExport.digestHasher?.digest();
        activeExport.digestHasher = undefined;
        const expectedDigest = Uint8Array.from(
          activeExport.descriptor.digest ?? [],
          (value: number | bigint) => Number(value),
        );
        if (
          activeExport.received !== expectedLength ||
          !actualDigest ||
          expectedDigest.length !== actualDigest.length ||
          expectedDigest.some((value, index) => value !== actualDigest[index])
        ) {
          await this.context.cancelStateDownload();
          this.context.clearExportState();
          throw new Error("Runtime 状态导出分块长度或摘要无效");
        }
        await this.context.writeStateDownload(new Uint8Array(), false, true);
        await this.context.finishExport(activeExport);
      } else if (activeExport.kind.startsWith("diagnosis_")) {
        const expectedLength = Number(activeExport.descriptor.total_bytes);
        const result =
          activeExport.buffer ?? concatenateChunks(activeExport.chunks, activeExport.received);
        const expectedDigest = Uint8Array.from(
          activeExport.descriptor.digest ?? [],
          (value: number | bigint) => Number(value),
        );
        const actualDigest = blake3(result);
        if (
          !Number.isSafeInteger(expectedLength) ||
          activeExport.received !== expectedLength ||
          expectedDigest.length !== actualDigest.length ||
          expectedDigest.some((value, index) => value !== actualDigest[index])
        ) {
          await this.context.failDiagnosis(
            activeExport,
            "诊断信息导出失败：Runtime 分块长度或摘要无效",
          );
          return;
        }
        await this.context.finishExport(activeExport);
      } else {
        await this.context.finishExport(activeExport);
      }
    } catch (error) {
      if (activeExport.kind.startsWith("diagnosis_")) {
        await this.context.failDiagnosis(activeExport, `诊断信息导出失败：${String(error)}`);
        return;
      }
      throw error;
    }
  }
}
