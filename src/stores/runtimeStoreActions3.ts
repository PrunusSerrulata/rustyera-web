import { nextTick } from "vue";
import { resourceUrlRegistry } from "@/core/resources";
import { debugStopToken } from "@/core/debug";
import { isMessageContinuationWait, messageWaitIntent } from "@/core/messageSkip";
import { hasEnabledButton, presentationInteractionEnabled } from "@/core/presentation";
import {
  defaultProjectPreferences,
  type InteractionToken,
  type ProjectReloadScope,
} from "@/core/types";
import { yieldToPaint } from "@/platform/mainThread";
import { TIME_ADVANCE_INTERVAL_NS, GAME_RUNNING_STATUS } from "@/stores/runtimeState";
import type { RuntimeInputIntent, RuntimeStartKind } from "@/stores/runtimeState";

type PendingRuntimeStart =
  | { type: "new_game"; seed?: number | bigint }
  | { type: Exclude<RuntimeStartKind, "new_game">; bytes: Uint8Array };

export function createRuntimeStoreActions3(context: any) {
  async function submitText(): Promise<void> {
    const wait = context.currentPresentation().inputWait;
    if (!wait || !context.canInteract.value) return;
    let intent: RuntimeInputIntent;
    switch (wait.kind) {
      case "enter_key":
        intent = { type: "enter" };
        break;
      case "any_key":
        intent = { type: "any_key", value: context.prompt.value || "\n" };
        break;
      case "void":
        intent = { type: "continue" };
        break;
      case "primitive_mouse_key": {
        const values = context.prompt.value
          .split(",")
          .map((part: string) => Number.parseInt(part.trim(), 10) || 0);
        intent = {
          type: "primitive",
          value: {
            input_type: values[0] ?? 0,
            result_1: values[1] ?? 0,
            result_2: values[2] ?? 0,
            result_3: values[3] ?? 0,
            result_4: values[4] ?? 0,
            selection_token: null,
          },
        };
        break;
      }
      default:
        intent = { type: "commit_text", value: context.prompt.value };
    }
    await submitIntent(intent, false);
    context.prompt.value = "";
  }

  async function activate(token: InteractionToken): Promise<void> {
    if (!context.canInteract.value || !hasEnabledButton(context.currentPresentation(), token))
      return;
    await submitIntent({ type: "activate", value: token }, false);
  }

  function interactionEnabled(interaction: any): boolean {
    return presentationInteractionEnabled(context.currentPresentation(), interaction);
  }

  async function skip(): Promise<void> {
    if (
      !context.runtimeReady.value ||
      context.gameInteractionsBlocked.value ||
      context.diagnosisExporting.value
    )
      return;
    // Native message-skip input is submitted and pumped as one atomic host operation. Let the
    // matching physical release reach the runtime first; otherwise a game that observes MOUSEB
    // while processing the continuation can wait for an edge that the blocked host cannot accept.
    if (context.heldMouseButtons.has(2)) {
      await waitForPhysicalMouseRelease(2);
      await context.awaitDeviceSubmissions();
    }
    await context.runtimeInput.requestMessageSkip();
  }

  function waitForPhysicalMouseRelease(code: number): Promise<void> {
    if (!context.heldMouseButtons.has(code)) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = () => {
        document.removeEventListener("mouseup", onMouseUpRelease, true);
        document.removeEventListener("visibilitychange", onClientBoundaryRelease);
        window.removeEventListener("blur", onClientBoundaryRelease);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onMouseUpRelease = (event: MouseEvent) => {
        if (context.mouseCode(event.button) === code) finish();
      };
      const onClientBoundaryRelease = () => {
        if (!document.hasFocus() || document.visibilityState !== "visible") finish();
      };
      document.addEventListener("mouseup", onMouseUpRelease, true);
      document.addEventListener("visibilitychange", onClientBoundaryRelease);
      window.addEventListener("blur", onClientBoundaryRelease);
      if (!context.heldMouseButtons.has(code)) finish();
    });
  }

  async function continueFromViewport(): Promise<void> {
    const wait = context.currentPresentation().inputWait;
    if (context.canInteract.value && isMessageContinuationWait(wait))
      await submitIntent(messageWaitIntent(wait), false);
  }

  async function submitIntent(intent: RuntimeInputIntent, messageSkip: boolean): Promise<void> {
    if (context.diagnosisExporting.value) return;
    const submitted = await context.runtimeInput.submit(intent, messageSkip);
    if (submitted && context.singleStepEnabled.value && !debugStopToken(context.debugStop.value))
      await context.pauseDebug();
  }

  async function settlePendingGameInput(): Promise<void> {
    if (context.diagnosisExporting.value) return;
    await context.runtimeInput.settle();
  }

  async function advanceTimedWait(): Promise<void> {
    if (context.diagnosisExporting.value) return;
    const wait = context.currentPresentation().inputWait;
    const advancingDevicePump = context.devicePumpTimeAdvancePending;
    if (
      (wait?.deadline_ns == null && !advancingDevicePump) ||
      context.pendingGameInput.value != null ||
      context.pendingInputUndo.value != null
    )
      return;
    const now = sampleMonotonicTime();
    if (!context.testEnvironment.shouldAdvanceTime(now, TIME_ADVANCE_INTERVAL_NS)) return;
    await context.send({ type: "advance_time", value: { monotonic_time_ns: now } });
  }

  function sampleMonotonicTime(): number {
    return context.testEnvironment.sampleMonotonic();
  }

  async function undo(): Promise<void> {
    const token = context.inputUndo.value?.token;
    if (
      context.diagnosisExporting.value ||
      !token ||
      context.pendingGameInput.value ||
      context.pendingInputUndo.value
    )
      return;
    await context.runtimeInput.undo(token);
  }

  async function restart(): Promise<void> {
    await restartSession({ type: "new_game" }, "重新开始");
  }

  async function restartSession(
    start: PendingRuntimeStart,
    action: "重新开始" | "恢复快照",
  ): Promise<void> {
    if (
      !context.projectOpen.value ||
      context.projectLoading.value ||
      context.runtimePump.transitioning ||
      context.diagnosisExporting.value
    )
      return;
    context.startupTelemetry.value = undefined;
    context.startupTelemetryState.begin(
      performance.now(),
      context.projectSource.value,
      context.bridge.kind,
    );
    context.beginProjectLoad("正在创建新的 Runtime session…");
    context.runtimePump.setTransitioning(true);
    context.pendingStart = start;
    try {
      await replaceRuntimeSession();
      const metrics = await context.bridge.restartProject();
      context.runtimeConfiguration.refreshWritable();
      await context.runtimeConfiguration.persistGenerated();
      context.refreshProjectFontFamilies(metrics.projectFonts);
      if (!context.startupTelemetry.value)
        context.startupTelemetryState.begin(
          metrics.submittedAtMs,
          context.projectSource.value,
          context.bridge.kind,
        );
      context.startupTelemetryState.applyBridgeMetrics(metrics, context.bridge.kind);
      const reloadLabel = action === "重新开始" ? "项目重新读取" : "恢复快照时项目重新读取";
      context.log(
        "info",
        `${reloadLabel}：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      context.continueProjectBuildProgress(metrics.cacheImported);
    } catch (error) {
      context.pendingStart = { type: "new_game" };
      context.startupTelemetryState.fail(error);
      context.finishProjectLoad();
      const message = `${action}失败：${String(error)}`;
      context.baseStatus.value = message;
      context.log("error", message);
    } finally {
      context.runtimePump.setTransitioning(false);
      context.schedulePump(0);
    }
  }

  async function replaceRuntimeSession(): Promise<void> {
    context.clearSessionTimers();
    context.audio.cancelPendingLoads();
    try {
      await context.runtimePump.waitUntilIdle();
      await cancelTimelineTransfers();
      retireFrontendOwners(true, true);
      await nextTick();
      await yieldToPaint();
      await context.bridge.prepareSessionReplacement();
      context.runtimeSessionObservationGeneration += 1;
      const options = context.sessionOptions();
      const batch = await context.bridge.createSession(options);
      context.sessionAudioAvailable = options.audioAvailable;
      context.runtimePump.setReady(true);
      await context.handleBatch(batch);
    } catch (error) {
      await context.bridge
        .prepareSessionReplacement()
        .catch((cleanupError: unknown) =>
          context.log("warning", `清理失败的 Runtime session 时出错：${String(cleanupError)}`),
        );
      retireFrontendOwners(true, true);
      throw error;
    }
  }

  async function returnToTitle(): Promise<void> {
    await transitionToTitle(true);
  }

  async function transitionToTitle(reportFailure: boolean): Promise<boolean> {
    if (
      !context.projectOpen.value ||
      context.projectLoading.value ||
      context.runtimePump.transitioning ||
      context.diagnosisExporting.value ||
      context.projectFileExporting.value
    )
      return false;
    context.runtimePump.setTransitioning(true);
    context.clearSessionTimers();
    context.audio.cancelPendingLoads();
    try {
      await context.runtimePump.waitUntilIdle();
      // The transition lock suppresses both browser and native pump scheduling. Once Runtime has
      // accepted the command, release the old Vue/media timeline before it constructs the title VM.
      const messageId = await context.send({ type: "return_to_title", value: {} });
      context.pendingReturnToTitleMessageId = String(messageId);
      await cancelTimelineTransfers();
      retireFrontendOwners(false);
      await nextTick();
      await yieldToPaint();
      return true;
    } catch (error) {
      context.pendingReturnToTitleMessageId = undefined;
      if (reportFailure) {
        const message = `返回标题失败：${String(error)}`;
        context.baseStatus.value = message;
        context.log("error", message);
      }
      throw error;
    } finally {
      context.runtimePump.setTransitioning(false);
      context.schedulePump(0);
    }
  }

  async function cancelTimelineTransfers(): Promise<void> {
    if (context.fullManifestImport)
      await context
        .cleanupFullManifestImport(true)
        .catch((error: unknown) =>
          context.log("warning", `清理状态导入传输失败：${String(error)}`),
        );
    const activeExport = context.exportState;
    if (activeExport?.kind === "compiled_cache") {
      await context.compiledCacheExport
        .cancel()
        .catch((error: unknown) =>
          context.log("warning", `取消项目缓存导出失败：${String(error)}`),
        );
    } else if (activeExport) {
      context.exportState = undefined;
      activeExport.buffer = undefined;
      activeExport.chunks.length = 0;
      if (activeExport.kind === "project_file" || activeExport.kind === "diagnosis_project")
        await context.bridge
          .cancelProjectFileExport()
          .catch((error: unknown) =>
            context.log("warning", `清理全量项目导出临时文件失败：${String(error)}`),
          );
      else if (activeExport.kind === "download" || activeExport.kind === "input_replay_download")
        await context.bridge
          .cancelStateExport()
          .catch((error: unknown) =>
            context.log("warning", `清理状态导出临时文件失败：${String(error)}`),
          );
    }
    context.runtimeImport.reset();
  }

  function requestRestart(): void {
    requestGameProgressLossAction("restart");
  }

  function requestReturnToTitle(): void {
    requestGameProgressLossAction("title");
  }

  function requestGameProgressLossAction(action: "restart" | "title"): void {
    if (!context.runtimeReady.value || context.gameInteractionsBlocked.value) return;
    context.gameProgressLossConfirmation.value = action;
  }

  function cancelGameProgressLossAction(): void {
    context.gameProgressLossConfirmation.value = null;
  }

  async function confirmGameProgressLossAction(): Promise<void> {
    const action = context.gameProgressLossConfirmation.value;
    context.gameProgressLossConfirmation.value = null;
    if (!action || !context.runtimeReady.value || context.gameInteractionsBlocked.value) return;
    if (action === "restart") await restart();
    else await returnToTitle();
  }

  function retireFrontendOwners(fullSession: boolean, preserveProjectLoad = false): void {
    context.gameProgressLossConfirmation.value = null;
    context.projectReload.reset();
    context.resetTransientStatuses();
    for (const active of [context.exportState]) {
      if (!active) continue;
      active.buffer = undefined;
      active.chunks.length = 0;
      active.digestHasher = undefined;
    }
    context.exportState = undefined;
    context.fullManifestImport = undefined;
    context.fullManifestImports.clear();
    context.retiredFullManifestCommandIds.clear();
    context.projectFileExportState.finish();
    resetRuntimeTimelineState(true, fullSession, fullSession);
    context.runtimeDiagnosis.reset();
    context.traditionalSaves.reset();
    context.runtimeLogs.clear();
    if (!fullSession) return;
    if (!preserveProjectLoad) context.finishProjectLoad();
    context.runtimePump.setReady(false);
    context.phase.value = "negotiating";
    context.resetDeviceInputState(false);
    context.runtimeEpoch.value = 0;
    context.testEnvironment.resetTimeAdvance();
    context.runtimeConfiguration.reset();
    context.runtimeClientPreferences.reset();
    context.projectPreferences.value = defaultProjectPreferences();
    context.projectPreferencesWritable.value = false;
    context.gameInformation.value = null;
    context.runtimeManifestSparse = false;
  }

  function resetRuntimeTimelineState(
    advanceResources = true,
    resetViewport = true,
    resetSqlProvider = true,
  ): void {
    context.resetViewportProjectionBarriers();
    context.serviceRequests.reset();
    if (resetSqlProvider) context.sqlProvider.reset();
    context.pointerObservation.clear();
    context.canvasPixels.clear();
    context.htmlMeasurements.clear();
    context.presentationProjection.reset();
    if (advanceResources) advanceProjectResourceGeneration(false);
    context.testAudioPlayback.clear();
    context.inputUndo.value = null;
    context.fault.value = null;
    context.debugRequests.reset();
    context.runtimeDebug.resetSession();
    context.prompt.value = "";
    context.runtimeInput.reset();
    // Returning to title keeps the same physical host environment in core. Full session
    // replacement must discard it; new geometry observations invalidate it immediately.
    if (resetViewport) {
      context.viewportLayoutIdentity = "";
      context.viewportLayoutIdentityAtProjection = "";
      context.runtimeViewport.reset();
    }
    context.runtimeImport.reset();
  }

  function advanceProjectResourceGeneration(resetSqlProvider = true): void {
    context.resetViewportProjectionBarriers();
    context.serviceRequests.reset();
    if (resetSqlProvider) context.sqlProvider.reset();
    context.pointerObservation.clear();
    context.canvasPixels.clear();
    context.htmlMeasurements.clear();
    context.projectResourceGeneration.value += 1;
    context.audio.resetResources(context.projectResourceGeneration.value);
    resourceUrlRegistry.releaseBeforeGeneration(context.projectResourceGeneration.value);
    context.imagePixels.clear();
  }

  async function openProjectReloadDialog(mode: "folder" | "script"): Promise<void> {
    await context.projectReload.openDialog(
      mode,
      context.runtimeReady.value && !context.gameInteractionsBlocked.value,
    );
  }

  function closeProjectReloadDialog(): void {
    context.projectReload.closeDialog();
  }

  async function confirmProjectReload(target: string): Promise<void> {
    const scope = context.projectReload.selectedScope(target);
    if (scope) await reloadProject(scope);
  }

  async function reloadProject(scope: ProjectReloadScope = { type: "all" }): Promise<void> {
    if (
      context.projectLoading.value ||
      context.runtimePump.transitioning ||
      context.diagnosisExporting.value
    )
      return;
    context.beginProjectLoad("正在重新加载项目…");
    context.runtimePump.setTransitioning(true);
    context.audio.cancelPendingLoads();
    try {
      await context.runtimePump.waitUntilIdle();
      await context.compiledCacheExport.cancel();
      const submission = await context.bridge.reloadProject(scope);
      context.projectReload.begin(submission.messageId);
      context.continueProjectBuildProgress();
    } catch (error) {
      await context.projectReload.failSubmission();
      context.finishProjectLoad();
      const message = `重新加载项目失败：${String(error)}`;
      context.baseStatus.value = message;
      context.log("error", message);
    } finally {
      context.runtimePump.setTransitioning(false);
      context.schedulePump(0);
    }
  }

  function dismissFault(): void {
    context.fault.value = null;
    context.diagnosisResult.value = "";
  }

  async function recoverFromFault(action: "title" | "reload"): Promise<void> {
    if (context.faultActionBusy.value || context.diagnosisExporting.value) return;
    context.faultActionBusy.value = true;
    context.fault.value = null;
    context.diagnosisResult.value = "";
    context.baseStatus.value = action === "title" ? "正在返回主菜单…" : "正在重启并重新编译…";
    try {
      if (action === "title") {
        // The recovery dialog owns failure reporting; avoid first emitting a normal action error
        // notification and then replacing it with a second fatal recovery dialog.
        if (!(await transitionToTitle(false)))
          throw new Error("当前 Runtime 状态不能执行返回标题恢复");
        context.baseStatus.value = GAME_RUNNING_STATUS;
      } else await reloadProject();
    } catch (error) {
      const message = `错误恢复失败：${String(error)}`;
      context.fault.value = { code: "frontend.recovery_failed", message };
      context.baseStatus.value = message;
      context.log("error", message, false, "none");
    } finally {
      context.faultActionBusy.value = false;
    }
  }

  return {
    submitText,
    activate,
    interactionEnabled,
    skip,
    waitForPhysicalMouseRelease,
    continueFromViewport,
    submitIntent,
    settlePendingGameInput,
    advanceTimedWait,
    sampleMonotonicTime,
    undo,
    restart,
    restartSession,
    replaceRuntimeSession,
    returnToTitle,
    transitionToTitle,
    cancelTimelineTransfers,
    requestRestart,
    requestReturnToTitle,
    requestGameProgressLossAction,
    cancelGameProgressLossAction,
    confirmGameProgressLossAction,
    retireFrontendOwners,
    resetRuntimeTimelineState,
    advanceProjectResourceGeneration,
    openProjectReloadDialog,
    closeProjectReloadDialog,
    confirmProjectReload,
    reloadProject,
    dismissFault,
    recoverFromFault,
  };
}
