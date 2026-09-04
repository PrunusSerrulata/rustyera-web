import { RuntimeEvidence, createTypedWatchReader } from "@/testing/runtimeEvidence";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { PresentationState } from "@/core/presentation";
import { createRuntimeStoreActions1 } from "@/stores/runtimeStoreActions1";
import { createRuntimeStoreActions2 } from "@/stores/runtimeStoreActions2";
import { createRuntimeStoreActions3 } from "@/stores/runtimeStoreActions3";
import { createRuntimeStoreActions4 } from "@/stores/runtimeStoreActions4";
import { createRuntimeStoreActions5 } from "@/stores/runtimeStoreActions5";
import { createRuntimeStoreActions6 } from "@/stores/runtimeStoreActions6";
import { createRuntimeStoreProjection } from "@/stores/runtimeStoreProjection";

type RuntimeStoreActions = ReturnType<typeof createRuntimeStoreActions1> &
  ReturnType<typeof createRuntimeStoreActions2> &
  ReturnType<typeof createRuntimeStoreActions3> &
  ReturnType<typeof createRuntimeStoreActions4> &
  ReturnType<typeof createRuntimeStoreActions5> &
  ReturnType<typeof createRuntimeStoreActions6>;

import { AudioEngine } from "@/core/audio";
import { debugStopToken, selectedDebugFiber } from "@/core/debug";
import { resolveGameTextStyle } from "@/core/gameText";
import { menuVisibilityMode } from "@/core/menuVisibility";
import {
  diagnosisProgressPercentage,
  formatDiagnosisProgress,
  formatProjectProgress,
} from "@/core/runtimeSupport";
import { formatRuntimeFault } from "@/core/runtimeFault";
import {
  defaultPreferences,
  defaultProjectPreferences,
  type Preferences,
  type ProjectPreferences,
  type ProjectGameInformation,
  type ProjectProgress,
  type PumpBatch,
  type RuntimeMessage,
} from "@/core/types";
import { platformBridge } from "@/platform";
import { currentGameViewport, type GameViewportMeasurement } from "@/platform/viewportMeasurement";
import { RuntimePointerObservation } from "@/platform/pointerObservation";
import { RuntimeCanvasPixelSampler } from "@/components/canvasPixelSampler";
import { HtmlMeasurementProvider } from "@/platform/htmlMeasurement";
import { type ServiceInteger } from "@/core/runtimeServiceProtocol";
import { RuntimeServiceRequests } from "@/stores/runtimeServiceRequests";
import { RuntimePumpCoordinator } from "@/stores/runtimePump";
import { RuntimePresentationProjection } from "@/stores/runtimePresentation";
import { RuntimeConfigurationState } from "@/stores/runtimeConfiguration";
import { RuntimeCompiledCacheExportState } from "@/stores/runtimeCompiledCache";
import { RuntimeExportTransferState } from "@/stores/runtimeExportTransfer";
import { RuntimeProjectLoadState } from "@/stores/runtimeProjectLoad";
import { RuntimeProjectReloadState } from "@/stores/runtimeProjectReload";
import { RuntimeProjectFileExportState } from "@/stores/runtimeProjectFileExport";
import { isNonNotifiedInputWarning } from "@/stores/runtimeRejections";
import { RuntimeLogState } from "@/stores/runtimeLogs";
import { RuntimeInputState } from "@/stores/runtimeInput";
import { RuntimeImportState } from "@/stores/runtimeImport";
import { RuntimeDebugRequestState } from "@/stores/runtimeDebugRequests";
import { RuntimeDebugState } from "@/stores/runtimeDebugState";
import { RuntimeDiagnosisState } from "@/stores/runtimeDiagnosis";
import { RuntimeImagePixelCache } from "@/stores/runtimeServices";
import { SqlProvider } from "@/platform/sqlProvider";
import { RuntimeProjectSettingsState } from "@/stores/runtimeProjectSettings";
import { RuntimeClientPreferencesState } from "@/stores/runtimeClientPreferences";
import { RuntimeStatusState } from "@/stores/runtimeStatus";
import { RuntimeStartupTelemetryState } from "@/stores/runtimeStartupTelemetry";
import { RuntimeTestEnvironment } from "@/stores/runtimeTestEnvironment";
import { RuntimeTraditionalSaveState } from "@/stores/runtimeTraditionalSaves";
import { RuntimeViewportState } from "@/stores/runtimeViewport";
import { useSystemFontAccess } from "@/stores/systemFontAccess";
import {
  diagnosisProgressStage,
  MAXIMUM_LOG_ENTRIES,
  MAXIMUM_LOG_ENTRY_BYTES,
  MAXIMUM_LOG_TOTAL_BYTES,
  STATE_EXPORT_CHUNK_BYTES,
  TAURI_STATE_EXPORT_CHUNK_BYTES,
} from "@/stores/runtimeState";
import type {
  LogEntry,
  LogNotificationPolicy,
  ExportState,
  DiagnosisStateExportKind,
  FullManifestImportTransaction,
  RuntimeStartKind,
} from "@/stores/runtimeState";

