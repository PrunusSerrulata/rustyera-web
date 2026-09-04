import { blake3 } from "@noble/hashes/blake3.js";
import { diagnosisProjectName, diagnosisProjectTitle } from "@/core/diagnosis";
import {
  concatenateChunks,
  formatDiagnostic,
  formatDiagnosisLogs,
  inputReplayFileName,
  snapshotFileName,
} from "@/core/runtimeSupport";
import { type RuntimeMessage } from "@/core/types";
import { diagnosisStateExportRequest, isFullProjectExport } from "@/stores/runtimeState";
import type {
  ExportState,
  DiagnosisStateExportKind,
  FullProjectExportState,
  FullManifestImportTransaction,
  FullProjectRequestSubmission,
} from "@/stores/runtimeState";

export function createRuntimeStoreActions4(context: any) {
  async function exportDiagnosis(): Promise<void> {
    if (!context.canExportDiagnosis.value) return;
    const projectName = diagnosisProjectName(
      diagnosisProjectTitle(
        context.gameInformation.value?.title,
        context.presentation.title === "RustyEra" ? undefined : context.presentation.title,
        context.bridge.projectName(),
      ),
    );
    const exportedAt = context.testEnvironment.clock ?? new Date();
    context.runtimeDiagnosis.begin(projectName, formatDiagnosisLogs(context.logs), exportedAt);
    if (!context.exportState) await startDiagnosisStateExport("diagnosis_replay");
  }

  async function startDiagnosisStateExport(kind: DiagnosisStateExportKind): Promise<void> {
    if (!context.runtimeDiagnosis.active || !context.diagnosisExporting.value) return;
    context.runtimeDiagnosis.setProgress(
      kind === "diagnosis_replay" ? "input_replay" : "vm_snapshot",
    );
    const activeExport: ExportState = {
      name: context.runtimeDiagnosis.active.name,
      kind,
      chunks: [],
      received: 0,
    };
    context.exportState = activeExport;
    try {
      const messageId = await context.send({
        type: "state_export_request",
        value: diagnosisStateExportRequest[kind],
      });
      if (context.exportState === activeExport) activeExport.requestMessageId = String(messageId);
    } catch (error) {
      if (context.exportState === activeExport)
        await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
    }
  }

  async function exportSnapshot(purpose: "normal" | "debug" = "normal"): Promise<void> {
    await startDownloadStateExport(
      snapshotFileName(),
      "download",
      { kind: "vm_snapshot", snapshot_purpose: purpose },
      "VM 快照",
    );
  }

  async function exportInputReplay(): Promise<void> {
    await startDownloadStateExport(
      inputReplayFileName(context.testEnvironment.clock ?? new Date()),
      "input_replay_download",
      { kind: "input_replay", snapshot_purpose: "normal" },
      "操作序列",
    );
  }

  async function startDownloadStateExport(
    name: string,
    kind: "download" | "input_replay_download",
    request: {
      kind: "vm_snapshot" | "input_replay";
      snapshot_purpose: "normal" | "debug";
    },
    label: string,
  ): Promise<void> {
    if (context.diagnosisExporting.value) return;
    if (context.exportState) {
      context.baseStatus.value = "另一项状态导出仍在进行，请稍后重试";
      return;
    }
    const activeExport: ExportState = {
      name,
      kind,
      runtimeKind: request.kind,
      chunks: [],
      received: 0,
    };
    context.exportState = activeExport;
    try {
      const messageId = await context.send({ type: "state_export_request", value: request });
      if (context.exportState === activeExport) activeExport.requestMessageId = String(messageId);
    } catch (error) {
      if (context.exportState === activeExport) context.exportState = undefined;
      const message = `${label}导出失败：${String(error)}`;
      context.baseStatus.value = message;
      context.log("error", message);
    }
  }

  async function exportTraditionalSaveForTest(): Promise<void> {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
      throw new Error("传统存档测试导出只能在 VITE_RUSTYERA_TEST 中使用");
    if (context.exportState) throw new Error("另一项状态导出仍在进行");
    context.exportState = {
      name: "save00.sav",
      kind: "download",
      runtimeKind: "traditional_save",
      chunks: [],
      received: 0,
    };
    const messageId = await context.send({
      type: "state_export_request",
      value: { kind: "traditional_save", snapshot_purpose: "normal" },
    });
    if (context.exportState?.kind === "download")
      context.exportState.requestMessageId = String(messageId);
  }

  function testTransferState(): Record<string, unknown> {
    return {
      export: context.exportState
        ? {
            name: context.exportState.name,
            received: context.exportState.received,
            descriptor: context.exportState.descriptor,
          }
        : null,
      fullManifest: context.fullManifestImport
        ? {
            submittedBytes: context.fullManifestImport.submittedBytes,
            totalBytes: context.fullManifestImport.totalBytes,
            commitStarted: context.fullManifestImport.commitStarted,
            cancelled: context.fullManifestImport.cancelled,
          }
        : null,
      ...context.runtimeImport.testState(),
    };
  }

  function recordTestAudioPlayback(event: "started" | "ended", resourceId: string): void {
    const current = context.testAudioPlayback.get(resourceId) ?? { starts: 0, active: 0 };
    if (event === "started") {
      current.starts += 1;
      current.active += 1;
    } else {
      current.active = Math.max(0, current.active - 1);
    }
    context.testAudioPlayback.set(resourceId, current);
  }

  function testAudioPlaybackState(): Record<
    string,
    {
      starts: number;
      active: number;
    }
  > {
    return Object.fromEntries(
      [...context.testAudioPlayback.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  function testAudioProviderState() {
    return context.audio.providerSnapshot();
  }

  async function openTraditionalSaveDialog(mode: "export" | "import"): Promise<void> {
    await context.traditionalSaves.open(mode, context.canManageTraditionalSaves.value);
  }

  function closeTraditionalSaveDialog(): void {
    context.traditionalSaves.close();
  }

  async function pickTraditionalSaveImport(): Promise<void> {
    await context.traditionalSaves.pickImport();
  }

  async function confirmTraditionalSaveTransfer(slot: number): Promise<void> {
    await context.traditionalSaves.confirm(slot);
  }

  function cancelTraditionalSaveOverwrite(): void {
    context.traditionalSaves.cancelOverwrite();
  }

  async function confirmTraditionalSaveOverwrite(): Promise<void> {
    await context.traditionalSaves.confirmOverwrite();
  }

  function scheduleCompiledCacheExport(delayMs = 0): void {
    if (!context.bridge.automaticCompiledCacheExport) return;
    context.compiledCacheExport.schedule(delayMs);
  }

  async function refreshCompiledCacheAfterConfigurationUpdate(): Promise<void> {
    if (context.exportState?.kind === "compiled_cache") await context.compiledCacheExport.cancel();
    // A cache hit leaves Runtime with an intentionally sparse project manifest. It cannot rebuild
    // bytecode after a configuration edit; the host has already invalidated that cache, so the
    // next project load will materialize source and produce a replacement safely.
    if (context.runtimeManifestSparse) return;
    scheduleCompiledCacheExport();
  }

  async function exportProjectFile(): Promise<void> {
    if (
      !context.runtimeReady.value ||
      context.gameInteractionsBlocked.value ||
      !context.bridge.fullProjectExportSupported()
    )
      return;
    if (context.exportState && context.exportState.kind !== "compiled_cache") return;
    const title = diagnosisProjectName(
      context.presentation.title.trim() || context.bridge.projectName() || "RustyEra项目",
    );
    const name = `${title}.reraproj`;
    if (!(await context.bridge.beginProjectFileExport(name))) {
      context.baseStatus.value = "已取消导出全量项目文件";
      return;
    }
    if (context.exportState?.kind === "compiled_cache") {
      context.projectFileExportState.resumeCacheWhenFinished();
      try {
        await context.compiledCacheExport.cancel();
      } catch (error) {
        await context.bridge.cancelProjectFileExport();
        throw error;
      }
    }
    context.projectFileExportState.begin();
    const activeExport: FullProjectExportState = {
      name,
      kind: "project_file",
      chunks: [],
      received: 0,
    };
    context.exportState = activeExport;
    context.baseStatus.value = "正在读取全量项目文件…";
    try {
      await stageFullManifestImport(activeExport, "project_file");
    } catch (error) {
      if (context.exportState !== activeExport) return;
      await finishProjectFileExport("failed");
      throw error;
    }
  }

  async function requestFullProjectExport(activeExport: FullProjectExportState): Promise<void> {
    const submission: FullProjectRequestSubmission = { earlyPreparationRejections: [] };
    activeExport.requestMessageId = undefined;
    activeExport.requestSubmission = submission;
    activeExport.runtimeRequestMayBeActive = true;
    let messageId: number | bigint;
    try {
      messageId = await context.send({
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      });
    } catch (error) {
      settleFullProjectRequestSubmission(activeExport, submission);
      throw error;
    }
    if (context.exportState !== activeExport) {
      if (activeExport.requestSubmission === submission) activeExport.requestSubmission = undefined;
      return;
    }
    const preparationRejected = settleFullProjectRequestSubmission(
      activeExport,
      submission,
      messageId,
    );
    if (preparationRejected) scheduleFullProjectExportRetry(activeExport);
  }

  async function stageFullManifestImport(
    activeExport: FullProjectExportState,
    purpose: "project_file" | "diagnosis_project",
  ): Promise<void> {
    const descriptor = await context.bridge.stageFullProjectManifest();
    if (!context.projectFileExporting.value && purpose === "project_file") {
      await context.bridge.releaseFullProjectManifest();
      return;
    }
    if (context.exportState !== activeExport) {
      await context.bridge.releaseFullProjectManifest();
      return;
    }
    if (!descriptor) {
      await requestFullProjectExport(activeExport);
      return;
    }
    if (descriptor.totalBytes > 1024 * 1024 * 1024) {
      await context.bridge.releaseFullProjectManifest();
      throw new Error("full project manifest exceeds the 1 GiB transfer limit");
    }
    const pending: NonNullable<typeof context.fullManifestImport> = {
      activeExport,
      totalBytes: descriptor.totalBytes,
      submittedBytes: 0,
      hasher: blake3.create(),
      purpose,
      commandMessageIds: new Set<string>(),
      cancelled: false,
      cancelSent: false,
      commitStarted: false,
      runtimeSubmission: Promise.resolve(),
    };
    context.fullManifestImport = pending;
    context.fullManifestImports.add(pending);
    const messageId = await submitFullManifestCommand(pending, {
      type: "state_import_begin",
      value: {
        kind: "full_project_manifest",
        total_bytes: descriptor.totalBytes,
        digest: null,
        artifact_id: null,
      },
    });
    pending.beginMessageId = String(messageId);
  }

  async function acceptFullManifestImport(
    value: any,
    correlationId?: number | bigint,
  ): Promise<boolean> {
    const pending = [...context.fullManifestImports].find(
      (candidate) => candidate.beginMessageId === String(correlationId),
    );
    if (!pending) return false;
    if (pending.transferId != null) {
      context.log("warning", "Runtime 返回了重复的完整项目 manifest transfer", true);
      await context.send({
        type: "state_transfer_cancel",
        value: { transfer_id: value.transfer_id },
      });
      return true;
    }
    pending.transferId = Number(value.transfer_id);
    if (pending.cancelled) {
      await requestFullManifestTransferCancel(pending);
      return true;
    }
    return true;
  }

  async function advanceFullManifestImport(): Promise<void> {
    const pending = context.fullManifestImport;
    if (!pending || pending.cancelled || pending.transferId == null || pending.commitStarted)
      return;
    try {
      await submitNextFullManifestChunk(pending);
    } catch (error) {
      if (pending.cancelled) return;
      await cleanupFullManifestImport(true, pending);
      const message = `完整项目 manifest 传输失败：${String(error)}`;
      if (pending.activeExport.kind === "diagnosis_project")
        await failDiagnosisExport(pending.activeExport, message);
      else await finishProjectFileExport("failed", message);
    }
  }

  async function submitNextFullManifestChunk(
    pending: FullManifestImportTransaction,
  ): Promise<void> {
    const offset = pending.submittedBytes;
    if (offset < pending.totalBytes) {
      const expected = Math.min(
        context.FULL_PROJECT_MANIFEST_CHUNK_BYTES,
        pending.totalBytes - offset,
      );
      const data = await context.bridge.readFullProjectManifestChunk(offset, expected);
      if (pending.cancelled) return;
      if (data.byteLength !== expected) throw new Error("完整项目 manifest 临时文件读取不完整");
      pending.hasher.update(data);
      await submitFullManifestCommand(pending, {
        type: "state_import_chunk",
        value: {
          transfer_id: pending.transferId,
          offset,
          data,
        },
      });
      if (pending.cancelled) return;
      pending.submittedBytes += expected;
      if (pending.purpose === "project_file")
        context.projectFileExportState.setProgress({
          stage: "submitting",
          completed: pending.submittedBytes,
          total: pending.totalBytes,
        });
      return;
    }
    pending.commitStarted = true;
    const messageId = await submitFullManifestCommand(pending, {
      type: "state_import_commit",
      value: { transfer_id: pending.transferId, digest: pending.hasher.digest() },
    });
    pending.commitMessageId = String(messageId);
    await releaseFullManifestHost(pending);
  }

  async function finishFullManifestImport(
    value: any,
    correlationId?: number | bigint,
  ): Promise<boolean> {
    const pending = [...context.fullManifestImports].find(
      (candidate) => candidate.commitMessageId === String(correlationId),
    );
    if (!pending) return false;
    if (
      pending.transferId !== Number(value.transfer_id) ||
      value.kind !== "full_project_manifest" ||
      pending.commitMessageId !== String(correlationId)
    ) {
      if (!pending.cancelled)
        context.log("warning", "Runtime 返回了不匹配的完整项目 manifest Ready", true);
      return true;
    }
    retireFullManifestImport(pending);
    if (pending.cancelled || context.exportState !== pending.activeExport) return true;
    await requestFullProjectExport(pending.activeExport);
    return true;
  }

  async function submitFullManifestCommand(
    pending: FullManifestImportTransaction,
    message: RuntimeMessage,
  ): Promise<number | bigint> {
    const submission = pending.runtimeSubmission.then(() => context.send(message));
    pending.runtimeSubmission = submission.then(
      () => undefined,
      () => undefined,
    );
    const messageId = await submission;
    pending.commandMessageIds.add(String(messageId));
    return messageId;
  }

  function releaseFullManifestHost(pending: FullManifestImportTransaction): Promise<void> {
    pending.hostRelease ??= Promise.resolve(context.bridge.releaseFullProjectManifest()).catch(
      () => undefined,
    );
    return pending.hostRelease;
  }

  async function requestFullManifestTransferCancel(
    pending: FullManifestImportTransaction,
  ): Promise<void> {
    if (pending.transferId == null || pending.cancelSent) return;
    pending.cancelSent = true;
    const transferId = pending.transferId;
    const cancellation = pending.runtimeSubmission.then(async () => {
      const messageId = await context.send({
        type: "state_transfer_cancel",
        value: { transfer_id: transferId },
      });
      const correlation = String(messageId);
      pending.commandMessageIds.add(correlation);
      if (!context.fullManifestImports.has(pending))
        rememberRetiredFullManifestCommandId(correlation);
    });
    pending.runtimeSubmission = cancellation.then(
      () => undefined,
      () => undefined,
    );
    await cancellation.catch(() => undefined);
    if (pending.cancelled && !pending.commitStarted) retireFullManifestImport(pending);
  }

  function retireFullManifestImport(pending: FullManifestImportTransaction): void {
    context.fullManifestImports.delete(pending);
    if (context.fullManifestImport === pending) context.fullManifestImport = undefined;
    for (const messageId of pending.commandMessageIds)
      rememberRetiredFullManifestCommandId(messageId);
  }

  function rememberRetiredFullManifestCommandId(messageId: string): void {
    context.retiredFullManifestCommandIds.add(messageId);
    while (context.retiredFullManifestCommandIds.size > 64) {
      const oldest = context.retiredFullManifestCommandIds.values().next().value;
      if (oldest == null) break;
      context.retiredFullManifestCommandIds.delete(oldest);
    }
  }

  async function cleanupFullManifestImport(
    cancelRuntime: boolean,
    pending = context.fullManifestImport,
  ): Promise<void> {
    if (!pending) return;
    pending.cancelled = true;
    if (context.fullManifestImport === pending) context.fullManifestImport = undefined;
    await Promise.all([
      releaseFullManifestHost(pending),
      cancelRuntime ? requestFullManifestTransferCancel(pending) : Promise.resolve(),
    ]);
  }

  function settleFullProjectRequestSubmission(
    activeExport: FullProjectExportState,
    submission: FullProjectRequestSubmission,
    messageId?: number | bigint,
  ): boolean {
    if (activeExport.requestSubmission !== submission) return false;
    activeExport.requestSubmission = undefined;
    const correlation = messageId == null ? undefined : String(messageId);
    if (correlation != null) activeExport.requestMessageId = correlation;
    let preparationRejected = false;
    for (const rejection of submission.earlyPreparationRejections) {
      if (correlation != null && rejection.correlation === correlation) preparationRejected = true;
      else context.log("warning", formatDiagnostic(rejection.value), true);
    }
    return preparationRejected;
  }

  function scheduleFullProjectExportRetry(activeExport: FullProjectExportState): void {
    activeExport.requestMessageId = undefined;
    context.projectFileExportState.scheduleRetry(() => {
      if (context.exportState !== activeExport || context.exportState.descriptor) return;
      void requestFullProjectExport(activeExport).catch((error) => {
        void failFullProjectExportRequest(activeExport, error);
      });
    });
  }

  async function failFullProjectExportRequest(
    activeExport: FullProjectExportState,
    error: unknown,
  ): Promise<void> {
    if (context.exportState !== activeExport) return;
    if (activeExport.kind === "diagnosis_project") {
      await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
      return;
    }
    const message = `全量项目文件导出失败：${String(error)}`;
    await finishProjectFileExport("failed", message);
    context.log("error", message);
  }

  async function requestCompiledCacheExport(activeExport: ExportState): Promise<void> {
    const messageId = await context.send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (context.exportState === activeExport) activeExport.requestMessageId = String(messageId);
  }

  async function cancelProjectFileExport(): Promise<void> {
    if (!context.projectFileExporting.value || context.exportState?.kind !== "project_file") return;
    await finishProjectFileExport("cancelled", "已取消导出全量项目文件", true);
  }

  async function finishProjectFileExport(
    outcome: "success" | "cancelled" | "failed",
    message?: string,
    cancelRuntime = outcome !== "success",
  ): Promise<void> {
    const pendingManifest = context.fullManifestImport;
    if (pendingManifest) pendingManifest.cancelled = true;
    context.exportState = undefined;
    // Stop host reads/writes before waiting for queued Runtime commands. Otherwise cancellation
    // can leave the producer allocating data while Runtime is busy draining the transfer.
    if (outcome !== "success") {
      try {
        await context.bridge.cancelProjectFileExport();
      } catch (error) {
        context.log("warning", `清理全量项目导出临时文件失败：${String(error)}`);
      }
    }
    if (pendingManifest) await cleanupFullManifestImport(cancelRuntime, pendingManifest);
    if (outcome !== "success") {
      try {
        if (cancelRuntime)
          await context.send({ type: "state_export_cancel", value: { kind: "full_project_file" } });
      } catch (error) {
        context.log("warning", `取消 Runtime 全量项目导出失败：${String(error)}`);
      }
    }
    const resumeCache = context.projectFileExportState.finish();
    if (message) context.baseStatus.value = message;
    if (resumeCache) scheduleCompiledCacheExport();
    if (context.diagnosisExporting.value && !context.exportState)
      await startDiagnosisStateExport("diagnosis_replay");
  }

  async function finishExportTransfer(completed = context.exportState): Promise<void> {
    if (!completed) return;
    await completed.hostWrite;
    if (context.exportState !== completed) return;
    if (completed.hostWriteFailure) throw completed.hostWriteFailure.error;
    const result =
      completed.kind === "compiled_cache" ||
      completed.kind === "project_file" ||
      completed.kind === "download" ||
      completed.kind === "input_replay_download"
        ? new Uint8Array()
        : (completed.buffer ?? concatenateChunks(completed.chunks, completed.received));
    completed.buffer = undefined;
    completed.chunks.length = 0;
    try {
      if (completed.kind === "download" || completed.kind === "input_replay_download") {
        context.baseStatus.value = `已导出 ${completed.name}`;
        context.exportState = undefined;
        if (context.diagnosisExporting.value) await startDiagnosisStateExport("diagnosis_replay");
      } else if (completed.kind === "project_file") {
        await finishProjectFileExport("success", `已导出 ${completed.name}`);
      } else if (completed.kind === "compiled_cache") {
        context.compiledCacheExport.finish(completed, "success");
        if (context.diagnosisExporting.value) await startDiagnosisStateExport("diagnosis_replay");
      } else if (completed.kind === "diagnosis_replay") {
        if (!context.runtimeDiagnosis.active) throw new Error("诊断导出状态缺失");
        context.runtimeDiagnosis.active.inputReplay = result;
        context.exportState = undefined;
        await startDiagnosisStateExport("diagnosis_snapshot");
      } else if (completed.kind === "diagnosis_snapshot") {
        if (!context.runtimeDiagnosis.active) throw new Error("诊断导出状态缺失");
        context.runtimeDiagnosis.active.snapshot = result;
        const activeExport: FullProjectExportState = {
          name: context.runtimeDiagnosis.active.name,
          kind: "diagnosis_project",
          chunks: [],
          received: 0,
        };
        context.exportState = activeExport;
        await stageFullManifestImport(activeExport, "diagnosis_project");
      } else {
        if (
          !context.runtimeDiagnosis.active?.snapshot ||
          !context.runtimeDiagnosis.active.inputReplay
        )
          throw new Error("诊断归档输入缺失");
        context.runtimeDiagnosis.setProgress("archive");
        const saved = await context.bridge.saveDiagnosis(
          context.runtimeDiagnosis.active.name,
          {
            projectName: context.runtimeDiagnosis.active.projectName,
            snapshot: context.runtimeDiagnosis.active.snapshot,
            inputReplay: context.runtimeDiagnosis.active.inputReplay,
            logs: context.runtimeDiagnosis.active.logs,
            projectFile: result,
            exportedAt: context.runtimeDiagnosis.active.exportedAt,
          },
          ({ completed, total }: { completed: number; total: number }) =>
            context.runtimeDiagnosis.setProgress("archive", completed, total),
        );
        finishDiagnosis(
          true,
          saved ? `诊断信息已导出：${context.runtimeDiagnosis.active.name}` : "已取消导出诊断信息",
        );
      }
    } catch (error) {
      if (completed.kind.startsWith("diagnosis_")) {
        const activeDiagnosis =
          context.exportState?.kind.startsWith("diagnosis_") === true
            ? context.exportState
            : completed;
        await failDiagnosisExport(activeDiagnosis, `诊断信息导出失败：${String(error)}`);
      } else {
        if (completed.kind === "project_file") {
          await finishProjectFileExport("failed");
        } else if (completed.kind === "compiled_cache") {
          await context.compiledCacheExport.fail(completed, error);
          return;
        } else {
          if (completed.kind === "download" || completed.kind === "input_replay_download")
            await context.bridge.cancelStateExport().catch(() => undefined);
          context.exportState = undefined;
        }
        const message = `状态导出失败：${String(error)}`;
        context.baseStatus.value = message;
        context.log("error", message);
      }
    }
  }

  function finishDiagnosis(success: boolean, message: string): void {
    context.exportState = undefined;
    context.runtimeDiagnosis.finish(message);
    context.baseStatus.value = message;
    context.log(success ? "info" : "error", message, false, "none");
  }

  async function failDiagnosisExport(activeExport: ExportState, message: string): Promise<void> {
    if (context.exportState !== activeExport || !activeExport.kind.startsWith("diagnosis_")) return;
    const pendingManifest = context.fullManifestImport;
    context.exportState = undefined;
    context.runtimeDiagnosis.active = undefined;
    if (pendingManifest) await cleanupFullManifestImport(true, pendingManifest);
    if (activeExport.kind === "diagnosis_replay" || activeExport.kind === "diagnosis_snapshot") {
      try {
        if (activeExport.descriptor?.transfer_id != null) {
          await context.send({
            type: "state_transfer_cancel",
            value: { transfer_id: activeExport.descriptor.transfer_id },
          });
        } else if (activeExport.requestMessageId) {
          await context.send({
            type: "state_export_cancel",
            value: {
              kind: activeExport.kind === "diagnosis_replay" ? "input_replay" : "vm_snapshot",
            },
          });
        }
      } catch (error) {
        context.log("warning", `取消 Runtime 诊断状态导出失败：${String(error)}`);
      }
    } else if (isFullProjectExport(activeExport) && activeExport.kind === "diagnosis_project") {
      if (
        activeExport.requestMessageId ||
        activeExport.runtimeRequestMayBeActive ||
        activeExport.descriptor
      ) {
        try {
          await context.send({ type: "state_export_cancel", value: { kind: "full_project_file" } });
        } catch (error) {
          context.log("warning", `取消 Runtime 诊断项目导出失败：${String(error)}`);
        }
      }
      try {
        await context.bridge.cancelProjectFileExport();
      } catch (error) {
        context.log("warning", `清理诊断项目导出状态失败：${String(error)}`);
      }
    }
    finishDiagnosis(false, message);
  }

  return {
    exportDiagnosis,
    startDiagnosisStateExport,
    exportSnapshot,
    exportInputReplay,
    startDownloadStateExport,
    exportTraditionalSaveForTest,
    testTransferState,
    recordTestAudioPlayback,
    testAudioPlaybackState,
    testAudioProviderState,
    openTraditionalSaveDialog,
    closeTraditionalSaveDialog,
    pickTraditionalSaveImport,
    confirmTraditionalSaveTransfer,
    cancelTraditionalSaveOverwrite,
    confirmTraditionalSaveOverwrite,
    scheduleCompiledCacheExport,
    refreshCompiledCacheAfterConfigurationUpdate,
    exportProjectFile,
    requestFullProjectExport,
    stageFullManifestImport,
    acceptFullManifestImport,
    advanceFullManifestImport,
    submitNextFullManifestChunk,
    finishFullManifestImport,
    submitFullManifestCommand,
    releaseFullManifestHost,
    requestFullManifestTransferCancel,
    retireFullManifestImport,
    rememberRetiredFullManifestCommandId,
    cleanupFullManifestImport,
    settleFullProjectRequestSubmission,
    scheduleFullProjectExportRetry,
    failFullProjectExportRequest,
    requestCompiledCacheExport,
    cancelProjectFileExport,
    finishProjectFileExport,
    finishExportTransfer,
    finishDiagnosis,
    failDiagnosisExport,
  };
}
