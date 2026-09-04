import { preferredRuntimeLocales } from "@/core/gameText";
import { suppressedMirroredLogNotificationIndexes } from "@/core/log";
import { isRecoverableStaleDebugLog } from "@/core/runtimeSupport";
import {
  defaultPreferences,
  type Preferences,
  type ProjectFontLoadResult,
  type PumpBatch,
  type RuntimeMessage,
  type SessionOptions,
} from "@/core/types";
import { sessionFontFallback, GAME_RUNNING_STATUS } from "@/stores/runtimeState";
import type { RuntimeTestConfiguration } from "@/stores/runtimeState";

export function createRuntimeStoreActions1(context: any) {
  function resetTransientStatuses(): void {
    context.runtimeStatus.reset();
    context.runtimeProjectSettings.resetStatus();
  }

  function initialize(): Promise<void> {
    if (context.initialized) return Promise.resolve();
    if (context.initialization) return context.initialization;
    const generation = context.lifecycleGeneration;
    const operation = performInitialize(generation);
    context.initialization = operation;
    const clear = () => {
      if (context.initialization === operation) context.initialization = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  async function performInitialize(generation: number): Promise<void> {
    // Host end-to-end tests must not inherit a developer's persisted font/image
    // preferences. Those values change Emuera geometry and made identical test
    // binaries report different image positions on different machines.
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      let loadedPreferences: Preferences = {
        ...defaultPreferences(),
        trustProjectFileMetadata:
          context.bridge.kind === "browser" &&
          import.meta.env.VITE_RUSTYERA_TEST_TRUST_METADATA === "1",
      };
      if (loadedPreferences.trustProjectFileMetadata) {
        loadedPreferences = await context.bridge.savePreferences(loadedPreferences);
      }
      if (generation !== context.lifecycleGeneration) return;
      context.preferences.value = loadedPreferences;
    } else {
      const loadedPreferences = await context.bridge.loadPreferences();
      if (generation !== context.lifecycleGeneration) return;
      context.preferences.value = loadedPreferences;
    }
    context.audio.setPreferences(context.preferences.value);
    document.addEventListener("keydown", context.onKeyDown, true);
    document.addEventListener("keyup", context.onKeyUp, true);
    document.addEventListener("mousedown", context.onMouseDown, true);
    document.addEventListener("mouseup", context.onMouseUp, true);
    context.pointerObservation.start();
    document.addEventListener("visibilitychange", context.onClientStateBoundary);
    window.addEventListener("focus", context.onClientStateBoundary);
    window.addEventListener("blur", context.onClientStateBoundary);
    window.addEventListener("resize", onResize);
    context.initialized = true;
    if (context.bridge.prewarmRuntimeOnInitialize) {
      void ensureSession().catch((error) =>
        context.log("warning", `Runtime 后台初始化失败，将在打开项目时重试：${String(error)}`),
      );
    }
  }

  function teardown(): void {
    context.lifecycleGeneration += 1;
    context.pointerObservation.stop();
    context.resetViewportProjectionBarriers();
    context.serviceRequests.reset();
    context.sqlProvider.reset();
    context.canvasPixels.clear();
    context.htmlMeasurements.clear();
    context.initialization = undefined;
    clearSessionTimers();
    context.runtimePump.setTransitioning(true);
    context.runtimePump.setReady(false);
    context.retireFrontendOwners(true);
    context.audio.close();
    context.bridge.setProjectProgressListener(undefined);
    void context.bridge
      .dispose()
      .catch((error: unknown) =>
        context.log("warning", `释放 Runtime host 资源失败：${String(error)}`),
      );
    if (context.initialized) {
      context.initialized = false;
      document.removeEventListener("keydown", context.onKeyDown, true);
      document.removeEventListener("keyup", context.onKeyUp, true);
      document.removeEventListener("mousedown", context.onMouseDown, true);
      document.removeEventListener("mouseup", context.onMouseUp, true);
      document.removeEventListener("visibilitychange", context.onClientStateBoundary);
      window.removeEventListener("focus", context.onClientStateBoundary);
      window.removeEventListener("blur", context.onClientStateBoundary);
      window.removeEventListener("resize", onResize);
    }
    context.resetDeviceInputState(true);
  }

  function onResize(): void {
    void context.projectViewport();
  }

  function configureTestRun(configuration: RuntimeTestConfiguration): void {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
      throw new Error("测试运行配置只能在 VITE_RUSTYERA_TEST 中使用");
    const { start } = configuration;
    let normalizedSeed = start.seed;
    if (start.type === "new_game") {
      if (typeof normalizedSeed === "string") {
        if (!/^\d+$/.test(normalizedSeed)) throw new Error("new_game 测试必须提供十进制 u64 seed");
        normalizedSeed = BigInt(normalizedSeed);
      }
      if (
        (typeof normalizedSeed === "number" &&
          (!Number.isSafeInteger(normalizedSeed) || normalizedSeed < 0)) ||
        (typeof normalizedSeed === "bigint" &&
          (normalizedSeed < 0n || normalizedSeed > 0xffffffffffffffffn)) ||
        normalizedSeed == null
      )
        throw new Error("new_game 测试必须提供十进制 u64 seed");
    } else if (!start.bytes?.length) {
      throw new Error(`${start.type} 测试必须提供状态文件`);
    }
    context.pendingStart =
      start.type === "new_game"
        ? { type: "new_game", seed: normalizedSeed as number | bigint }
        : { type: start.type, bytes: new Uint8Array(start.bytes!) };
    context.testEnvironment.configure(
      configuration.clock,
      start.seed,
      configuration.monotonicStartNs,
    );
  }

  async function ensureSession(): Promise<void> {
    if (context.runtimePump.ready) return;
    if (context.sessionPreparation) return context.sessionPreparation;
    const attempt = (async () => {
      if (context.bridge.kind === "tauri") await context.requestSystemFonts();
      context.runtimeSessionObservationGeneration += 1;
      const options = sessionOptions();
      const batch = await context.bridge.createSession(options);
      context.sessionAudioAvailable = options.audioAvailable;
      context.runtimePump.setReady(true);
      try {
        await handleBatch(batch);
      } catch (error) {
        context.runtimePump.setReady(false);
        throw error;
      }
      schedulePump(0);
    })();
    context.sessionPreparation = attempt;
    try {
      await attempt;
    } finally {
      if (context.sessionPreparation === attempt) context.sessionPreparation = undefined;
    }
  }

  function openPreferencesFromUser(): void {
    context.preferencesOpen.value = true;
    void context.requestSystemFonts();
  }

  function openProjectSettingsFromUser(): void {
    context.projectSettingsOpen.value = true;
    void context.requestSystemFonts();
  }

  function openPreferencesFromRuntime(): void {
    context.projectSettingsOpen.value = true;
    if (context.bridge.kind === "tauri") void context.requestSystemFonts();
  }

  function sessionOptions(): SessionOptions {
    return {
      clientName: context.bridge.kind === "tauri" ? "rustyera-vue-tauri" : "rustyera-vue-wasm",
      // This fixed session capability is sampled when the runtime session is created. Browser
      // fonts granted later remain UI choices until the next session negotiates CHKFONT again.
      // Project fonts are a CSS/settings capability. CHKFONT remains the fixed system-font
      // capability sampled when the runtime session is created.
      availableFonts: [
        ...(context.systemFonts.value.length > 0 ? context.systemFonts.value : sessionFontFallback),
      ],
      preferredLocales: [...preferredRuntimeLocales(navigator.languages)],
      audioAvailable: context.audio.providerAvailable(),
      debugScopeMask: 1023,
      maximumEnvelopeBytes: 512 * 1024 * 1024,
      configurationProfile: context.bridge.kind,
    };
  }

  function refreshProjectFontFamilies(projectFonts?: ProjectFontLoadResult): void {
    projectFonts ??= { fonts: [], errors: [] };
    context.projectFontFamilies.value = projectFonts.fonts;
    for (const error of projectFonts.errors) context.log("warning", `无法加载项目字体：${error}`);
  }

  async function openProject(): Promise<void> {
    await selectProject("directory");
  }

  async function openProjectFile(): Promise<void> {
    await selectProject("file");
  }

  async function selectProject(selection: "directory" | "file"): Promise<void> {
    if (!context.canOpenProject.value) return;
    context.pendingProjectSelection = selection;
    if (context.projectOpen.value) {
      context.openProjectConfirmationOpen.value = true;
      return;
    }
    await loadProject(false, selection);
  }

  function cancelOpenProject(): void {
    context.openProjectConfirmationOpen.value = false;
  }

  async function confirmOpenProject(): Promise<void> {
    if (!context.openProjectConfirmationOpen.value || !context.canOpenProject.value) return;
    context.openProjectConfirmationOpen.value = false;
    await loadProject(true, context.pendingProjectSelection);
  }

  async function loadProject(
    replaceCurrent: boolean,
    selection: "directory" | "file",
  ): Promise<void> {
    context.projectSelecting.value = true;
    context.projectLoad.acceptProgress();
    unlockAudioFromUserGesture();
    let currentSessionReplaced = false;
    let selectionSubmitted = false;
    let runtimeProjectSubmissionLocked = false;
    try {
      const prepareAfterSelection = async () => {
        const replaceForAudioCapability =
          context.runtimePump.ready &&
          context.audio.providerAvailable() &&
          !context.sessionAudioAvailable;
        if (replaceCurrent || replaceForAudioCapability) {
          currentSessionReplaced = true;
          await recreateSessionForProjectSelection();
        } else {
          const waitingForRuntime = !context.runtimePump.ready;
          if (waitingForRuntime) context.beginProjectLoad("正在初始化 Runtime…");
          try {
            await ensureSession();
          } finally {
            if (waitingForRuntime) {
              context.finishProjectLoad();
              context.projectLoad.acceptProgress();
            }
          }
          if (context.audio.providerAvailable() && !context.sessionAudioAvailable) {
            currentSessionReplaced = true;
            await recreateSessionForProjectSelection();
          }
        }
        context.runtimePump.setTransitioning(true);
        runtimeProjectSubmissionLocked = true;
        context.runtimePump.clearTimer();
        await context.runtimePump.waitUntilIdle();
        context.baseStatus.value = "正在读取项目…";
      };
      const onSubmitted = (submittedAtMs: number) => {
        selectionSubmitted = true;
        context.startupTelemetryState.begin(submittedAtMs, selection, context.bridge.kind);
      };
      const metrics = await (selection === "file"
        ? context.bridge.openProjectFile(onSubmitted, prepareAfterSelection)
        : context.bridge.openProject(onSubmitted, prepareAfterSelection));
      if (!metrics) {
        context.finishProjectLoad();
        context.baseStatus.value = "已取消打开项目";
        return;
      }
      context.refreshProjectPreferences();
      context.runtimeConfiguration.refreshWritable();
      await context.runtimeConfiguration.persistGenerated();
      refreshProjectFontFamilies(metrics.projectFonts);
      context.projectOpen.value = true;
      context.projectSource.value = selection;
      if (!context.startupTelemetry.value)
        context.startupTelemetryState.begin(metrics.submittedAtMs, selection, context.bridge.kind);
      context.startupTelemetryState.applyBridgeMetrics(metrics, context.bridge.kind);
      context.log(
        "info",
        `项目读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      context.continueProjectBuildProgress(metrics.cacheImported);
      schedulePump(0);
    } catch (error) {
      if (runtimeProjectSubmissionLocked) {
        try {
          await recreateSessionForProjectSelection();
        } catch (resetError) {
          context.log("warning", `清理失败的项目提交时重建 Runtime 失败：${String(resetError)}`);
        }
      }
      if (selectionSubmitted) context.startupTelemetryState.fail(error);
      if (currentSessionReplaced) context.projectOpen.value = false;
      context.finishProjectLoad();
      context.baseStatus.value = String(error);
      context.log("error", context.baseStatus.value);
    } finally {
      context.projectSelecting.value = false;
      if (runtimeProjectSubmissionLocked) {
        context.runtimePump.setTransitioning(false);
        schedulePump(0);
      }
    }
  }

  async function recreateSessionForProjectSelection(): Promise<void> {
    context.runtimePump.setTransitioning(true);
    try {
      if (context.fullManifestImport) await context.cleanupFullManifestImport(true);
      context.baseStatus.value = "正在创建新的 Runtime session…";
      unlockAudioFromUserGesture();
      await context.replaceRuntimeSession();
    } catch (error) {
      context.runtimePump.setTransitioning(false);
      throw error;
    }
  }

  function unlockAudioFromUserGesture(): void {
    // Safari may keep AudioContext.resume() pending until it recognizes a trusted activation.
    // Start the request inside the user gesture, but do not make project I/O depend on audio.
    void context.audio
      .unlock()
      .catch((error: unknown) => context.log("warning", `音频解锁失败：${String(error)}`));
  }

  function clearSessionTimers(): void {
    context.runtimePump.clearTimer();
    context.compiledCacheExport.clearTimer();
  }

  function schedulePump(delay = 16): void {
    context.runtimePump.schedule(delay);
  }

  function requestNextChunk(): Promise<void> {
    return context.exportTransfer.requestChunk();
  }

  async function handleBatch(batch: PumpBatch): Promise<void> {
    const batchSequence = ++context.runtimeBatchSequence;
    const batchLifecycleGeneration = context.lifecycleGeneration;
    const batchSessionGeneration = context.runtimeSessionObservationGeneration;
    context.startupTelemetryState.recordWasmMemory(batch.memoryBytes);
    context.batchMediaDirty = false;
    const suppressedLogNotificationIndexes = suppressedMirroredLogNotificationIndexes(batch.events);
    for (let index = 0; index < batch.events.length;) {
      if (batchLifecycleGeneration !== context.lifecycleGeneration) return;
      const event = batch.events[index];
      context.testEvidence.receive(event, batchSessionGeneration);
      if (event.epoch != null && !context.observeRuntimeEpoch(event.epoch)) {
        index += 1;
        continue;
      }
      if (event.channel === "runtime" && event.message.type === "service_request") {
        // Service decoding must not block later cancellation or epoch changes in this batch.
        void context.handleService(
          (event.message as RuntimeMessage).value,
          event.correlationId,
          event.epoch ?? context.runtimeEpoch.value,
        );
        index += 1;
        continue;
      }
      if (event.channel === "runtime") {
        const pending = handleRuntime(
          event.message as RuntimeMessage,
          event.correlationId,
          suppressedLogNotificationIndexes.has(index),
          event.dataBytes,
        );
        if (pending) await pending;
      } else await context.handleDebug(event.message as any, event.correlationId);
      index += 1;
    }
    if (batchLifecycleGeneration !== context.lifecycleGeneration) return;
    if (context.presentationProjection.shouldPublish(batch.state))
      context.batchMediaDirty = context.presentationProjection.publish() || context.batchMediaDirty;
    if (context.batchMediaDirty) await context.synchronizeMedia();
    if (context.debugRequests.grantRefreshNeeded) {
      context.debugRequests.grantRefreshNeeded = false;
      await context.requestDebugGrant();
    } else if (context.debugRequests.pauseWanted) {
      await context.requestPendingDebugPause();
    }
    await context.awaitDeviceSubmissions();
    await context.settlePendingGameInput();
    await context.flushDeferredViewportProjection(batchSequence);
    // Device-pump AWAIT has completed once core resumes VM instructions. State may change back to
    // running immediately after the acknowledgement while a positive delay is still pending, so
    // phase changes alone cannot delimit this clock-sampling window.
    if (batch.vmInstructions > 0) context.devicePumpTimeAdvancePending = false;
    // Submit at most one manifest chunk after processing the previous pump's responses.
    // Awaiting the entire upload here would prevent Runtime from draining its inbound queue.
    await context.advanceFullManifestImport();
  }

  function handleRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
    suppressNotification = false,
    dataBytes?: Uint8Array,
  ): void | Promise<void> {
    const value = message.value;
    switch (message.type) {
      case "state_changed":
        handleRuntimeStateChanged(value);
        return;
      case "presentation_snapshot":
        context.batchMediaDirty =
          context.presentationProjection.projectSnapshot(value) || context.batchMediaDirty;
        return;
      case "presentation_delta":
        return handlePresentationDelta(value);
      case "wait_changed":
        handleRuntimeWaitChanged(value);
        return;
      case "input_undo_state_changed":
        context.applyInputUndo(value);
        return;
      case "log":
        if (!isRecoverableStaleDebugLog(value.message))
          context.log(
            value.level ?? "info",
            value.message,
            true,
            suppressNotification ? "none" : "all",
          );
        return;
      default:
        return context.handleRuntimeAsync(message, correlationId, dataBytes);
    }
  }

  function handleRuntimeStateChanged(value: any): void {
    context.pendingReturnToTitleMessageId = undefined;
    context.phase.value = value.phase;
    if (value.phase === "faulted" || value.phase === "stopped")
      context.devicePumpTimeAdvancePending = false;
    if (value.phase === "faulted" || value.phase === "stopped") {
      context.gameProgressLossConfirmation.value = null;
      context.runtimeImport.reset();
    }
    if (
      context.startupTelemetry.value?.milestones.startSubmittedMs != null &&
      context.startupTelemetry.value.outcome === "loading" &&
      context.startupTelemetry.value.milestones.firstGamePhaseMs == null &&
      ["running", "waiting_input", "waiting_external"].includes(value.phase)
    ) {
      context.startupTelemetry.value.milestones.firstGamePhaseMs =
        context.startupTelemetryState.elapsedMs();
      context.startupTelemetry.value.outcome = "success";
      context.startupTelemetryState.startMessageId = undefined;
      // Host-side work such as font registration may finish after Runtime has already
      // entered the game. The first game phase is the authoritative load boundary.
      context.finishProjectLoad();
      context.baseStatus.value = GAME_RUNNING_STATUS;
    }
    context.observeRuntimeEpoch(value.epoch ?? context.runtimeEpoch.value);
    if (value.phase === "faulted" || value.phase === "stopped") {
      const startupWasLoading = context.startupTelemetry.value?.outcome === "loading";
      if (startupWasLoading) context.pendingStart = { type: "new_game" };
      context.startupTelemetryState.fail(`Runtime entered ${value.phase} during startup`);
      if (startupWasLoading) context.finishProjectLoad();
    }
    if (value.phase !== "debug_paused") context.debugStop.value = null;
  }

  function handlePresentationDelta(value: any): void | Promise<void> {
    try {
      context.batchMediaDirty =
        context.presentationProjection.projectDelta(value) || context.batchMediaDirty;
    } catch (error) {
      context.presentationProjection.discard();
      context.log("warning", String(error));
      return context
        .send({ type: "resynchronize", value: { after_sequence: null } })
        .then(() => undefined);
    }
  }

  function handleRuntimeWaitChanged(value: any): void {
    if (value.type === "opened" || value.type === "updated") {
      context.runtimeInput.updateWait(value.value);
      context.presentationProjection.openInputWait(value.value);
    } else if (value.type === "closed") {
      context.presentationProjection.closeInputWait();
      context.runtimeInput.closeWait();
    }
  }

  return {
    resetTransientStatuses,
    initialize,
    performInitialize,
    teardown,
    onResize,
    configureTestRun,
    ensureSession,
    openPreferencesFromUser,
    openProjectSettingsFromUser,
    openPreferencesFromRuntime,
    sessionOptions,
    refreshProjectFontFamilies,
    openProject,
    openProjectFile,
    selectProject,
    cancelOpenProject,
    confirmOpenProject,
    loadProject,
    recreateSessionForProjectSelection,
    unlockAudioFromUserGesture,
    clearSessionTimers,
    schedulePump,
    requestNextChunk,
    handleBatch,
    handleRuntime,
    handleRuntimeStateChanged,
    handlePresentationDelta,
    handleRuntimeWaitChanged,
  };
}