const FULL_PROJECT_MANIFEST_CHUNK_BYTES = 4 * 1024 * 1024;
const KEYBOARD_DEVICE_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

function diagnosticNotificationPolicy(
  diagnostic: any,
  fallback: LogNotificationPolicy,
): LogNotificationPolicy {
  if (diagnostic.notification === "log_only") return "none";
  return fallback;
}

export const useRuntimeStore = defineStore("runtime", () => {
  const bridge = platformBridge();
  const presentationProjection = new RuntimePresentationProjection();
  const presentation = presentationProjection.presentation;
  const presentationStaged = presentationProjection.staged;
  const preferences = ref<Preferences>(defaultPreferences());
  const projectPreferences = ref<ProjectPreferences>(defaultProjectPreferences());
  const projectPreferencesWritable = ref(false);
  const runtimeViewport = new RuntimeViewportState(send);
  let viewportLayoutIdentity = "";
  let viewportLayoutIdentityAtProjection = "";
  const projectionObservationBarriers = new Set<symbol>();
  let viewportProjectionBarrierGeneration = 0;
  let runtimeBatchSequence = 0;
  let viewportProjectionFlushAfterBatch: number | undefined;
  let deferredViewportProjection:
    { measurement: GameViewportMeasurement; layoutIdentity: string } | undefined;
  const viewportMeasurement = runtimeViewport.measurement;
  const {
    systemFonts,
    status: fontAccessStatus,
    error: fontAccessError,
    request: requestSystemFonts,
  } = useSystemFontAccess(bridge, (message) => log("warning", `无法读取系统字体：${message}`));
  const projectFontFamilies = ref<string[]>([]);
  const availableFontFamilies = computed(() => {
    const unique = new Map<string, string>();
    for (const family of [...projectFontFamilies.value, ...systemFonts.value]) {
      const key = family.toLowerCase();
      if (!unique.has(key)) unique.set(key, family);
    }
    return [...unique.values()];
  });
  const phase = ref("negotiating");
  const runtimeEpoch = ref<number | bigint>(0);
  const projectResourceGeneration = ref(0);
  const runtimeStatus = new RuntimeStatusState();
  const baseStatus = runtimeStatus.base;
  const status = runtimeStatus.current;
  const projectOpen = ref(false);
  const gameInformation = ref<ProjectGameInformation | null>(null);
  const coreVersion = ref(import.meta.env.VITE_RUSTYERA_CORE_VERSION);
  const projectLoad = new RuntimeProjectLoadState();
  const projectLoading = projectLoad.loading;
  const projectSelecting = ref(false);
  const projectProgress = projectLoad.progress;
  const projectFileExportState = new RuntimeProjectFileExportState();
  const projectFileExporting = projectFileExportState.exporting;
  const projectFileExportProgress = projectFileExportState.progress;
  const projectLoadElapsedSeconds = projectLoad.elapsedSeconds;
  const startupTelemetryState = new RuntimeStartupTelemetryState();
  const startupTelemetry = startupTelemetryState.current;
  const openProjectConfirmationOpen = ref(false);
  const gameProgressLossConfirmation = ref<"restart" | "title" | null>(null);
  const projectReload = new RuntimeProjectReloadState(bridge);
  const projectReloadDialogMode = projectReload.dialogMode;
  const projectReloadTargetOptions = projectReload.targetOptions;
  const projectReloadDialogBusy = projectReload.dialogBusy;
  const projectReloadDialogError = projectReload.dialogError;
  let pendingProjectSelection: "directory" | "file" = "directory";
  const projectSource = ref<"directory" | "file">("directory");
  const prompt = ref("");
  const inputUndo = ref<any>(null);
  const fault = ref<any>(null);
  const faultMessage = computed(() => formatRuntimeFault(fault.value));
  const faultActionBusy = ref(false);
  const runtimeLogs = new RuntimeLogState(
    MAXIMUM_LOG_ENTRIES,
    MAXIMUM_LOG_ENTRY_BYTES,
    MAXIMUM_LOG_TOTAL_BYTES,
  );
  const testEnvironment = new RuntimeTestEnvironment();
  const testEvidence = new RuntimeEvidence(import.meta.env.VITE_RUSTYERA_TEST === "1");
  const readTestTypedWatches = createTypedWatchReader();
  const logs = runtimeLogs.entries;
  const projectSettingsOpen = ref(false);
  const preferencesOpen = ref(false);
  const logsOpen = ref(false);
  const runtimeDebug = new RuntimeDebugState();
  const debugConsoleOpen = runtimeDebug.consoleOpen;
  const variablesOpen = runtimeDebug.variablesOpen;
  const stackOpen = runtimeDebug.stackOpen;
  const debugEnabled = runtimeDebug.enabled;
  const singleStepEnabled = runtimeDebug.singleStepEnabled;
  const debugGrant = runtimeDebug.grant;
  const debugStop = runtimeDebug.stop;
  const debugOutput = runtimeDebug.output;
  const debugVariables = runtimeDebug.variables;
  const debugVariablesLoading = runtimeDebug.variablesLoading;
  const debugFibers = runtimeDebug.fibers;
  const debugFrames = runtimeDebug.frames;
  const debugVariableValues = runtimeDebug.variableValues;
  const runtimeDiagnosis = new RuntimeDiagnosisState();
  const diagnosisExporting = runtimeDiagnosis.exporting;
  const diagnosisProgress = runtimeDiagnosis.progress;
  const diagnosisResult = runtimeDiagnosis.result;
  const logNotifications = runtimeLogs.notifications;
  const traditionalSaves = new RuntimeTraditionalSaveState(
    bridge.traditionalSaves,
    (message) => (baseStatus.value = message),
  );
  const traditionalSaveDialogMode = traditionalSaves.mode;
  const traditionalSaveSlots = traditionalSaves.slots;
  const traditionalSaveImportName = traditionalSaves.importName;
  const traditionalSaveTransferBusy = traditionalSaves.busy;
  const traditionalSaveTransferError = traditionalSaves.error;
  const traditionalSaveOverwriteSlot = traditionalSaves.overwriteSlot;
  const heldKeys = new Set<number>();
  const heldMouseButtons = new Set<number>();
  const heldMousePositions = new Map<number, readonly [number, number]>();
  const keyToggleStates = new Map<number, boolean>();
  let deviceSubmissionTail: Promise<void> = Promise.resolve();
  let deviceSubmissionFailure: { generation: number; error: unknown } | undefined;
  let deviceSynchronizationPending = true;
  let deviceEventSequence = 0;
  let deviceGeneration = 0;
  let devicePumpTimeAdvancePending = false;
  const testAudioPlayback = new Map<string, { starts: number; active: number }>();
  const audio = new AudioEngine(
    bridge,
    preferences.value,
    (error) => log("warning", `音频播放失败：${String(error)}`),
    import.meta.env.VITE_RUSTYERA_TEST === "1" ? recordTestAudioPlayback : undefined,
  );
  const imagePixels = new RuntimeImagePixelCache();
  const serviceRequests = new RuntimeServiceRequests();
  const sqlProvider = new SqlProvider(bridge);
  const pointerObservation = new RuntimePointerObservation(currentGameViewport);
  const canvasPixels = new RuntimeCanvasPixelSampler();
  const htmlMeasurements = new HtmlMeasurementProvider();
  let initialized = false;
  let initialization: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  // Observation identity follows host session creation, not the application's teardown lifetime.
  let runtimeSessionObservationGeneration = 0;
  let sessionAudioAvailable = false;
  const runtimeConfiguration = new RuntimeConfigurationState({
    bridge,
    send,
    setVolume: (volume) => audio.setGameVolume(volume),
    log,
    updateSettingsStatus: (token, message) => runtimeStatus.update("settings", token, message),
    viewportChrome: () => runtimeViewport.chrome(),
    refreshCompiledCache: refreshCompiledCacheAfterConfigurationUpdate,
  });
  const projectConfiguration = runtimeConfiguration.snapshot;
  const runtimeProjectSettings = new RuntimeProjectSettingsState({
    open: projectSettingsOpen,
    configuration: runtimeConfiguration,
    status: runtimeStatus,
    restart,
    logError: (message) => log("error", message),
  });
  bridge.setProjectProgressListener(handleProjectProgress);
  let exportState: ExportState | undefined;
  const compiledCacheExport = new RuntimeCompiledCacheExportState({
    bridge,
    exportState: () => exportState,
    replaceExportState: (state) => (exportState = state),
    request: requestCompiledCacheExport,
    requestNextChunk,
    finishTransfer: finishExportTransfer,
    cancelRuntimeExport: async () => {
      await send({ type: "state_export_cancel", value: { kind: "compiled_project_cache" } });
    },
    beginStatus: (message) => runtimeStatus.begin("compiled_cache", message),
    finishStatus: (token, message) => runtimeStatus.finish("compiled_cache", token, message),
    clearStatus: (token) => runtimeStatus.clear("compiled_cache", token),
    projectLoading: () => projectLoading.value,
    diagnosisExporting: () => diagnosisExporting.value,
    resumeDiagnosisExport: () => startDiagnosisStateExport("diagnosis_replay"),
    logWarning: (message, notificationPolicy = "all") =>
      log("warning", message, false, notificationPolicy),
  });
  const exportTransfer = new RuntimeExportTransferState({
    exportState: () => exportState,
    clearExportState: () => (exportState = undefined),
    send,
    setDiagnosisProgress: (kind, completed, total) =>
      runtimeDiagnosis.setProgress(diagnosisProgressStage(kind), completed, total),
    failDiagnosis: failDiagnosisExport,
    beginProjectFilePackaging: (total) => projectFileExportState.beginPackaging(total),
    updateProjectFilePackaging: (completed, total) =>
      projectFileExportState.updatePackaging(completed, total),
    writeProjectFileChunk: (bytes, reset, complete) =>
      bridge.writeProjectFileChunk(bytes, reset, complete),
    beginStateDownload: (name, totalBytes) => bridge.beginStateExport(name, totalBytes),
    writeStateDownload: (bytes, reset, complete) =>
      bridge.writeStateExportChunk(bytes, reset, complete),
    cancelStateDownload: () => bridge.cancelStateExport(),
    failProjectFile: (message) => finishProjectFileExport("failed", message),
    enqueueCompiledCacheWrite: (activeExport, bytes, reset, complete) =>
      compiledCacheExport.enqueueHostWrite(activeExport, bytes, reset, complete),
    continueCompiledCache: (activeExport, complete) =>
      compiledCacheExport.continue(activeExport, complete),
    failCompiledCache: (activeExport, error) => compiledCacheExport.fail(activeExport, error),
    finishExport: finishExportTransfer,
    diagnosisRetainedBytes: () =>
      (runtimeDiagnosis.active?.inputReplay?.byteLength ?? 0) +
      (runtimeDiagnosis.active?.snapshot?.byteLength ?? 0),
    logWarning: (message) => log("warning", message),
    exportChunkBytes: () =>
      bridge.kind === "tauri" ? TAURI_STATE_EXPORT_CHUNK_BYTES : STATE_EXPORT_CHUNK_BYTES,
  });
  type PendingRuntimeStart =
    | { type: "new_game"; seed?: number | bigint }
    | { type: Exclude<RuntimeStartKind, "new_game">; bytes: Uint8Array };
  let pendingStart: PendingRuntimeStart = { type: "new_game" };
  let runtimeManifestSparse = false;
  let pendingReturnToTitleMessageId: string | undefined;
  let batchMediaDirty = false;
  const debugRequests = new RuntimeDebugRequestState();
  const runtimeInput = new RuntimeInputState({
    presentation: currentPresentation,
    mutableInteractions: () => presentationProjection.mutableInteractions(),
    send,
    sampleMonotonic: () => testEnvironment.sampleMonotonic(),
    phase: () => phase.value,
    signalMessageSkip,
    logWarning: (message) =>
      log("warning", message, true, isNonNotifiedInputWarning(message) ? "none" : "all"),
  });
  const pendingGameInput = runtimeInput.pending;
  const pendingInputUndo = runtimeInput.pendingUndo;
  const pendingProjectionMessages = runtimeViewport.pendingMessages;
  const runtimeImport = new RuntimeImportState(bridge, send);
  let fullManifestImport: FullManifestImportTransaction | undefined;
  const fullManifestImports = new Set<FullManifestImportTransaction>();
  const retiredFullManifestCommandIds = new Set<string>();
  const runtimePump = new RuntimePumpCoordinator(bridge, {
    handleBatch,
    advanceTimedWait,
    handleError(error) {
      gameProgressLossConfirmation.value = null;
      void projectReload.finalize(false);
      runtimeImport.reset();
      startupTelemetryState.fail(error);
      finishProjectLoad();
      resetViewportProjectionBarriers();
      serviceRequests.reset();
      sqlProvider.reset();
      htmlMeasurements.clear();
      canvasPixels.clear();
      fault.value = { code: "frontend", message: String(error) };
      log("error", String(error), false, "none");
    },
  });

  const effectivePreferences = computed(() => {
    const global = preferences.value;
    return {
      ...global,
      imageScale: projectPreferences.value.imageScale ?? global.imageScale,
      masterVolume: projectPreferences.value.masterVolume ?? global.masterVolume,
      trustProjectFileMetadata:
        projectPreferences.value.trustProjectFileMetadata ?? global.trustProjectFileMetadata,
      interactionAssistMode:
        projectPreferences.value.interactionAssistMode ?? global.interactionAssistMode,
    };
  });
  const runtimeClientPreferences = new RuntimeClientPreferencesState({
    bridge,
    global: preferences,
    project: projectPreferences,
    open: preferencesOpen,
    snapshot: () => projectConfiguration.value ?? undefined,
    entries: () => configurationEntries.value,
    effective: () => effectivePreferences.value,
    send,
    updateConfiguration: (value) => runtimeConfiguration.update(value),
    applyHostConfiguration: applyEffectiveClientConfiguration,
    applyAudio: (value) => audio.setPreferences(value),
    beginStatus: (message) => runtimeStatus.begin("settings", message),
    appendElapsed: (token, seconds) => runtimeStatus.appendElapsed("settings", token, seconds),
    finishStatus: (token, message) => runtimeStatus.finish("settings", token, message),
    clearStatus: (token) => runtimeStatus.clear("settings", token),
    logWarning: (message) => log("warning", message),
    logError: (message) => log("error", message),
  });
  let sessionPreparation: Promise<void> | undefined;
  const settingsBusy = computed(
    () => runtimeProjectSettings.busy.value || runtimeClientPreferences.busy.value,
  );
  const projectSettingsError = runtimeProjectSettings.error;
  const preferencesError = runtimeClientPreferences.error;
  const configurationEntries = runtimeConfiguration.entries;
  const configurationReadOnly = runtimeConfiguration.readOnly;
  const configurationSessionOnly = runtimeConfiguration.sessionOnly;
  const configurationRestartPending = runtimeConfiguration.restartPending;
  const menuMode = computed(() => menuVisibilityMode(runtimeConfiguration.value("UseMenu")));
  const useMouse = computed(() => runtimeConfiguration.boolean("UseMouse", true));
  const replaceFullWidthSpaces = computed(() =>
    runtimeConfiguration.boolean("ReplaceFullWidthSpaces", false),
  );
  const scrollHeight = computed(() => {
    const value = Number(runtimeConfiguration.value("ScrollHeight") ?? 1);
    return Number.isSafeInteger(value) ? Math.max(1, value) : 1;
  });
  const gameTextStyle = computed(() =>
    resolveGameTextStyle(
      effectivePreferences.value,
      presentation.lines,
      runtimeConfiguration.value("FontName"),
    ),
  );
  const gameLineHeightPx = computed(() => {
    if (effectivePreferences.value.fontSizeOverridePx != null)
      return gameTextStyle.value.fontSizePx + 1;
    const configured = Number(presentation.settings.line_height ?? 0) / 1000;
    return Number.isFinite(configured) && configured > 0
      ? configured
      : gameTextStyle.value.fontSizePx + 1;
  });
  const canInteract = computed(
    () =>
      !presentationStaged.value &&
      presentation.inputWait != null &&
      pendingGameInput.value == null &&
      pendingInputUndo.value == null &&
      phase.value !== "debug_paused" &&
      !fault.value &&
      !diagnosisExporting.value &&
      !projectFileExporting.value &&
      projectReloadDialogMode.value == null &&
      traditionalSaveDialogMode.value == null,
  );
  const runtimeReady = computed(
    () =>
      runtimePump.ready &&
      projectOpen.value &&
      [
        "running",
        "waiting_input",
        "waiting_external",
        "debug_paused",
        "stopped",
        "faulted",
      ].includes(phase.value),
  );
  const canExportDiagnosis = computed(
    () => runtimeReady.value && !diagnosisExporting.value && !runtimePump.transitioning,
  );
  const fullProjectExportSupported = computed(() => {
    // Project source changes when a new selection replaces the active project. Keep the host-owned
    // capability query reactive without duplicating its platform-specific state in the store.
    void projectSource.value;
    return bridge.fullProjectExportSupported();
  });
  const canExportProjectFile = computed(
    () => runtimeReady.value && !gameInteractionsBlocked.value && fullProjectExportSupported.value,
  );
  const canManageTraditionalSaves = computed(
    () =>
      bridge.traditionalSaves != null &&
      runtimeReady.value &&
      !diagnosisExporting.value &&
      traditionalSaveDialogMode.value == null,
  );
  const gameInteractionsBlocked = computed(
    () =>
      diagnosisExporting.value ||
      projectFileExporting.value ||
      projectReloadDialogMode.value != null ||
      traditionalSaveDialogMode.value != null,
  );
  const projectFileExportProgressLabel = computed(() =>
    projectFileExportProgress.value
      ? formatProjectProgress(projectFileExportProgress.value)
      : "正在准备全量项目文件…",
  );
  const projectFileExportProgressValue = computed(() => {
    const progress = projectFileExportProgress.value;
    if (!progress || progress.total <= 0) return undefined;
    return Math.min(100, Math.round((progress.completed * 100) / progress.total));
  });
  const diagnosisProgressLabel = computed(() =>
    diagnosisProgress.value
      ? formatDiagnosisProgress(diagnosisProgress.value)
      : "正在准备诊断信息…",
  );
  const diagnosisProgressValue = computed(() => {
    const progress = diagnosisProgress.value;
    return progress ? diagnosisProgressPercentage(progress) : undefined;
  });
  const canOpenProject = computed(
    () =>
      !projectSelecting.value &&
      !projectLoading.value &&
      !diagnosisExporting.value &&
      !projectFileExporting.value,
  );
  const projectLoadProgressLabel = computed(() => {
    if (!projectLoading.value) return "";
    const label = projectProgress.value
      ? formatProjectProgress(projectProgress.value)
      : baseStatus.value;
    return projectLoadElapsedSeconds.value >= 1
      ? `${label} · 已等待 ${projectLoadElapsedSeconds.value} 秒`
      : label;
  });
  const projectLoadProgressValue = computed(() => {
    const progress = projectProgress.value;
    if (!projectLoading.value || !progress || progress.total <= 0) return undefined;
    return Math.min(100, Math.round((progress.completed * 100) / progress.total));
  });
  const canStepDebug = computed(() => {
    const fiberId = selectedDebugFiber(debugStop.value);
    return (
      singleStepEnabled.value &&
      debugStopToken(debugStop.value) != null &&
      fiberId != null &&
      debugFibers.value.some((fiber) => fiber.fiber_id === fiberId && fiber.state === "runnable")
    );
  });
  const promptPlaceholder = computed(() => {
    if (diagnosisExporting.value) return "诊断信息导出中……";
    const source = singleStepEnabled.value ? debugStop.value?.source : undefined;
    if (source?.relative_path != null && source?.line != null)
      return `单步暂停：${source.relative_path}:${Number(source.line) + 1}（F10 继续）`;
    return canInteract.value ? "输入内容；Enter 提交" : "等待 Runtime…";
  });
  const runtimeStoreActions = {} as RuntimeStoreActions;

  function requestNextChunk(): Promise<void> {
    return runtimeStoreActions.requestNextChunk();
  }
  async function handleBatch(batch: PumpBatch): Promise<void> {
    return runtimeStoreActions.handleBatch(batch);
  }
  function currentPresentation(): PresentationState {
    return runtimeStoreActions.currentPresentation();
  }
  function resetViewportProjectionBarriers(): void {
    return runtimeStoreActions.resetViewportProjectionBarriers();
  }
  async function advanceTimedWait(): Promise<void> {
    return runtimeStoreActions.advanceTimedWait();
  }
  async function restart(): Promise<void> {
    return runtimeStoreActions.restart();
  }
  async function startDiagnosisStateExport(kind: DiagnosisStateExportKind): Promise<void> {
    return runtimeStoreActions.startDiagnosisStateExport(kind);
  }
  function recordTestAudioPlayback(event: "started" | "ended", resourceId: string): void {
    return runtimeStoreActions.recordTestAudioPlayback(event, resourceId);
  }
  async function refreshCompiledCacheAfterConfigurationUpdate(): Promise<void> {
    return runtimeStoreActions.refreshCompiledCacheAfterConfigurationUpdate();
  }
  async function requestCompiledCacheExport(activeExport: ExportState): Promise<void> {
    return runtimeStoreActions.requestCompiledCacheExport(activeExport);
  }
  async function finishProjectFileExport(
    outcome: "success" | "cancelled" | "failed",
    message?: string,
    cancelRuntime = outcome !== "success",
  ): Promise<void> {
    return runtimeStoreActions.finishProjectFileExport(outcome, message, cancelRuntime);
  }
  async function finishExportTransfer(completed = exportState): Promise<void> {
    return runtimeStoreActions.finishExportTransfer(completed);
  }
  async function failDiagnosisExport(activeExport: ExportState, message: string): Promise<void> {
    return runtimeStoreActions.failDiagnosisExport(activeExport, message);
  }
  async function applyEffectiveClientConfiguration(): Promise<void> {
    return runtimeStoreActions.applyEffectiveClientConfiguration();
  }
  async function signalMessageSkip(): Promise<void> {
    return runtimeStoreActions.signalMessageSkip();
  }
  async function send(
    message: RuntimeMessage,
    correlationId?: ServiceInteger,
  ): Promise<number | bigint> {
    return runtimeStoreActions.send(message, correlationId);
  }
  function log(
    level: LogEntry["level"],
    message: string,
    authoritative = false,
    notificationPolicy: LogNotificationPolicy = "all",
  ): void {
    return runtimeStoreActions.log(level, message, authoritative, notificationPolicy);
  }
  function finishProjectLoad(): void {
    return runtimeStoreActions.finishProjectLoad();
  }
  function handleProjectProgress(value: ProjectProgress): void {
    return runtimeStoreActions.handleProjectProgress(value);
  }

  const runtimeStoreActionContext = {
    audio,
    baseStatus,
    get batchMediaDirty() {
      return batchMediaDirty;
    },
    set batchMediaDirty(value) {
      batchMediaDirty = value;
    },
    bridge,
    canExportDiagnosis,
    canInteract,
    canManageTraditionalSaves,
    canOpenProject,
    canvasPixels,
    compiledCacheExport,
    configurationEntries,
    coreVersion,
    debugConsoleOpen,
    debugEnabled,
    debugGrant,
    debugRequests,
    debugStop,
    debugVariables,
    debugVariablesLoading,
    get deferredViewportProjection() {
      return deferredViewportProjection;
    },
    set deferredViewportProjection(value) {
      deferredViewportProjection = value;
    },
    get deviceEventSequence() {
      return deviceEventSequence;
    },
    set deviceEventSequence(value) {
      deviceEventSequence = value;
    },
    get deviceGeneration() {
      return deviceGeneration;
    },
    set deviceGeneration(value) {
      deviceGeneration = value;
    },
    get devicePumpTimeAdvancePending() {
      return devicePumpTimeAdvancePending;
    },
    set devicePumpTimeAdvancePending(value) {
      devicePumpTimeAdvancePending = value;
    },
    get deviceSubmissionFailure() {
      return deviceSubmissionFailure;
    },
    set deviceSubmissionFailure(value) {
      deviceSubmissionFailure = value;
    },
    get deviceSubmissionTail() {
      return deviceSubmissionTail;
    },
    set deviceSubmissionTail(value) {
      deviceSubmissionTail = value;
    },
    get deviceSynchronizationPending() {
      return deviceSynchronizationPending;
    },
    set deviceSynchronizationPending(value) {
      deviceSynchronizationPending = value;
    },
    diagnosisExporting,
    diagnosisResult,
    diagnosticNotificationPolicy,
    effectivePreferences,
    get exportState() {
      return exportState;
    },
    set exportState(value) {
      exportState = value;
    },
    exportTransfer,
    fault,
    faultActionBusy,
    FULL_PROJECT_MANIFEST_CHUNK_BYTES,
    get fullManifestImport() {
      return fullManifestImport;
    },
    set fullManifestImport(value) {
      fullManifestImport = value;
    },
    fullManifestImports,
    gameInformation,
    gameInteractionsBlocked,
    gameProgressLossConfirmation,
    heldKeys,
    heldMouseButtons,
    heldMousePositions,
    htmlMeasurements,
    imagePixels,
    get initialization() {
      return initialization;
    },
    set initialization(value) {
      initialization = value;
    },
    get initialized() {
      return initialized;
    },
    set initialized(value) {
      initialized = value;
    },
    inputUndo,
    KEYBOARD_DEVICE_CODES,
    keyToggleStates,
    get lifecycleGeneration() {
      return lifecycleGeneration;
    },
    set lifecycleGeneration(value) {
      lifecycleGeneration = value;
    },
    logs,
    openProjectConfirmationOpen,
    pendingGameInput,
    pendingInputUndo,
    pendingProjectionMessages,
    get pendingProjectSelection() {
      return pendingProjectSelection;
    },
    set pendingProjectSelection(value) {
      pendingProjectSelection = value;
    },
    get pendingReturnToTitleMessageId() {
      return pendingReturnToTitleMessageId;
    },
    set pendingReturnToTitleMessageId(value) {
      pendingReturnToTitleMessageId = value;
    },
    get pendingStart() {
      return pendingStart;
    },
    set pendingStart(value) {
      pendingStart = value;
    },
    phase,
    pointerObservation,
    preferences,
    preferencesOpen,
    presentation,
    presentationProjection,
    projectConfiguration,
    projectFileExporting,
    projectFileExportState,
    projectFontFamilies,
    projectionObservationBarriers,
    projectLoad,
    projectLoading,
    projectOpen,
    projectPreferences,
    projectPreferencesWritable,
    projectReload,
    projectResourceGeneration,
    projectSelecting,
    projectSettingsOpen,
    projectSource,
    prompt,
    readTestTypedWatches,
    replaceFullWidthSpaces,
    requestSystemFonts,
    retiredFullManifestCommandIds,
    get runtimeBatchSequence() {
      return runtimeBatchSequence;
    },
    set runtimeBatchSequence(value) {
      runtimeBatchSequence = value;
    },
    runtimeClientPreferences,
    runtimeConfiguration,
    runtimeDebug,
    runtimeDiagnosis,
    runtimeEpoch,
    runtimeImport,
    runtimeInput,
    runtimeLogs,
    get runtimeManifestSparse() {
      return runtimeManifestSparse;
    },
    set runtimeManifestSparse(value) {
      runtimeManifestSparse = value;
    },
    runtimeProjectSettings,
    runtimePump,
    runtimeReady,
    get runtimeSessionObservationGeneration() {
      return runtimeSessionObservationGeneration;
    },
    set runtimeSessionObservationGeneration(value) {
      runtimeSessionObservationGeneration = value;
    },
    runtimeStatus,
    runtimeViewport,
    serviceRequests,
    get sessionAudioAvailable() {
      return sessionAudioAvailable;
    },
    set sessionAudioAvailable(value) {
      sessionAudioAvailable = value;
    },
    get sessionPreparation() {
      return sessionPreparation;
    },
    set sessionPreparation(value) {
      sessionPreparation = value;
    },
    singleStepEnabled,
    sqlProvider,
    stackOpen,
    startupTelemetry,
    startupTelemetryState,
    systemFonts,
    testAudioPlayback,
    testEnvironment,
    testEvidence,
    traditionalSaves,
    variablesOpen,
    get viewportLayoutIdentity() {
      return viewportLayoutIdentity;
    },
    set viewportLayoutIdentity(value) {
      viewportLayoutIdentity = value;
    },
    get viewportLayoutIdentityAtProjection() {
      return viewportLayoutIdentityAtProjection;
    },
    set viewportLayoutIdentityAtProjection(value) {
      viewportLayoutIdentityAtProjection = value;
    },
    get viewportProjectionBarrierGeneration() {
      return viewportProjectionBarrierGeneration;
    },
    set viewportProjectionBarrierGeneration(value) {
      viewportProjectionBarrierGeneration = value;
    },
    get viewportProjectionFlushAfterBatch() {
      return viewportProjectionFlushAfterBatch;
    },
    set viewportProjectionFlushAfterBatch(value) {
      viewportProjectionFlushAfterBatch = value;
    },
  };
  Object.assign(runtimeStoreActions, {
    ...createRuntimeStoreActions1(runtimeStoreActionContext),
    ...createRuntimeStoreActions2(runtimeStoreActionContext),
    ...createRuntimeStoreActions3(runtimeStoreActionContext),
    ...createRuntimeStoreActions4(runtimeStoreActionContext),
    ...createRuntimeStoreActions5(runtimeStoreActionContext),
    ...createRuntimeStoreActions6(runtimeStoreActionContext),
  });
  const runtimeStoreViewContext = {
    configurationReadOnly,
    configurationSessionOnly,
    configurationRestartPending,
    viewportMeasurement,
    menuMode,
    useMouse,
    scrollHeight,
    gameTextStyle,
    gameLineHeightPx,
    availableFontFamilies,
    fontAccessStatus,
    fontAccessError,
    status,
    projectLoadProgressLabel,
    projectLoadProgressValue,
    projectReloadDialogMode,
    projectReloadTargetOptions,
    projectReloadDialogBusy,
    projectReloadDialogError,
    faultMessage,
    settingsBusy,
    projectSettingsError,
    preferencesError,
    logsOpen,
    debugOutput,
    debugFibers,
    debugFrames,
    debugVariableValues,
    diagnosisProgress,
    diagnosisProgressLabel,
    diagnosisProgressValue,
    projectFileExportProgressLabel,
    projectFileExportProgressValue,
    logNotifications,
    traditionalSaveDialogMode,
    traditionalSaveSlots,
    traditionalSaveImportName,
    traditionalSaveTransferBusy,
    traditionalSaveTransferError,
    traditionalSaveOverwriteSlot,
    fullProjectExportSupported,
    canExportProjectFile,
    canStepDebug,
    promptPlaceholder,
  };
  return createRuntimeStoreProjection(
    Object.assign(runtimeStoreActionContext, runtimeStoreActions, runtimeStoreViewContext),
  );
});
