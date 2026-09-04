import {
  debugStopToken,
  debugVariableKey,
  formatDebugValue,
  isStaleDebugGrantError,
  sameDebugGrant,
  sourceLineStepCommand,
} from "@/core/debug";
import {
  defaultProjectPreferences,
  type ProjectPreferences,
  type ProjectConfigurationChange,
} from "@/core/types";
import { currentGameViewportMeasurement } from "@/platform/viewportMeasurement";
import { sameServiceInteger } from "@/core/runtimeServiceProtocol";
import { transportValue } from "@/stores/runtimeTransport";
import {
  DEBUG_VARIABLE_PAGE_LIMIT,
  DEBUG_VARIABLE_MAX_PAGES,
  PROJECT_STARTING_STATUS,
  GAME_RUNNING_STATUS,
} from "@/stores/runtimeState";
import type { RuntimeStartKind } from "@/stores/runtimeState";

export function createRuntimeStoreActions5(context: any) {
  async function restoreSnapshot(): Promise<void> {
    if (context.diagnosisExporting.value) return;
    const bytes = await context.runtimeImport.pickSnapshot();
    if (!bytes) return;
    if (context.bridge.snapshotRestoreMode === "fresh_session") {
      await context.restartSession({ type: "vm_snapshot", bytes }, "恢复快照");
    } else {
      await context.runtimeImport.begin("vm_snapshot", bytes);
    }
  }

  async function restoreState(
    kind: Exclude<RuntimeStartKind, "new_game">,
    bytes: Uint8Array,
  ): Promise<void> {
    await context.runtimeImport.begin(kind, bytes);
  }

  async function enableDebug(): Promise<void> {
    if (context.diagnosisExporting.value) return;
    await context.ensureSession();
    if (!context.debugEnabled.value) {
      await requestDebugGrant();
    } else {
      if (context.debugGrant.value)
        await submitObservedDebug({
          type: "revoke",
          value: { grant_id: context.debugGrant.value.token.grant_id, reason: "disabled by user" },
        });
      context.debugRequests.pausePending = false;
      context.debugRequests.pauseWanted = false;
      context.debugRequests.surfacePauseActive = false;
      context.debugRequests.surfaceResumePending = false;
      context.debugRequests.reset();
      context.runtimeDebug.revokeGrant();
    }
  }

  async function handleDebug(message: any, correlationId?: number | bigint): Promise<void> {
    if (
      message.type === "error" &&
      context.debugRequests.deferReply(correlationId, () => handleDebug(message, correlationId))
    )
      return;
    if (message.type === "grant") {
      context.debugRequests.pausePending = false;
      context.debugRequests.grantRefreshNeeded = false;
      context.runtimeDebug.acceptGrant(message.value);
    } else if (message.type === "revoke") {
      context.debugRequests.pausePending = false;
      context.debugRequests.pauseWanted = false;
      context.debugRequests.surfacePauseActive = false;
      context.debugRequests.surfaceResumePending = false;
      context.runtimeDebug.revokeGrant();
    } else if (message.type === "stopped") {
      context.debugRequests.pausePending = false;
      context.debugRequests.pauseWanted = false;
      context.runtimeDebug.acceptStop(message.value);
      context.debugRequests.take(correlationId);
      // The stop token is authoritative only after this event. Start refreshing here so
      // dialog visibility cannot race a Vue watcher against the pause response. Pagination
      // must continue asynchronously because its later pages arrive in future pump batches.
      void refreshOpenDebugSurfaces().catch((error) => context.log("warning", String(error)));
      if (context.debugRequests.surfaceResumePending && !context.singleStepEnabled.value) {
        context.debugRequests.surfaceResumePending = false;
        void continueDebug().catch((error) => context.log("warning", String(error)));
      }
      if (context.singleStepEnabled.value && message.value?.reason?.type === "host_wait")
        void continueDebug(true).catch((error) => context.log("warning", String(error)));
    } else if (message.type === "response") {
      const request = context.debugRequests.take(correlationId);
      const response = message.value;
      if (!request)
        context.debugRequests.deferReply(correlationId, async () => {
          context.debugRequests.take(correlationId)?.resolve?.(response);
        });
      // Apply presentation in receive order; only completion waits for registration.
      // Replaying the response after a newer stopped event would restore an old stop.
      const fiber = context.runtimeDebug.applyResponse(response);
      if (response.type === "fiber_page") {
        if (context.stackOpen.value && fiber)
          await debugCommand({
            type: "read_call_stack",
            stop: debugStopToken(context.debugStop.value),
            fiber_id: fiber.fiber_id,
          });
      }
      request?.resolve?.(response);
    } else if (message.type === "error") {
      const request = context.debugRequests.take(correlationId);
      if (request?.commandType === "pause") context.debugRequests.pausePending = false;
      if (context.debugEnabled.value && isStaleDebugGrantError(message.value)) {
        const currentToken = context.debugGrant.value?.token;
        if (!currentToken || !request || sameDebugGrant(request.grant, currentToken)) {
          context.runtimeDebug.clearGrant();
          context.debugRequests.grantRefreshNeeded = true;
        }
      } else {
        if (request?.commandType === "pause") {
          context.debugRequests.pauseWanted = false;
          context.debugRequests.surfacePauseActive = false;
          context.debugRequests.surfaceResumePending = false;
        }
        context.log("warning", message.value.message);
      }
      request?.reject?.(new Error(message.value.message ?? "debug request failed"));
    }
  }

  async function submitObservedDebug(message: any): Promise<number | bigint> {
    const epoch = context.runtimeEpoch.value;
    const sessionGeneration = context.runtimeSessionObservationGeneration;
    const messageId = await context.bridge.submitDebug(message);
    context.testEvidence.sent("debug", message, messageId, epoch, undefined, sessionGeneration);
    return messageId;
  }

  async function requestDebugGrant(): Promise<void> {
    await submitObservedDebug(
      transportValue({
        type: "hello",
        value: {
          versions: { minimum: { major: 4, minor: 0 }, maximum: { major: 4, minor: 0 } },
          requested_scopes: [
            "variables_read",
            "variables_write",
            "game_fields_read",
            "game_fields_write",
            "execution_read",
            "execution_control",
            "console_evaluate",
            "console_execute",
            "breakpoints_manage",
            "script_output",
          ],
        },
      }),
    );
    context.schedulePump(0);
  }

  async function debugCommand(command: any): Promise<void> {
    if (!context.debugGrant.value || context.diagnosisExporting.value) return;
    const grant = context.debugGrant.value.token;
    await context.debugRequests.submit(
      () =>
        submitObservedDebug(
          transportValue({
            type: "request",
            value: { grant, command },
          }),
        ),
      (messageId: number | bigint) =>
        context.debugRequests.register(messageId, grant, command?.type),
    );
  }

  async function debugRequest(command: any, timeoutMs = 10000): Promise<any> {
    if (!context.debugGrant.value) throw new Error("debug grant 尚未就绪");
    const grant = context.debugGrant.value.token;
    return context.debugRequests.submit(
      () =>
        submitObservedDebug(
          transportValue({
            type: "request",
            value: { grant, command },
          }),
        ),
      (messageId: number | bigint) => {
        const response = context.debugRequests.wait(messageId, grant, command?.type, timeoutMs);
        context.schedulePump(0);
        return response;
      },
    );
  }

  async function inspectTypedWatches(watches: string[]): Promise<Record<string, unknown>> {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
      throw new Error("typed observation requires test mode");
    const epoch = context.runtimeEpoch.value;
    const lifecycle = context.lifecycleGeneration;
    if (!context.debugEnabled.value) {
      await enableDebug();
      await context.waitUntil(() => context.debugGrant.value != null, 10000, "typed debug grant");
    }
    const alreadyStopped = debugStopToken(context.debugStop.value) != null;
    if (!alreadyStopped) {
      await pauseDebug();
      await context.waitUntil(
        () => debugStopToken(context.debugStop.value) != null,
        10000,
        "typed debug stop",
      );
    }
    const stop = { ...debugStopToken(context.debugStop.value) };
    const current = () =>
      lifecycle === context.lifecycleGeneration &&
      sameServiceInteger(epoch, context.runtimeEpoch.value) &&
      ["session_epoch", "pause_epoch", "program_generation", "runtime_revision"].every((field) =>
        sameServiceInteger(stop[field], debugStopToken(context.debugStop.value)?.[field]),
      );
    try {
      return await context.readTestTypedWatches(
        watches,
        stop,
        debugRequest,
        () => {
          if (!current()) throw new Error("typed watch stop or session changed");
        },
        lifecycle,
      );
    } finally {
      // Never resume a replacement session or somebody else's newer stop.
      if (!alreadyStopped && current()) await continueDebug();
    }
  }

  async function inspectWatches(watches: string[]): Promise<Record<string, unknown>> {
    if (!context.debugEnabled.value) {
      await enableDebug();
      await context.waitUntil(() => context.debugGrant.value != null, 10000, "debug grant");
    }
    const alreadyStopped = debugStopToken(context.debugStop.value) != null;
    if (!alreadyStopped) {
      await pauseDebug();
      await context.waitUntil(
        () => debugStopToken(context.debugStop.value) != null,
        10000,
        "debug stop",
      );
    }
    const stop = debugStopToken(context.debugStop.value);
    const page = await debugRequest({ type: "list_variables", stop, cursor: null, limit: 256 });
    const variables = page.value?.variables ?? [];
    const result: Record<string, unknown> = {};
    for (const watch of watches) {
      const [name, indexText] = watch.split(":", 2);
      const variable = variables.find((candidate: any) => candidate.name === name);
      if (!variable) {
        result[watch] = { error: "not_found" };
        continue;
      }
      const indices = indexText
        ? indexText.split(",").map((value) => Number(value))
        : (variable.dimensions ?? []).map(() => 0);
      const response = await debugRequest({
        type: "read_variable",
        stop,
        value: {
          symbol_key: variable.symbol_key,
          storage: variable.storage,
          fiber_id: null,
          frame_id: null,
          generation: stop.program_generation,
          character: null,
          indices,
        },
      });
      result[watch] = formatDebugValue(response.value?.value);
    }
    if (!alreadyStopped) await continueDebug();
    return result;
  }

  async function pauseDebug(): Promise<void> {
    context.debugRequests.pauseWanted = true;
    await requestPendingDebugPause();
  }

  async function requestPendingDebugPause(): Promise<void> {
    if (
      !context.debugRequests.pauseWanted ||
      !context.debugGrant.value ||
      debugStopToken(context.debugStop.value) ||
      context.debugRequests.pausePending ||
      !["running", "waiting_input", "waiting_external", "faulted"].includes(context.phase.value)
    )
      return;
    context.debugRequests.pausePending = true;
    try {
      await debugCommand({ type: "pause" });
    } catch (error) {
      context.debugRequests.pausePending = false;
      throw error;
    }
  }

  async function openDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (context.diagnosisExporting.value) return;
    if (kind === "console") context.debugConsoleOpen.value = true;
    else if (kind === "variables") {
      context.variablesOpen.value = true;
      context.runtimeDebug.clearVariables();
    } else {
      context.stackOpen.value = true;
      context.runtimeDebug.clearStack();
    }
    if (debugStopToken(context.debugStop.value)) await refreshOpenDebugSurfaces();
    else {
      context.debugRequests.surfacePauseActive = true;
      context.debugRequests.surfaceResumePending = false;
      await pauseDebug();
    }
  }

  async function closeDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (kind === "console") context.debugConsoleOpen.value = false;
    else if (kind === "variables") context.variablesOpen.value = false;
    else context.stackOpen.value = false;
    if (context.debugConsoleOpen.value || context.variablesOpen.value || context.stackOpen.value)
      return;
    if (!context.debugRequests.surfacePauseActive) return;
    context.debugRequests.surfacePauseActive = false;
    if (context.singleStepEnabled.value) return;
    if (debugStopToken(context.debugStop.value)) await continueDebug();
    else context.debugRequests.surfaceResumePending = true;
  }

  async function refreshOpenDebugSurfaces(): Promise<void> {
    const stop = debugStopToken(context.debugStop.value);
    if (!stop) return;
    const commands = [debugCommand({ type: "list_fibers", stop, cursor: null, limit: 256 })];
    if (context.variablesOpen.value) commands.push(refreshDebugVariables(stop));
    await Promise.all(commands);
  }

  async function refreshDebugVariables(stop: any): Promise<void> {
    const refreshId = context.debugRequests.nextVariableRefresh();
    context.debugVariablesLoading.value = true;
    const variables: any[] = [];
    const seen = new Set<string>();
    let cursor: number | bigint | null = null;
    let pages = 0;
    try {
      do {
        const response = await debugRequest({
          type: "list_variables",
          stop,
          cursor,
          limit: DEBUG_VARIABLE_PAGE_LIMIT,
        });
        pages += 1;
        for (const variable of response.value?.variables ?? []) {
          const key = debugVariableKey(variable);
          if (seen.has(key)) continue;
          seen.add(key);
          variables.push(variable);
        }
        cursor = response.value?.next_cursor ?? null;
      } while (
        cursor != null &&
        pages < DEBUG_VARIABLE_MAX_PAGES &&
        context.debugRequests.isCurrentVariableRefresh(refreshId)
      );
      if (context.debugRequests.isCurrentVariableRefresh(refreshId))
        context.debugVariables.value = variables;
    } finally {
      if (context.debugRequests.isCurrentVariableRefresh(refreshId))
        context.debugVariablesLoading.value = false;
    }
  }

  async function stepDebug(): Promise<void> {
    if (!context.singleStepEnabled.value || context.diagnosisExporting.value) return;
    const command = sourceLineStepCommand(context.debugStop.value);
    if (!command) return;
    const previousStop = context.debugStop.value;
    context.debugRequests.pauseWanted = false;
    context.debugStop.value = null;
    try {
      await debugRequest(command);
    } catch (error) {
      context.debugStop.value = previousStop;
      throw error;
    }
  }

  async function continueDebug(preserveSingleStep = false): Promise<void> {
    if (context.diagnosisExporting.value) return;
    const stop = debugStopToken(context.debugStop.value);
    if (!stop) return;
    if (!preserveSingleStep) context.singleStepEnabled.value = false;
    const previousStop = context.debugStop.value;
    context.debugRequests.pauseWanted = false;
    context.debugRequests.surfacePauseActive = false;
    context.debugRequests.surfaceResumePending = false;
    context.debugStop.value = null;
    try {
      await debugRequest({ type: "continue", stop });
    } catch (error) {
      context.debugStop.value = previousStop;
      throw error;
    }
  }

  async function toggleSingleStep(): Promise<void> {
    if (!context.debugEnabled.value || context.diagnosisExporting.value) return;
    context.singleStepEnabled.value = !context.singleStepEnabled.value;
    if (context.singleStepEnabled.value) {
      if (!debugStopToken(context.debugStop.value)) await pauseDebug();
    } else if (debugStopToken(context.debugStop.value)) {
      await continueDebug(true);
    }
  }

  async function saveProjectSettings(
    changes: ProjectConfigurationChange[] = [],
    restartAfterApply = false,
  ): Promise<void> {
    await context.runtimeProjectSettings.save(changes, restartAfterApply);
  }

  async function continueLoadedProject(runtimeAcceptedCompiledCache: boolean): Promise<void> {
    if (runtimeAcceptedCompiledCache) {
      context.showProjectLoadTransition("项目缓存命中，正在准备脚本热重载…");
      await context.bridge.prepareProjectReloadBaseline();
    }
    await settleProjectViewport();
    context.startupTelemetryState.completeFrontendReadiness();
    if (["running", "waiting_input", "waiting_external"].includes(context.phase.value)) {
      const telemetry = context.startupTelemetry.value;
      if (telemetry?.outcome === "loading") {
        telemetry.milestones.firstGamePhaseMs ??= context.startupTelemetryState.elapsedMs();
        telemetry.outcome = "success";
      }
      context.finishProjectLoad();
      context.baseStatus.value = GAME_RUNNING_STATUS;
      if (!context.runtimeManifestSparse) context.scheduleCompiledCacheExport(1000);
      return;
    }
    context.baseStatus.value = PROJECT_STARTING_STATUS;
    context.finishProjectLoad();
    const start = context.pendingStart;
    context.pendingStart = { type: "new_game" };
    if (start.type === "new_game") {
      await context.send({
        type: "start",
        value: { mode: { type: "new_game", seed: start.seed ?? null } },
      });
    } else {
      await restoreState(start.type, start.bytes);
    }
    if (!context.runtimeManifestSparse) context.scheduleCompiledCacheExport(1000);
  }

  function refreshProjectPreferences(): void {
    context.projectPreferences.value =
      context.bridge.currentProjectPreferences() ?? defaultProjectPreferences();
    context.projectPreferencesWritable.value = context.bridge.projectPreferencesWritable();
  }

  async function applyEffectiveClientConfiguration(): Promise<void> {
    if (!context.projectConfiguration.value) return;
    try {
      await context.bridge.applyProjectConfiguration(
        context.configurationEntries.value,
        context.runtimeViewport.chrome(currentGameViewportMeasurement()),
      );
    } catch (error) {
      context.log("warning", `客户端项目配置应用失败：${String(error)}`);
    }
  }

  async function saveClientPreferences(
    scope: "global" | "project",
    value: ProjectPreferences,
  ): Promise<void> {
    await context.runtimeClientPreferences.save(scope, value);
  }

  async function projectViewport(
    measurement = currentGameViewportMeasurement(),
    layoutIdentity = context.viewportLayoutIdentity,
  ): Promise<void> {
    context.viewportLayoutIdentity = layoutIdentity;
    const environmentIdentity = context.viewportEnvironmentIdentity();
    if (context.projectionObservationBarriers.size > 0 && measurement != null) {
      context.deferredViewportProjection = { measurement: { ...measurement }, layoutIdentity };
      return;
    }
    await context.runtimeViewport.observe(
      measurement,
      context.runtimePump.ready,
      context.presentation.revision,
      context.prompt.value,
      context.viewportStyleIdentity(layoutIdentity),
      environmentIdentity,
    );
    if (measurement) {
      context.viewportLayoutIdentityAtProjection = layoutIdentity;
    }
  }

  async function flushDeferredViewportProjection(batchSequence: number): Promise<void> {
    if (
      !context.deferredViewportProjection ||
      context.projectionObservationBarriers.size > 0 ||
      context.viewportProjectionFlushAfterBatch == null ||
      batchSequence < context.viewportProjectionFlushAfterBatch
    )
      return;
    const deferred = context.deferredViewportProjection;
    context.deferredViewportProjection = undefined;
    context.viewportProjectionFlushAfterBatch = undefined;
    try {
      await projectViewport(deferred.measurement, deferred.layoutIdentity);
    } catch (error) {
      context.log("warning", `延后提交视口投影失败：${String(error)}`);
    }
  }

  async function settleProjectViewport(): Promise<void> {
    await context.runtimeViewport.settle(projectViewport);
  }

  return {
    restoreSnapshot,
    restoreState,
    enableDebug,
    handleDebug,
    submitObservedDebug,
    requestDebugGrant,
    debugCommand,
    debugRequest,
    inspectTypedWatches,
    inspectWatches,
    pauseDebug,
    requestPendingDebugPause,
    openDebugDialog,
    closeDebugDialog,
    refreshOpenDebugSurfaces,
    refreshDebugVariables,
    stepDebug,
    continueDebug,
    toggleSingleStep,
    saveProjectSettings,
    continueLoadedProject,
    refreshProjectPreferences,
    applyEffectiveClientConfiguration,
    saveClientPreferences,
    projectViewport,
    flushDeferredViewportProjection,
    settleProjectViewport,
  };
}
