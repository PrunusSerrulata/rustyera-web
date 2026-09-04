import { nextTick } from "vue";
import { parseAudioEffect } from "@/core/audio/model";
import { formatDiagnostic, projectGameInformation, safeNumber } from "@/core/runtimeSupport";
import { formatRuntimeFault } from "@/core/runtimeFault";
import { type RuntimeMessage } from "@/core/types";
import {
  currentGameViewport,
  currentGameViewportMeasurement,
} from "@/platform/viewportMeasurement";
import { projectLineGeometry } from "@/platform/lineGeometry";
import {
  RuntimeServiceError,
  isHtmlQueryService,
  sameServiceInteger,
  serviceInteger,
  type ProjectionQueryContext,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import { type RuntimeServiceLease } from "@/stores/runtimeServiceRequests";
import { yieldToPaint } from "@/platform/mainThread";
import { classifyRuntimeRejection } from "@/stores/runtimeRejections";
import { handleRuntimeService } from "@/stores/runtimeServices";
import { resolveCanvasReplay } from "@/core/replayResources";
import { isFullProjectExport, GAME_RUNNING_STATUS } from "@/stores/runtimeState";

export function createRuntimeStoreActions2(context: any) {
  async function handleRuntimeAsync(
    message: RuntimeMessage,
    correlationId?: number | bigint,
    dataBytes?: Uint8Array,
  ): Promise<void> {
    const value = message.value;
    switch (message.type) {
      case "server_hello":
        context.coreVersion.value = `${value.implementation_version} (${import.meta.env.VITE_RUSTYERA_CORE_REVISION})`;
        if (!context.runtimeConfiguration.acceptProfile(value.configuration_profile))
          context.log("error", "Runtime 返回的设置宿主类别与当前客户端不一致，项目设置已停用");
        context.baseStatus.value = "Runtime 已就绪";
        break;
      case "project_load_report": {
        if (value.success)
          context.gameInformation.value = projectGameInformation(value.game_information);
        if (context.projectReload.matches(correlationId)) {
          await context.handleProjectReloadReport(value);
          break;
        }
        context.startupTelemetryState.finishProgressStage();
        if (context.startupTelemetry.value)
          context.startupTelemetry.value.milestones.runtimeValidationReportedMs =
            context.startupTelemetryState.elapsedMs();
        const diagnostics = value.diagnostics ?? [];
        const runtimeAcceptedCompiledCache = diagnostics.some(
          (diagnostic: any) => diagnostic.code === "runtime.compiled_cache_hit",
        );
        if (context.startupTelemetry.value && runtimeAcceptedCompiledCache)
          context.startupTelemetry.value.cacheHit = true;
        context.runtimeManifestSparse = value.success && runtimeAcceptedCompiledCache;
        context.appendLogEntries(
          diagnostics.map((diagnostic: any) => ({
            timestamp: new Date(),
            level: diagnostic.level ?? "info",
            message: formatDiagnostic(diagnostic),
            authoritative: true,
          })),
          diagnostics.map((diagnostic: any) =>
            context.diagnosticNotificationPolicy(diagnostic, "errors_only"),
          ),
        );
        context.runtimeConfiguration.refreshWritable();
        context.runtimeConfiguration.update(value.configuration);
        await context.runtimeConfiguration.persistGenerated();
        if (value.success) {
          context.refreshProjectPreferences();
          const startupLifecycle = context.lifecycleGeneration;
          // Migration confirmation can change canonical presentation settings. Let
          // the pump handle that reply before preferences or the initial viewport
          // are submitted; awaiting it inside this batch handler would deadlock.
          void context.runtimeConfiguration
            .whenSettled()
            .then(async () => {
              if (startupLifecycle !== context.lifecycleGeneration) return;
              await context.runtimeClientPreferences.apply();
              if (startupLifecycle === context.lifecycleGeneration)
                await context.continueLoadedProject(runtimeAcceptedCompiledCache);
            })
            .catch((error: unknown) => {
              if (startupLifecycle !== context.lifecycleGeneration) return;
              context.pendingStart = { type: "new_game" };
              const message = `客户端偏好初始化失败：${String(error)}`;
              context.startupTelemetryState.fail(message);
              context.finishProjectLoad();
              context.baseStatus.value = message;
              context.log("error", message);
            });
        } else if (value.payload_required) {
          context.showProjectLoadTransition("项目缓存未命中，正在读取项目源码…");
          context.runtimeManifestSparse = false;
          if (context.startupTelemetry.value) {
            context.startupTelemetry.value.scenario = "cold";
            context.startupTelemetry.value.cacheHit = false;
          }
          await context.bridge.submitProjectSource();
          context.continueProjectBuildProgress();
          context.schedulePump(0);
        } else {
          context.pendingStart = { type: "new_game" };
          context.startupTelemetryState.fail("项目加载失败");
          context.finishProjectLoad();
          context.baseStatus.value = "项目加载失败，请查看日志";
        }
        break;
      }
      case "runtime_resynchronized":
        context.pendingReturnToTitleMessageId = undefined;
        context.phase.value = value.phase;
        context.observeRuntimeEpoch(value.epoch ?? context.runtimeEpoch.value);
        context.batchMediaDirty =
          context.presentationProjection.projectSnapshot(value.presentation) ||
          context.batchMediaDirty;
        context.applyInputUndo(value.input_undo ?? null);
        context.runtimeConfiguration.update(value.configuration);
        await context.runtimeConfiguration.persistGenerated();
        break;
      case "configuration_update_prepared":
        await context.runtimeConfiguration.handlePrepared(value, correlationId);
        break;
      case "configuration_update_committed":
        await context.runtimeConfiguration.handleCommitted(value, correlationId);
        break;
      case "client_preferences_applied":
        if (!(await context.runtimeClientPreferences.handleApplied(value, correlationId)))
          context.log("warning", "忽略了非预期的客户端偏好响应");
        break;
      case "effect_batch":
        await context.handleEffects(value.effects ?? []);
        break;
      case "storage_request": {
        const response = await context.bridge.handleStorage(value);
        await context.send(
          { type: "storage_response", value: response },
          safeNumber(correlationId),
        );
        break;
      }
      case "service_request":
        void context.handleService(value, correlationId);
        break;
      case "cancel_external_request":
        if (value.kind === "service") context.serviceRequests.cancel(value.request_id);
        break;
      case "state_export_ready":
        await context.exportTransfer.handleReady(value, correlationId);
        break;
      case "state_export_chunk":
        await context.exportTransfer.handleChunk(value, dataBytes);
        break;
      case "state_import_accepted":
        if (
          [...context.fullManifestImports].some(
            (pending) => pending.beginMessageId === String(correlationId),
          )
        ) {
          try {
            await context.acceptFullManifestImport(value, correlationId);
          } catch (error) {
            const pending = [...context.fullManifestImports].find(
              (candidate) => candidate.beginMessageId === String(correlationId),
            );
            const active = pending?.activeExport;
            await context.cleanupFullManifestImport(true, pending);
            const message = `完整项目 manifest 传输失败：${String(error)}`;
            if (active?.kind === "diagnosis_project")
              await context.failDiagnosisExport(active, message);
            else await context.finishProjectFileExport("failed", message, false);
          }
        } else await context.runtimeImport.accept(value);
        break;
      case "state_import_ready":
        if (!(await context.finishFullManifestImport(value, correlationId)))
          await context.runtimeImport.ready(value);
        break;
      case "fault": {
        context.resetViewportProjectionBarriers();
        context.serviceRequests.reset();
        context.sqlProvider.reset();
        context.htmlMeasurements.clear();
        context.canvasPixels.clear();
        if (context.fullManifestImport) await context.cleanupFullManifestImport(false);
        context.runtimeImport.reset();
        context.gameProgressLossConfirmation.value = null;
        const startupWasLoading = context.startupTelemetry.value?.outcome === "loading";
        if (startupWasLoading) context.pendingStart = { type: "new_game" };
        context.startupTelemetryState.fail(value.message ?? "Runtime fault");
        if (startupWasLoading) context.finishProjectLoad();
        context.diagnosisResult.value = "";
        context.fault.value = value;
        context.log("error", formatRuntimeFault(value), true, "none");
        break;
      }
      case "diagnostic":
        context.log(
          value.level ?? "info",
          formatDiagnostic(value),
          true,
          context.diagnosticNotificationPolicy(value, "all"),
        );
        if (
          value.code === "runtime.compiled_cache_ready" &&
          context.exportState?.kind === "compiled_cache" &&
          !context.exportState.descriptor
        ) {
          const activeExport = context.exportState;
          try {
            await context.requestCompiledCacheExport(activeExport);
          } catch (error) {
            await context.compiledCacheExport.fail(activeExport, error);
          }
        } else if (
          value.code === "runtime.compiled_cache_failed" &&
          context.exportState?.kind === "compiled_cache" &&
          !context.exportState.descriptor
        ) {
          await context.compiledCacheExport.fail(
            context.exportState,
            value.message ?? "Runtime cache build failed",
            "none",
          );
        }
        break;
      case "command_rejected": {
        const correlation = String(correlationId);
        context.runtimeViewport.reject(correlation);
        if (context.pendingReturnToTitleMessageId === correlation) {
          context.pendingReturnToTitleMessageId = undefined;
          const message = `返回标题被 Runtime 拒绝：${value.message ?? "未知原因"}`;
          context.baseStatus.value = message;
          context.log("warning", message, true);
          await context.send({ type: "resynchronize", value: { after_sequence: null } });
          break;
        }
        if (context.retiredFullManifestCommandIds.delete(correlation)) break;
        const manifestImport = [...context.fullManifestImports].find((pending) =>
          pending.commandMessageIds.has(correlation),
        );
        if (manifestImport) {
          if (!manifestImport.cancelled) {
            const active = manifestImport.activeExport;
            await context.cleanupFullManifestImport(true, manifestImport);
            const message = `完整项目 manifest 导入被 Runtime 拒绝：${value.message ?? "未知原因"}`;
            if (active.kind === "diagnosis_project")
              await context.failDiagnosisExport(active, message);
            else await context.finishProjectFileExport("failed", message, false);
          } else context.retireFullManifestImport(manifestImport);
          break;
        }
        const importRejected = context.runtimeImport.reject(correlationId);
        const {
          activeExport,
          compiledCachePreparing,
          fullProjectPreparing,
          earlyFullProjectPreparation,
          staleProjection,
          rejectedInput,
          willRetryInput,
          suppressInputWarningNotification,
        } = classifyRuntimeRejection(
          value,
          correlation,
          context.exportState,
          context.pendingProjectionMessages,
          context.pendingGameInput.value,
        );
        const configurationRejected = context.runtimeConfiguration.reject(
          correlationId,
          value.message ?? "Runtime 拒绝了命令",
        );
        const undoRejected = context.pendingInputUndo.value?.messageId === correlation;
        const startupRejected =
          context.startupTelemetry.value?.outcome === "loading" &&
          correlation === context.startupTelemetryState.startMessageId;
        if (startupRejected) {
          const message = String(value.message ?? "Runtime rejected startup");
          context.startupTelemetryState.fail(message);
          context.finishProjectLoad();
          context.baseStatus.value = `项目启动失败：${message}`;
        }
        const reloadRejected = context.projectReload.matches(correlationId);
        if (reloadRejected) {
          const message = String(value.message ?? "Runtime 拒绝了热重载");
          await context.projectReload.finalize(false);
          context.finishProjectLoad();
          context.baseStatus.value = `重新加载项目失败：${message}`;
          context.log("error", context.baseStatus.value, true);
        }
        const exportRejected = context.exportState?.requestMessageId === correlation;
        const claimedByKnownOperation =
          importRejected ||
          configurationRejected ||
          undoRejected ||
          startupRejected ||
          reloadRejected ||
          staleProjection ||
          rejectedInput != null ||
          compiledCachePreparing ||
          fullProjectPreparing ||
          earlyFullProjectPreparation ||
          exportRejected;
        if (
          !claimedByKnownOperation &&
          context.runtimeClientPreferences.reject(
            correlationId,
            String(value.message ?? "Runtime 拒绝了客户端偏好"),
          )
        )
          break;
        if (rejectedInput && !willRetryInput) {
          context.runtimeInput.rejectInput(rejectedInput, willRetryInput);
        }
        context.runtimeInput.rejectUndo(correlation);
        if (
          suppressInputWarningNotification ||
          (!staleProjection &&
            !willRetryInput &&
            !compiledCachePreparing &&
            !fullProjectPreparing &&
            !earlyFullProjectPreparation &&
            !reloadRejected)
        )
          context.log(
            "warning",
            formatDiagnostic(value),
            true,
            suppressInputWarningNotification ? "none" : "all",
          );
        if (fullProjectPreparing && isFullProjectExport(activeExport)) {
          context.scheduleFullProjectExportRetry(activeExport);
        }
        if (
          context.exportState?.requestMessageId === String(correlationId) &&
          !fullProjectPreparing &&
          !String(value.message ?? "").includes("compiled project cache preparation started") &&
          !String(value.message ?? "").includes("compiled project cache is still being prepared")
        ) {
          const message = `状态导出被 Runtime 拒绝：${value.message ?? "未知原因"}`;
          if (context.exportState.kind.startsWith("diagnosis_"))
            await context.failDiagnosisExport(context.exportState, message);
          else {
            const projectFileFailed = context.exportState.kind === "project_file";
            const compiledCacheFailed = context.exportState.kind === "compiled_cache";
            if (projectFileFailed) {
              await context.finishProjectFileExport("failed", message);
            } else if (compiledCacheFailed) {
              await context.compiledCacheExport.fail(context.exportState, message, "none");
            } else {
              context.exportState = undefined;
            }
            if (!projectFileFailed && !compiledCacheFailed) context.baseStatus.value = message;
            if (context.diagnosisExporting.value)
              void context.startDiagnosisStateExport("diagnosis_replay");
          }
        }
        break;
      }
      case "exit_requested":
        if (value.reason === "restart") await context.restart();
        else await context.shutdown();
        break;
      case "shutdown_ready":
        if (context.bridge.kind === "browser") context.requestBrowserTabClose();
        else await context.bridge.close();
        break;
    }
  }

  async function handleProjectReloadReport(value: any): Promise<void> {
    if (!context.projectReload.pending) return;
    const diagnostics = value.diagnostics ?? [];
    context.appendLogEntries(
      diagnostics.map((diagnostic: any) => ({
        timestamp: new Date(),
        level: diagnostic.level ?? "info",
        message: formatDiagnostic(diagnostic),
        authoritative: true,
      })),
      diagnostics.map((diagnostic: any) =>
        context.diagnosticNotificationPolicy(diagnostic, "errors_only"),
      ),
    );
    const committedFonts = await context.projectReload.finalize(Boolean(value.success));
    if (!value.success) {
      context.finishProjectLoad();
      context.baseStatus.value = "重新加载项目失败，请查看日志";
      context.log("error", context.baseStatus.value, true);
      return;
    }
    context.refreshProjectFontFamilies(committedFonts);
    context.advanceProjectResourceGeneration();
    context.runtimeConfiguration.refreshWritable();
    context.runtimeConfiguration.update(value.configuration);
    await context.runtimeConfiguration.persistGenerated();
    if (context.projectConfiguration.value) {
      try {
        await context.bridge.applyProjectConfiguration(
          context.configurationEntries.value,
          context.runtimeViewport.chrome(currentGameViewportMeasurement()),
        );
      } catch (error) {
        context.log("warning", `客户端项目配置应用失败：${String(error)}`);
      }
    }
    await context.settleProjectViewport();
    context.runtimeManifestSparse = false;
    context.finishProjectLoad();
    context.baseStatus.value = GAME_RUNNING_STATUS;
    if (!context.runtimeManifestSparse) context.scheduleCompiledCacheExport(1000);
  }

  async function synchronizeMedia(): Promise<void> {
    document.title = context.presentation.title || "RustyEra";
    try {
      await context.audio.synchronize(context.presentation.audio);
    } catch (error) {
      context.log("warning", `音频播放失败：${String(error)}`);
    }
  }

  function currentPresentation() {
    return context.presentationProjection.current();
  }

  async function handleEffects(effects: any[]): Promise<void> {
    const outcomes = [];
    for (const effect of effects) {
      try {
        const kind = effect.kind;
        if (kind.type === "audio") await context.audio.applyEffect(parseAudioEffect(kind.value));
        else if (kind.type === "open_configuration") context.openPreferencesFromRuntime();
        else if (kind.type === "start_animation") {
          await new Promise(requestAnimationFrame);
        } else if (kind.type === "present_now") {
          context.batchMediaDirty =
            context.presentationProjection.publishForPresentNow(
              kind.value?.presentation_revision,
            ) || context.batchMediaDirty;
          if (context.batchMediaDirty) {
            await context.synchronizeMedia();
            context.batchMediaDirty = false;
          }
          // Acknowledge only after the requested recoverable revision has crossed a paint boundary.
          await new Promise(requestAnimationFrame);
        } else {
          throw new Error(`前端未启用 effect：${kind.type}`);
        }
        outcomes.push({ effect_id: effect.effect_id, status: "completed", message: null });
      } catch (error) {
        outcomes.push({ effect_id: effect.effect_id, status: "failed", message: String(error) });
      }
    }
    await context.send({ type: "effect_acknowledgement", value: { outcomes } });
  }

  function observeRuntimeEpoch(epoch: ServiceInteger): boolean {
    serviceInteger(epoch, "runtime epoch");
    if (BigInt(epoch) < BigInt(context.runtimeEpoch.value)) return false;
    if (!sameServiceInteger(epoch, context.runtimeEpoch.value)) {
      context.resetViewportProjectionBarriers();
      context.pointerObservation.clear();
      context.htmlMeasurements.clear();
      context.resetDeviceInputState(false);
    }
    context.runtimeEpoch.value = epoch;
    context.serviceRequests.enterEpoch(epoch);
    return true;
  }

  function viewportEnvironmentIdentity(): string {
    return JSON.stringify([
      context.effectivePreferences.value.fontFamilyOverride,
      context.effectivePreferences.value.fontSizeOverridePx,
      context.effectivePreferences.value.imageScale,
      context.replaceFullWidthSpaces.value,
    ]);
  }

  function resetViewportProjectionBarriers(): void {
    context.viewportProjectionBarrierGeneration += 1;
    context.projectionObservationBarriers.clear();
    context.deferredViewportProjection = undefined;
    context.viewportProjectionFlushAfterBatch = undefined;
  }

  function viewportStyleIdentity(
    layoutIdentity = context.projectionObservationBarriers.size
      ? context.viewportLayoutIdentityAtProjection
      : context.viewportLayoutIdentity,
  ): string {
    return JSON.stringify([context.viewportEnvironmentIdentity(), layoutIdentity]);
  }

  function projectionMatches(expected: ProjectionQueryContext): boolean {
    const viewport = currentGameViewport();
    return (
      sameServiceInteger(context.currentPresentation().revision, expected.presentationRevision) &&
      context.runtimeViewport.matches(
        expected,
        context.presentation.revision,
        viewport ? { width: viewport.clientWidth, height: viewport.clientHeight } : undefined,
        context.viewportStyleIdentity(),
      )
    );
  }

  function projectionEnvironment(
    expected: ProjectionQueryContext,
    presentationRevision: ServiceInteger = context.presentation.revision,
  ):
    | {
        width: number;
        height: number;
      }
    | undefined {
    if (!sameServiceInteger(context.currentPresentation().revision, expected.presentationRevision))
      return undefined;
    return context.runtimeViewport.environment(
      expected,
      presentationRevision,
      context.viewportEnvironmentIdentity(),
    );
  }

  function projectionEnvironmentMatches(expected: ProjectionQueryContext): boolean {
    return context.projectionEnvironment(expected) != null;
  }

  async function handleService(
    request: any,
    correlationId?: ServiceInteger,
    epoch = context.runtimeEpoch.value,
  ): Promise<void> {
    const lifecycle = context.lifecycleGeneration;
    const resources = context.projectResourceGeneration.value;
    const serviceBatchSequence = context.runtimeBatchSequence;
    const projectionBarrierGeneration = context.viewportProjectionBarrierGeneration;
    const projectionObservationBarrier =
      isHtmlQueryService(request) ||
      (request.kind === "canvas" && request.operation === "sample_canvas_pixel")
        ? Symbol("projection observation")
        : null;
    const active = () =>
      lifecycle === context.lifecycleGeneration &&
      sameServiceInteger(epoch, context.runtimeEpoch.value) &&
      resources === context.projectResourceGeneration.value;
    if (!active()) return;
    if (projectionObservationBarrier)
      context.projectionObservationBarriers.add(projectionObservationBarrier);
    context.serviceRequests.enterEpoch(epoch);
    try {
      const lease = context.serviceRequests.begin(request.request_id, epoch);
      let preparedProjectionContext: ProjectionQueryContext | undefined;
      const prepareProjection = async (
        expected: ProjectionQueryContext,
        lease: RuntimeServiceLease,
        layoutSensitive = true,
      ) => {
        lease.assertActive();
        if (
          !sameServiceInteger(context.currentPresentation().revision, expected.presentationRevision)
        )
          throw new RuntimeServiceError(
            "stale_projection",
            "canonical presentation revision changed",
          );
        context.batchMediaDirty =
          context.presentationProjection.publishForPresentNow(expected.presentationRevision) ||
          context.batchMediaDirty;
        await nextTick();
        lease.assertActive();
        await yieldToPaint();
        lease.assertActive();
        await nextTick();
        lease.assertActive();
        const matchesExpected = layoutSensitive
          ? context.projectionMatches(expected)
          : context.projectionEnvironmentMatches(expected);
        if (!active() || !matchesExpected) {
          const viewport = currentGameViewport();
          const mismatch = context.runtimeViewport.describeEnvironmentMismatch(
            expected,
            context.presentation.revision,
            viewport ? currentGameViewportMeasurement() : undefined,
            context.viewportEnvironmentIdentity(),
          );
          throw new RuntimeServiceError(
            "stale_projection",
            `viewport observation does not match the query: ${mismatch}`,
          );
        }
        preparedProjectionContext = expected;
        return { ...context.presentation, resources: context.presentation.resources };
      };
      await handleRuntimeService(request, correlationId, {
        bridge: context.bridge,
        currentPresentation: context.currentPresentation,
        heldKeys: context.heldKeys,
        pumpDevices: context.pumpDevices,
        clock: () => context.testEnvironment.clock,
        nextEntropy: () => context.testEnvironment.nextEntropy(),
        send: (message, correlation) =>
          active() && lease.active()
            ? context.send(message, correlation)
            : Promise.resolve(undefined),
        resourceGeneration: resources,
        imagePixels: context.imagePixels,
        audio: context.audio,
        sql: context.sqlProvider,
        lease,
        html: {
          measurement: context.htmlMeasurements,
          async prepare(expected, lease) {
            lease.assertActive();
            // HTML probes render in their own hidden host. Bind canonical resources and the
            // confirmed environment without painting an unfinished REDRAW 0 game frame.
            const projected = context.currentPresentation();
            const viewport = currentGameViewport();
            if (!viewport || !viewport.isConnected)
              throw new RuntimeServiceError(
                "stale_projection",
                "HTML measurement requires the confirmed mounted viewport",
              );
            const viewportSize = context.projectionEnvironment(expected, projected.revision);
            if (!viewportSize)
              throw new RuntimeServiceError(
                "stale_projection",
                "HTML measurement requires the confirmed historical environment",
              );
            const preferences = {
              fontFamilyOverride: context.effectivePreferences.value.fontFamilyOverride,
              fontSizeOverridePx: context.effectivePreferences.value.fontSizeOverridePx,
              imageScale: context.effectivePreferences.value.imageScale,
            };
            const preferenceIdentity = JSON.stringify(preferences);
            const spaces = context.replaceFullWidthSpaces.value;
            const assertCurrent = () => {
              lease.assertActive();
              if (
                !active() ||
                currentGameViewport() !== viewport ||
                !context.projectionEnvironment(expected, context.currentPresentation().revision) ||
                context.replaceFullWidthSpaces.value !== spaces ||
                JSON.stringify({
                  fontFamilyOverride: context.effectivePreferences.value.fontFamilyOverride,
                  fontSizeOverridePx: context.effectivePreferences.value.fontSizeOverridePx,
                  imageScale: context.effectivePreferences.value.imageScale,
                }) !== preferenceIdentity
              )
                throw new RuntimeServiceError(
                  "stale_projection",
                  "HTML projection, resources or preferences changed",
                );
            };
            assertCurrent();
            return {
              binding: {
                viewport,
                viewportSize,
                context: { ...expected },
                resources: projected.resources,
                resourceGeneration: resources,
                preferences,
                replaceFullWidthSpaces: spaces,
                resourceBridge: context.bridge,
              },
              guard: { signal: lease.signal, assertCurrent },
            };
          },
        },
        projection: {
          prepare: prepareProjection,
          prepareEnvironment: (expected, lease) => prepareProjection(expected, lease, false),
          matches: (expected) => active() && context.projectionMatches(expected),
          matchesEnvironment: (expected) =>
            active() && context.projectionEnvironmentMatches(expected),
          pointer: () => {
            if (preparedProjectionContext)
              context.testEvidence.pointerSample({
                requestId: request.request_id,
                epoch,
                sessionGeneration: context.runtimeSessionObservationGeneration,
                context: preparedProjectionContext,
              });
            return context.pointerObservation.sample(epoch);
          },
          lineGeometry: (query, serviceLease) => projectLineGeometry(query, serviceLease.signal),
          canvas: (query, projected, lease) =>
            context.canvasPixels.sample(query, projected.resources, resources, lease, () => {
              const current = resolveCanvasReplay(
                context.currentPresentation().resources.canvases,
                query.canvasId,
                query.canvasRevision,
              );
              return active() && context.projectionMatches(query.context) && current != null;
            }),
        },
      });
    } catch (error) {
      // Malformed IDs cannot be correlated safely; resource saturation can return an explicit error.
      if (!active()) return;
      if (error instanceof RuntimeServiceError && error.category === "resource_limit") {
        try {
          await context.send(
            {
              type: "service_response",
              value: {
                request_id: request.request_id,
                result: {
                  type: "error",
                  error: { code: "frontend.resource_limit", message: error.message },
                },
              },
            },
            correlationId,
          );
        } catch (failure) {
          if (active())
            context.log(
              "warning",
              `前端服务失败 ${request.kind}/${request.operation}: ${String(failure)}`,
            );
        }
      } else
        context.log(
          "warning",
          `前端服务失败 ${request.kind}/${request.operation}: ${String(error)}`,
        );
    } finally {
      if (
        projectionObservationBarrier &&
        projectionBarrierGeneration === context.viewportProjectionBarrierGeneration
      ) {
        context.projectionObservationBarriers.delete(projectionObservationBarrier);
        if (context.projectionObservationBarriers.size === 0 && context.deferredViewportProjection)
          context.viewportProjectionFlushAfterBatch = Math.max(
            context.viewportProjectionFlushAfterBatch ?? 0,
            serviceBatchSequence + 1,
          );
      }
    }
  }

  return {
    handleRuntimeAsync,
    handleProjectReloadReport,
    synchronizeMedia,
    currentPresentation,
    handleEffects,
    observeRuntimeEpoch,
    viewportEnvironmentIdentity,
    resetViewportProjectionBarriers,
    viewportStyleIdentity,
    projectionMatches,
    projectionEnvironment,
    projectionEnvironmentMatches,
    handleService,
  };
}
