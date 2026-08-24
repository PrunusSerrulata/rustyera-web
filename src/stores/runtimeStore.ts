import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { blake3 } from "@noble/hashes/blake3.js";

import { AudioEngine } from "@/core/audio";
import { diagnosisProjectName, diagnosisProjectTitle } from "@/core/diagnosis";
import {
  debugStopToken,
  debugVariableKey,
  formatDebugValue,
  isStaleDebugGrantError,
  sameDebugGrant,
  selectedDebugFiber,
  sourceLineStepCommand,
} from "@/core/debug";
import { preferredRuntimeLocales, resolveGameTextStyle } from "@/core/gameText";
import { suppressedMirroredLogNotificationIndexes } from "@/core/log";
import { menuVisibilityMode } from "@/core/menuVisibility";
import { isMessageContinuationWait, messageWaitIntent } from "@/core/messageSkip";
import {
  concatenateChunks,
  diagnosisProgressPercentage,
  formatDiagnostic,
  formatDiagnosisLogs,
  formatDiagnosisProgress,
  formatProjectProgress,
  isRecoverableStaleDebugLog,
  projectGameInformation,
  safeNumber,
  snapshotFileName,
} from "@/core/runtimeSupport";
import { formatRuntimeFault } from "@/core/runtimeFault";
import { hasEnabledButton, presentationInteractionEnabled } from "@/core/presentation";
import {
  defaultPreferences,
  defaultProjectPreferences,
  type InteractionToken,
  type Preferences,
  type ProjectPreferences,
  type ProjectConfigurationChange,
  type ProjectGameInformation,
  type ProjectFontLoadResult,
  type ProjectProgress,
  type ProjectReloadScope,
  type PumpBatch,
  type RuntimeMessage,
  type SessionOptions,
} from "@/core/types";
import { platformBridge } from "@/platform";
import { currentGameViewportMeasurement } from "@/platform/viewportMeasurement";
import { RuntimePumpCoordinator } from "@/stores/runtimePump";
import { RuntimePresentationProjection } from "@/stores/runtimePresentation";
import { RuntimeConfigurationState } from "@/stores/runtimeConfiguration";
import { RuntimeCompiledCacheExportState } from "@/stores/runtimeCompiledCache";
import { RuntimeExportTransferState } from "@/stores/runtimeExportTransfer";
import { normalizeProjectProgress, RuntimeProjectLoadState } from "@/stores/runtimeProjectLoad";
import { RuntimeProjectReloadState } from "@/stores/runtimeProjectReload";
import { RuntimeProjectFileExportState } from "@/stores/runtimeProjectFileExport";
import { classifyRuntimeRejection, isNonNotifiedInputWarning } from "@/stores/runtimeRejections";
import { RuntimeLogState } from "@/stores/runtimeLogs";
import { RuntimeInputState } from "@/stores/runtimeInput";
import { RuntimeImportState } from "@/stores/runtimeImport";
import { RuntimeDebugRequestState } from "@/stores/runtimeDebugRequests";
import { RuntimeDebugState } from "@/stores/runtimeDebugState";
import { RuntimeDiagnosisState } from "@/stores/runtimeDiagnosis";
import { handleRuntimeService } from "@/stores/runtimeServices";
import { RuntimeProjectSettingsState } from "@/stores/runtimeProjectSettings";
import { RuntimeClientPreferencesState } from "@/stores/runtimeClientPreferences";
import { RuntimeStatusState } from "@/stores/runtimeStatus";
import { RuntimeStartupTelemetryState } from "@/stores/runtimeStartupTelemetry";
import { RuntimeTestEnvironment } from "@/stores/runtimeTestEnvironment";
import { RuntimeTraditionalSaveState } from "@/stores/runtimeTraditionalSaves";
import { RuntimeViewportState } from "@/stores/runtimeViewport";
import { useSystemFontAccess } from "@/stores/systemFontAccess";
import { transportValue } from "@/stores/runtimeTransport";

import {
  sessionFontFallback,
  diagnosisStateExportRequest,
  diagnosisProgressStage,
  isFullProjectExport,
  DEBUG_VARIABLE_PAGE_LIMIT,
  DEBUG_VARIABLE_MAX_PAGES,
  TIME_ADVANCE_INTERVAL_NS,
  MAXIMUM_LOG_ENTRIES,
  PROJECT_STARTING_STATUS,
  GAME_RUNNING_STATUS,
} from "@/stores/runtimeState";
import type {
  LogEntry,
  LogNotificationPolicy,
  RuntimeInputIntent,
  ExportState,
  DiagnosisStateExportKind,
  FullProjectExportState,
  FullManifestImportTransaction,
  FullProjectRequestSubmission,
  RuntimeStartKind,
  RuntimeTestConfiguration,
} from "@/stores/runtimeState";

const FULL_PROJECT_MANIFEST_CHUNK_BYTES = 4 * 1024 * 1024;

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
  const runtimeLogs = new RuntimeLogState(MAXIMUM_LOG_ENTRIES);
  const testEnvironment = new RuntimeTestEnvironment();
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
  const testAudioPlayback = new Map<string, { starts: number; active: number }>();
  const audio = new AudioEngine(
    bridge,
    preferences.value,
    (error) => log("warning", `音频播放失败：${String(error)}`),
    import.meta.env.VITE_RUSTYERA_TEST === "1" ? recordTestAudioPlayback : undefined,
  );
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
    failProjectFile: (message) => finishProjectFileExport("failed", message),
    enqueueCompiledCacheWrite: (activeExport, bytes, reset, complete) =>
      compiledCacheExport.enqueueHostWrite(activeExport, bytes, reset, complete),
    continueCompiledCache: (activeExport, complete) =>
      compiledCacheExport.continue(activeExport, complete),
    failCompiledCache: (activeExport, error) => compiledCacheExport.fail(activeExport, error),
    finishExport: finishExportTransfer,
    logWarning: (message) => log("warning", message),
  });
  type PendingRuntimeStart =
    | { type: "new_game"; seed?: number | bigint }
    | { type: Exclude<RuntimeStartKind, "new_game">; bytes: Uint8Array };
  let pendingStart: PendingRuntimeStart = { type: "new_game" };
  let runtimeManifestSparse = false;
  let batchMediaDirty = false;
  const debugRequests = new RuntimeDebugRequestState();
  const runtimeInput = new RuntimeInputState({
    presentation: currentPresentation,
    mutableInteractions: () => presentationProjection.mutableInteractions(),
    send,
    sampleMonotonic: () => testEnvironment.sampleMonotonic(),
    phase: () => phase.value,
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

  function resetTransientStatuses(): void {
    runtimeStatus.reset();
    runtimeProjectSettings.resetStatus();
  }

  async function initialize(): Promise<void> {
    // Host end-to-end tests must not inherit a developer's persisted font/image
    // preferences. Those values change Emuera geometry and made identical test
    // binaries report different image positions on different machines.
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      preferences.value = {
        ...defaultPreferences(),
        trustProjectFileMetadata:
          bridge.kind === "browser" && import.meta.env.VITE_RUSTYERA_TEST_TRUST_METADATA === "1",
      };
      if (preferences.value.trustProjectFileMetadata) {
        preferences.value = await bridge.savePreferences(preferences.value);
      }
    } else {
      preferences.value = await bridge.loadPreferences();
    }
    audio.setPreferences(preferences.value);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", sendClientState);
    window.addEventListener("focus", sendClientState);
    window.addEventListener("blur", sendClientState);
    window.addEventListener("resize", () => void projectViewport());
    if (bridge.prewarmRuntimeOnInitialize) {
      void ensureSession().catch((error) =>
        log("warning", `Runtime 后台初始化失败，将在打开项目时重试：${String(error)}`),
      );
    }
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
          (normalizedSeed < 0n || normalizedSeed > 0xffff_ffff_ffff_ffffn)) ||
        normalizedSeed == null
      )
        throw new Error("new_game 测试必须提供十进制 u64 seed");
    } else if (!start.bytes?.length) {
      throw new Error(`${start.type} 测试必须提供状态文件`);
    }
    pendingStart =
      start.type === "new_game"
        ? { type: "new_game", seed: normalizedSeed as number | bigint }
        : { type: start.type, bytes: new Uint8Array(start.bytes!) };
    testEnvironment.configure(configuration.clock, start.seed, configuration.monotonicStartNs);
  }

  async function ensureSession(): Promise<void> {
    if (runtimePump.ready) return;
    if (sessionPreparation) return sessionPreparation;
    const attempt = (async () => {
      if (bridge.kind === "tauri") await requestSystemFonts();
      const batch = await bridge.createSession(sessionOptions());
      runtimePump.setReady(true);
      try {
        await handleBatch(batch);
      } catch (error) {
        runtimePump.setReady(false);
        throw error;
      }
      schedulePump(0);
    })();
    sessionPreparation = attempt;
    try {
      await attempt;
    } finally {
      if (sessionPreparation === attempt) sessionPreparation = undefined;
    }
  }

  function openPreferencesFromUser(): void {
    preferencesOpen.value = true;
    void requestSystemFonts();
  }

  function openProjectSettingsFromUser(): void {
    projectSettingsOpen.value = true;
    void requestSystemFonts();
  }

  function openPreferencesFromRuntime(): void {
    projectSettingsOpen.value = true;
    if (bridge.kind === "tauri") void requestSystemFonts();
  }

  function sessionOptions(): SessionOptions {
    return {
      clientName: bridge.kind === "tauri" ? "rustyera-vue-tauri" : "rustyera-vue-wasm",
      // This fixed session capability is sampled when the runtime session is created. Browser
      // fonts granted later remain UI choices until the next session negotiates CHKFONT again.
      // Project fonts are a CSS/settings capability. CHKFONT remains the fixed system-font
      // capability sampled when the runtime session is created.
      availableFonts: [...(systemFonts.value.length > 0 ? systemFonts.value : sessionFontFallback)],
      preferredLocales: [...preferredRuntimeLocales(navigator.languages)],
      audioAvailable: true,
      debugScopeMask: 1023,
      maximumEnvelopeBytes: 512 * 1024 * 1024,
      configurationProfile: bridge.kind,
    };
  }

  function refreshProjectFontFamilies(projectFonts?: ProjectFontLoadResult): void {
    projectFonts ??= { fonts: [], errors: [] };
    projectFontFamilies.value = projectFonts.fonts;
    for (const error of projectFonts.errors) log("warning", `无法加载项目字体：${error}`);
  }

  async function openProject(): Promise<void> {
    await selectProject("directory");
  }

  async function openProjectFile(): Promise<void> {
    await selectProject("file");
  }

  async function selectProject(selection: "directory" | "file"): Promise<void> {
    if (!canOpenProject.value) return;
    pendingProjectSelection = selection;
    if (projectOpen.value) {
      openProjectConfirmationOpen.value = true;
      return;
    }
    await loadProject(false, selection);
  }

  function cancelOpenProject(): void {
    openProjectConfirmationOpen.value = false;
  }

  async function confirmOpenProject(): Promise<void> {
    if (!openProjectConfirmationOpen.value || !canOpenProject.value) return;
    openProjectConfirmationOpen.value = false;
    await loadProject(true, pendingProjectSelection);
  }

  async function loadProject(
    replaceCurrent: boolean,
    selection: "directory" | "file",
  ): Promise<void> {
    projectSelecting.value = true;
    projectLoad.acceptProgress();
    unlockAudioFromUserGesture();
    let currentSessionReplaced = false;
    let selectionSubmitted = false;
    let runtimeProjectSubmissionLocked = false;
    try {
      const prepareAfterSelection = async () => {
        if (replaceCurrent) {
          currentSessionReplaced = true;
          await recreateSessionForProjectSelection();
        } else {
          const waitingForRuntime = !runtimePump.ready;
          if (waitingForRuntime) beginProjectLoad("正在初始化 Runtime…");
          try {
            await ensureSession();
          } finally {
            if (waitingForRuntime) {
              finishProjectLoad();
              projectLoad.acceptProgress();
            }
          }
        }
        runtimePump.setTransitioning(true);
        runtimeProjectSubmissionLocked = true;
        runtimePump.clearTimer();
        await runtimePump.waitUntilIdle();
        baseStatus.value = "正在读取项目…";
      };
      const onSubmitted = (submittedAtMs: number) => {
        selectionSubmitted = true;
        startupTelemetryState.begin(submittedAtMs, selection, bridge.kind);
      };
      const metrics = await (selection === "file"
        ? bridge.openProjectFile(onSubmitted, prepareAfterSelection)
        : bridge.openProject(onSubmitted, prepareAfterSelection));
      if (!metrics) {
        finishProjectLoad();
        baseStatus.value = "已取消打开项目";
        return;
      }
      refreshProjectPreferences();
      runtimeConfiguration.refreshWritable();
      await runtimeConfiguration.persistGenerated();
      refreshProjectFontFamilies(metrics.projectFonts);
      projectOpen.value = true;
      projectSource.value = selection;
      if (!startupTelemetry.value)
        startupTelemetryState.begin(metrics.submittedAtMs, selection, bridge.kind);
      startupTelemetryState.applyBridgeMetrics(metrics, bridge.kind);
      log(
        "info",
        `项目读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress(metrics.cacheImported);
      schedulePump(0);
    } catch (error) {
      if (runtimeProjectSubmissionLocked) {
        try {
          await recreateSessionForProjectSelection();
        } catch (resetError) {
          log("warning", `清理失败的项目提交时重建 Runtime 失败：${String(resetError)}`);
        }
      }
      if (selectionSubmitted) startupTelemetryState.fail(error);
      if (currentSessionReplaced) projectOpen.value = false;
      finishProjectLoad();
      baseStatus.value = String(error);
      log("error", baseStatus.value);
    } finally {
      projectSelecting.value = false;
      if (runtimeProjectSubmissionLocked) {
        runtimePump.setTransitioning(false);
        schedulePump(0);
      }
    }
  }

  async function recreateSessionForProjectSelection(): Promise<void> {
    runtimePump.setTransitioning(true);
    try {
      if (fullManifestImport) await cleanupFullManifestImport(true);
      clearSessionTimers();
      resetSessionState(true);
      baseStatus.value = "正在创建新的 Runtime session…";
      unlockAudioFromUserGesture();
      await audio
        .synchronize([])
        .catch((error) => log("warning", `更换项目时停止音频失败：${String(error)}`));
      await runtimePump.waitUntilIdle();
      await compiledCacheExport.cancel();
      resetSessionState();
      const batch = await bridge.createSession(sessionOptions());
      runtimePump.setReady(true);
      await handleBatch(batch);
    } catch (error) {
      runtimePump.setTransitioning(false);
      throw error;
    }
  }

  function unlockAudioFromUserGesture(): void {
    // Safari may keep AudioContext.resume() pending until it recognizes a trusted activation.
    // Start the request inside the user gesture, but do not make project I/O depend on audio.
    void audio.unlock().catch((error) => log("warning", `音频解锁失败：${String(error)}`));
  }

  function clearSessionTimers(): void {
    runtimePump.clearTimer();
    compiledCacheExport.clearTimer();
  }

  function schedulePump(delay = 16): void {
    runtimePump.schedule(delay);
  }

  function requestNextChunk(): Promise<void> {
    return exportTransfer.requestChunk();
  }

  async function handleBatch(batch: PumpBatch): Promise<void> {
    startupTelemetryState.recordWasmMemory(batch.memoryBytes);
    batchMediaDirty = false;
    const suppressedLogNotificationIndexes = suppressedMirroredLogNotificationIndexes(batch.events);
    for (let index = 0; index < batch.events.length;) {
      const event = batch.events[index];
      if (event.epoch != null) runtimeEpoch.value = event.epoch;
      if (event.channel === "runtime" && event.message.type === "service_request") {
        const requests = [];
        while (index < batch.events.length) {
          const candidate = batch.events[index];
          if (candidate.channel !== "runtime" || candidate.message.type !== "service_request")
            break;
          requests.push(candidate);
          index += 1;
        }
        for (let offset = 0; offset < requests.length; offset += 8) {
          await Promise.all(
            requests
              .slice(offset, offset + 8)
              .map((request) =>
                handleService(
                  (request.message as RuntimeMessage).value,
                  safeNumber(request.correlationId),
                ),
              ),
          );
        }
        continue;
      }
      if (event.channel === "runtime")
        await handleRuntime(
          event.message as RuntimeMessage,
          event.correlationId,
          suppressedLogNotificationIndexes.has(index),
          event.dataBytes,
        );
      else await handleDebug(event.message as any, event.correlationId);
      index += 1;
    }
    if (presentationProjection.shouldPublish(batch.state))
      batchMediaDirty = presentationProjection.publish() || batchMediaDirty;
    if (batchMediaDirty) await synchronizeMedia();
    if (debugRequests.grantRefreshNeeded) {
      debugRequests.grantRefreshNeeded = false;
      await requestDebugGrant();
    } else if (debugRequests.pauseWanted) {
      await requestPendingDebugPause();
    }
    await settlePendingGameInput();
  }

  async function handleRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
    suppressNotification = false,
    dataBytes?: Uint8Array,
  ): Promise<void> {
    const value = message.value;
    switch (message.type) {
      case "server_hello":
        coreVersion.value = `${value.implementation_version} (${import.meta.env.VITE_RUSTYERA_CORE_REVISION})`;
        if (!runtimeConfiguration.acceptProfile(value.configuration_profile))
          log("error", "Runtime 返回的设置宿主类别与当前客户端不一致，项目设置已停用");
        baseStatus.value = "Runtime 已就绪";
        break;
      case "project_load_report": {
        if (value.success) gameInformation.value = projectGameInformation(value.game_information);
        if (projectReload.matches(correlationId)) {
          await handleProjectReloadReport(value);
          break;
        }
        startupTelemetryState.finishProgressStage();
        if (startupTelemetry.value)
          startupTelemetry.value.milestones.runtimeValidationReportedMs =
            startupTelemetryState.elapsedMs();
        const diagnostics = value.diagnostics ?? [];
        const runtimeAcceptedCompiledCache = diagnostics.some(
          (diagnostic: any) => diagnostic.code === "runtime.compiled_cache_hit",
        );
        if (startupTelemetry.value && runtimeAcceptedCompiledCache)
          startupTelemetry.value.cacheHit = true;
        runtimeManifestSparse = value.success && runtimeAcceptedCompiledCache;
        appendLogEntries(
          diagnostics.map((diagnostic: any) => ({
            timestamp: new Date(),
            level: diagnostic.level ?? "info",
            message: formatDiagnostic(diagnostic),
            authoritative: true,
          })),
          diagnostics.map((diagnostic: any) =>
            diagnosticNotificationPolicy(diagnostic, "errors_only"),
          ),
        );
        runtimeConfiguration.refreshWritable();
        runtimeConfiguration.update(value.configuration);
        await runtimeConfiguration.persistGenerated();
        if (value.success) {
          refreshProjectPreferences();
          void runtimeClientPreferences
            .apply()
            .then(() => continueLoadedProject(runtimeAcceptedCompiledCache))
            .catch((error) => {
              pendingStart = { type: "new_game" };
              const message = `客户端偏好初始化失败：${String(error)}`;
              startupTelemetryState.fail(message);
              finishProjectLoad();
              baseStatus.value = message;
              log("error", message);
            });
        } else if (value.payload_required) {
          showProjectLoadTransition("项目缓存未命中，正在读取项目源码…");
          runtimeManifestSparse = false;
          if (startupTelemetry.value) {
            startupTelemetry.value.scenario = "cold";
            startupTelemetry.value.cacheHit = false;
          }
          await bridge.submitProjectSource();
          continueProjectBuildProgress();
          schedulePump(0);
        } else {
          pendingStart = { type: "new_game" };
          startupTelemetryState.fail("项目加载失败");
          finishProjectLoad();
          baseStatus.value = "项目加载失败，请查看日志";
        }
        break;
      }
      case "state_changed":
        phase.value = value.phase;
        if (value.phase === "faulted" || value.phase === "stopped") {
          gameProgressLossConfirmation.value = null;
          runtimeImport.reset();
        }
        if (
          startupTelemetry.value?.milestones.startSubmittedMs != null &&
          startupTelemetry.value.outcome === "loading" &&
          startupTelemetry.value.milestones.firstGamePhaseMs == null &&
          ["running", "waiting_input", "waiting_external"].includes(value.phase)
        ) {
          startupTelemetry.value.milestones.firstGamePhaseMs = startupTelemetryState.elapsedMs();
          startupTelemetry.value.outcome = "success";
          startupTelemetryState.startMessageId = undefined;
          // Host-side work such as font registration may finish after Runtime has already
          // entered the game. The first game phase is the authoritative load boundary.
          finishProjectLoad();
          baseStatus.value = GAME_RUNNING_STATUS;
        }
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        if (value.phase === "faulted" || value.phase === "stopped") {
          const startupWasLoading = startupTelemetry.value?.outcome === "loading";
          if (startupWasLoading) pendingStart = { type: "new_game" };
          startupTelemetryState.fail(`Runtime entered ${value.phase} during startup`);
          if (startupWasLoading) finishProjectLoad();
        }
        if (value.phase !== "debug_paused") debugStop.value = null;
        break;
      case "presentation_snapshot":
        batchMediaDirty = presentationProjection.projectSnapshot(value) || batchMediaDirty;
        break;
      case "presentation_delta":
        try {
          batchMediaDirty = presentationProjection.projectDelta(value) || batchMediaDirty;
        } catch (error) {
          presentationProjection.discard();
          log("warning", String(error));
          await send({ type: "resynchronize", value: { after_sequence: null } });
        }
        break;
      case "runtime_resynchronized":
        phase.value = value.phase;
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        batchMediaDirty =
          presentationProjection.projectSnapshot(value.presentation) || batchMediaDirty;
        applyInputUndo(value.input_undo ?? null);
        runtimeConfiguration.update(value.configuration);
        await runtimeConfiguration.persistGenerated();
        break;
      case "configuration_update_prepared":
        await runtimeConfiguration.handlePrepared(value, correlationId);
        break;
      case "configuration_update_committed":
        await runtimeConfiguration.handleCommitted(value, correlationId);
        break;
      case "client_preferences_applied":
        if (!(await runtimeClientPreferences.handleApplied(value, correlationId)))
          log("warning", "忽略了非预期的客户端偏好响应");
        break;
      case "wait_changed":
        if (value.type === "opened" || value.type === "updated") {
          runtimeInput.updateWait(value.value);
          currentPresentation().inputWait = value.value;
          presentationProjection.markStagedReady();
        } else if (value.type === "closed") {
          currentPresentation().inputWait = null;
          runtimeInput.closeWait();
        }
        break;
      case "input_undo_state_changed":
        applyInputUndo(value);
        break;
      case "effect_batch":
        await handleEffects(value.effects ?? []);
        break;
      case "storage_request": {
        const response = await bridge.handleStorage(value);
        await send({ type: "storage_response", value: response }, safeNumber(correlationId));
        break;
      }
      case "service_request":
        await handleService(value, safeNumber(correlationId));
        break;
      case "state_export_ready":
        await exportTransfer.handleReady(value, correlationId);
        break;
      case "state_export_chunk":
        await exportTransfer.handleChunk(value, dataBytes);
        break;
      case "state_import_accepted":
        if (
          [...fullManifestImports].some(
            (pending) => pending.beginMessageId === String(correlationId),
          )
        ) {
          try {
            await acceptFullManifestImport(value, correlationId);
          } catch (error) {
            const pending = [...fullManifestImports].find(
              (candidate) => candidate.beginMessageId === String(correlationId),
            );
            const active = pending?.activeExport;
            await cleanupFullManifestImport(true, pending);
            const message = `完整项目 manifest 传输失败：${String(error)}`;
            if (active?.kind === "diagnosis_project") await failDiagnosisExport(active, message);
            else await finishProjectFileExport("failed", message, false);
          }
        } else await runtimeImport.accept(value);
        break;
      case "state_import_ready":
        if (!(await finishFullManifestImport(value, correlationId)))
          await runtimeImport.ready(value);
        break;
      case "fault": {
        if (fullManifestImport) await cleanupFullManifestImport(false);
        runtimeImport.reset();
        gameProgressLossConfirmation.value = null;
        const startupWasLoading = startupTelemetry.value?.outcome === "loading";
        if (startupWasLoading) pendingStart = { type: "new_game" };
        startupTelemetryState.fail(value.message ?? "Runtime fault");
        if (startupWasLoading) finishProjectLoad();
        diagnosisResult.value = "";
        fault.value = value;
        log("error", formatRuntimeFault(value), true, "none");
        break;
      }
      case "diagnostic":
        log(
          value.level ?? "info",
          formatDiagnostic(value),
          true,
          diagnosticNotificationPolicy(value, "all"),
        );
        if (
          value.code === "runtime.compiled_cache_ready" &&
          exportState?.kind === "compiled_cache" &&
          !exportState.descriptor
        ) {
          const activeExport = exportState;
          try {
            await requestCompiledCacheExport(activeExport);
          } catch (error) {
            await compiledCacheExport.fail(activeExport, error);
          }
        } else if (
          value.code === "runtime.compiled_cache_failed" &&
          exportState?.kind === "compiled_cache" &&
          !exportState.descriptor
        ) {
          await compiledCacheExport.fail(
            exportState,
            value.message ?? "Runtime cache build failed",
            "none",
          );
        }
        break;
      case "log":
        if (!isRecoverableStaleDebugLog(value.message))
          log(value.level ?? "info", value.message, true, suppressNotification ? "none" : "all");
        break;
      case "command_rejected": {
        const correlation = String(correlationId);
        if (retiredFullManifestCommandIds.delete(correlation)) break;
        const manifestImport = [...fullManifestImports].find((pending) =>
          pending.commandMessageIds.has(correlation),
        );
        if (manifestImport) {
          if (!manifestImport.cancelled) {
            const active = manifestImport.activeExport;
            await cleanupFullManifestImport(true, manifestImport);
            const message = `完整项目 manifest 导入被 Runtime 拒绝：${value.message ?? "未知原因"}`;
            if (active.kind === "diagnosis_project") await failDiagnosisExport(active, message);
            else await finishProjectFileExport("failed", message, false);
          } else retireFullManifestImport(manifestImport);
          break;
        }
        runtimeImport.reject(correlationId);
        if (
          runtimeClientPreferences.reject(
            correlationId,
            String(value.message ?? "Runtime 拒绝了客户端偏好"),
          )
        )
          break;
        if (
          startupTelemetry.value?.outcome === "loading" &&
          String(correlationId) === startupTelemetryState.startMessageId
        ) {
          const message = String(value.message ?? "Runtime rejected startup");
          startupTelemetryState.fail(message);
          finishProjectLoad();
          baseStatus.value = `项目启动失败：${message}`;
        }
        const reloadRejected = projectReload.matches(correlationId);
        if (reloadRejected) {
          const message = String(value.message ?? "Runtime 拒绝了热重载");
          await projectReload.finalize(false);
          finishProjectLoad();
          baseStatus.value = `重新加载项目失败：${message}`;
          log("error", baseStatus.value, true);
        }
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
          exportState,
          pendingProjectionMessages,
          pendingGameInput.value,
        );
        if (rejectedInput && !willRetryInput) {
          runtimeInput.rejectInput(rejectedInput, willRetryInput);
        }
        runtimeInput.rejectUndo(correlation);
        if (
          suppressInputWarningNotification ||
          (!staleProjection &&
            !willRetryInput &&
            !compiledCachePreparing &&
            !fullProjectPreparing &&
            !earlyFullProjectPreparation &&
            !reloadRejected)
        )
          log(
            "warning",
            formatDiagnostic(value),
            true,
            suppressInputWarningNotification ? "none" : "all",
          );
        runtimeConfiguration.reject(correlationId, value.message ?? "Runtime 拒绝了命令");
        if (fullProjectPreparing && isFullProjectExport(activeExport)) {
          scheduleFullProjectExportRetry(activeExport);
        }
        if (
          exportState?.requestMessageId === String(correlationId) &&
          !fullProjectPreparing &&
          !String(value.message ?? "").includes("compiled project cache preparation started") &&
          !String(value.message ?? "").includes("compiled project cache is still being prepared")
        ) {
          const message = `状态导出被 Runtime 拒绝：${value.message ?? "未知原因"}`;
          if (exportState.kind.startsWith("diagnosis_"))
            await failDiagnosisExport(exportState, message);
          else {
            const projectFileFailed = exportState.kind === "project_file";
            const compiledCacheFailed = exportState.kind === "compiled_cache";
            if (projectFileFailed) {
              await finishProjectFileExport("failed", message);
            } else if (compiledCacheFailed) {
              await compiledCacheExport.fail(exportState, message, "none");
            } else {
              exportState = undefined;
            }
            if (!projectFileFailed && !compiledCacheFailed) baseStatus.value = message;
            if (diagnosisExporting.value) void startDiagnosisStateExport("diagnosis_replay");
          }
        }
        break;
      }
      case "exit_requested":
        if (value.reason === "restart") await restart();
        else await shutdown();
        break;
      case "shutdown_ready":
        if (bridge.kind === "browser") requestBrowserTabClose();
        else await bridge.close();
        break;
    }
  }

  async function handleProjectReloadReport(value: any): Promise<void> {
    if (!projectReload.pending) return;
    const diagnostics = value.diagnostics ?? [];
    appendLogEntries(
      diagnostics.map((diagnostic: any) => ({
        timestamp: new Date(),
        level: diagnostic.level ?? "info",
        message: formatDiagnostic(diagnostic),
        authoritative: true,
      })),
      diagnostics.map((diagnostic: any) => diagnosticNotificationPolicy(diagnostic, "errors_only")),
    );
    const committedFonts = await projectReload.finalize(Boolean(value.success));
    if (!value.success) {
      finishProjectLoad();
      baseStatus.value = "重新加载项目失败，请查看日志";
      log("error", baseStatus.value, true);
      return;
    }
    refreshProjectFontFamilies(committedFonts);
    projectResourceGeneration.value += 1;
    runtimeConfiguration.refreshWritable();
    runtimeConfiguration.update(value.configuration);
    await runtimeConfiguration.persistGenerated();
    if (projectConfiguration.value) {
      try {
        await bridge.applyProjectConfiguration(
          configurationEntries.value,
          runtimeViewport.chrome(currentGameViewportMeasurement()),
        );
      } catch (error) {
        log("warning", `客户端项目配置应用失败：${String(error)}`);
      }
    }
    await settleProjectViewport();
    runtimeManifestSparse = false;
    finishProjectLoad();
    baseStatus.value = GAME_RUNNING_STATUS;
    if (!runtimeManifestSparse) scheduleCompiledCacheExport(1000);
  }

  async function synchronizeMedia(): Promise<void> {
    document.title = presentation.title || "RustyEra";
    try {
      await audio.synchronize(presentation.audio);
    } catch (error) {
      log("warning", `音频播放失败：${String(error)}`);
    }
  }

  function currentPresentation() {
    return presentationProjection.current();
  }

  async function handleEffects(effects: any[]): Promise<void> {
    const outcomes = [];
    for (const effect of effects) {
      try {
        const kind = effect.kind;
        if (kind.type === "audio") await audio.applyEffect(kind.value);
        else if (kind.type === "open_configuration") openPreferencesFromRuntime();
        else if (kind.type === "start_animation" || kind.type === "present_now") {
          // Rendering state already carries the recoverable revision; requestAnimationFrame
          // gives this transient effect an immediate projection boundary.
          await new Promise(requestAnimationFrame);
        } else {
          throw new Error(`前端未启用 effect：${kind.type}`);
        }
        outcomes.push({ effect_id: effect.effect_id, status: "completed", message: null });
      } catch (error) {
        outcomes.push({ effect_id: effect.effect_id, status: "failed", message: String(error) });
      }
    }
    await send({ type: "effect_acknowledgement", value: { outcomes } });
  }

  async function handleService(request: any, correlationId?: number): Promise<void> {
    await handleRuntimeService(request, correlationId, {
      bridge,
      currentPresentation,
      heldKeys,
      clock: () => testEnvironment.clock,
      nextEntropy: () => testEnvironment.nextEntropy(),
      send,
    });
  }

  async function submitText(): Promise<void> {
    const wait = currentPresentation().inputWait;
    if (!wait || !canInteract.value) return;
    let intent: RuntimeInputIntent;
    switch (wait.kind) {
      case "enter_key":
        intent = { type: "enter" };
        break;
      case "any_key":
        intent = { type: "any_key", value: prompt.value || "\n" };
        break;
      case "void":
        intent = { type: "continue" };
        break;
      case "primitive_mouse_key": {
        const values = prompt.value.split(",").map((part) => Number.parseInt(part.trim(), 10) || 0);
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
        intent = { type: "commit_text", value: prompt.value };
    }
    await submitIntent(intent, false);
    prompt.value = "";
  }

  async function activate(token: InteractionToken): Promise<void> {
    if (!canInteract.value || !hasEnabledButton(currentPresentation(), token)) return;
    await submitIntent({ type: "activate", value: token }, false);
  }

  function interactionEnabled(interaction: any): boolean {
    return presentationInteractionEnabled(currentPresentation(), interaction);
  }

  async function skip(): Promise<void> {
    if (!runtimeReady.value || gameInteractionsBlocked.value || diagnosisExporting.value) return;
    await runtimeInput.requestMessageSkip();
  }

  async function continueFromViewport(): Promise<void> {
    const wait = currentPresentation().inputWait;
    if (canInteract.value && isMessageContinuationWait(wait))
      await submitIntent(messageWaitIntent(wait), false);
  }

  async function submitIntent(intent: RuntimeInputIntent, messageSkip: boolean): Promise<void> {
    if (diagnosisExporting.value) return;
    const submitted = await runtimeInput.submit(intent, messageSkip);
    if (submitted && singleStepEnabled.value && !debugStopToken(debugStop.value))
      await pauseDebug();
  }

  async function settlePendingGameInput(): Promise<void> {
    if (diagnosisExporting.value) return;
    await runtimeInput.settle();
  }

  async function advanceTimedWait(): Promise<void> {
    if (diagnosisExporting.value) return;
    const wait = currentPresentation().inputWait;
    if (
      wait?.deadline_ns == null ||
      pendingGameInput.value != null ||
      pendingInputUndo.value != null
    )
      return;
    const now = sampleMonotonicTime();
    if (!testEnvironment.shouldAdvanceTime(now, TIME_ADVANCE_INTERVAL_NS)) return;
    await send({ type: "advance_time", value: { monotonic_time_ns: now } });
  }

  function sampleMonotonicTime(): number {
    return testEnvironment.sampleMonotonic();
  }

  async function undo(): Promise<void> {
    const token = inputUndo.value?.token;
    if (diagnosisExporting.value || !token || pendingGameInput.value || pendingInputUndo.value)
      return;
    await runtimeInput.undo(token);
  }

  async function restart(): Promise<void> {
    await restartSession({ type: "new_game" }, "重新开始");
  }

  async function restartSession(
    start: PendingRuntimeStart,
    action: "重新开始" | "恢复快照",
  ): Promise<void> {
    if (
      !projectOpen.value ||
      projectLoading.value ||
      runtimePump.transitioning ||
      diagnosisExporting.value
    )
      return;
    startupTelemetry.value = undefined;
    startupTelemetryState.begin(performance.now(), projectSource.value, bridge.kind);
    beginProjectLoad("正在创建新的 Runtime session…");
    runtimePump.setTransitioning(true);
    pendingStart = start;
    try {
      clearSessionTimers();
      resetSessionState(true);
      await runtimePump.waitUntilIdle();
      await compiledCacheExport.cancel();
      await audio
        .synchronize([])
        .catch((error) => log("warning", `${action}时停止音频失败：${String(error)}`));
      resetSessionState();
      if (start.type === "vm_snapshot" && bridge.snapshotRestoreMode === "fresh_session")
        await bridge.prepareSnapshotRestore();
      const batch = await bridge.createSession(sessionOptions());
      runtimePump.setReady(true);
      await handleBatch(batch);
      const metrics = await bridge.restartProject();
      runtimeConfiguration.refreshWritable();
      await runtimeConfiguration.persistGenerated();
      refreshProjectFontFamilies(metrics.projectFonts);
      if (!startupTelemetry.value)
        startupTelemetryState.begin(metrics.submittedAtMs, projectSource.value, bridge.kind);
      startupTelemetryState.applyBridgeMetrics(metrics, bridge.kind);
      const reloadLabel = action === "重新开始" ? "项目重新读取" : "恢复快照时项目重新读取";
      log(
        "info",
        `${reloadLabel}：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress(metrics.cacheImported);
    } catch (error) {
      pendingStart = { type: "new_game" };
      startupTelemetryState.fail(error);
      finishProjectLoad();
      const message = `${action}失败：${String(error)}`;
      baseStatus.value = message;
      log("error", message);
    } finally {
      runtimePump.setTransitioning(false);
      schedulePump(0);
    }
  }

  async function returnToTitle(): Promise<void> {
    if (diagnosisExporting.value) return;
    await send({ type: "return_to_title", value: {} });
  }

  function requestRestart(): void {
    requestGameProgressLossAction("restart");
  }

  function requestReturnToTitle(): void {
    requestGameProgressLossAction("title");
  }

  function requestGameProgressLossAction(action: "restart" | "title"): void {
    if (!runtimeReady.value || gameInteractionsBlocked.value) return;
    gameProgressLossConfirmation.value = action;
  }

  function cancelGameProgressLossAction(): void {
    gameProgressLossConfirmation.value = null;
  }

  async function confirmGameProgressLossAction(): Promise<void> {
    const action = gameProgressLossConfirmation.value;
    gameProgressLossConfirmation.value = null;
    if (!action || !runtimeReady.value || gameInteractionsBlocked.value) return;
    if (action === "restart") await restart();
    else await returnToTitle();
  }

  function resetSessionState(preserveCompiledCacheExport = false): void {
    gameProgressLossConfirmation.value = null;
    projectReload.reset();
    resetTransientStatuses();
    const compiledCacheExport =
      preserveCompiledCacheExport && exportState?.kind === "compiled_cache"
        ? exportState
        : undefined;
    if (exportState?.kind === "project_file")
      void finishProjectFileExport("failed", undefined, false);
    fullManifestImport = undefined;
    fullManifestImports.clear();
    presentationProjection.reset();
    void audio.synchronize([]);
    testAudioPlayback.clear();
    runtimePump.setReady(false);
    phase.value = "negotiating";
    runtimeEpoch.value = 0;
    projectResourceGeneration.value += 1;
    testEnvironment.resetTimeAdvance();
    inputUndo.value = null;
    fault.value = null;
    debugRequests.reset();
    runtimeDebug.resetSession();
    prompt.value = "";
    runtimeInput.reset();
    runtimeViewport.reset();
    exportState = compiledCacheExport;
    runtimeDiagnosis.reset();
    traditionalSaves.reset();
    runtimeImport.reset();
    runtimeConfiguration.reset();
    runtimeClientPreferences.reset();
    projectPreferences.value = defaultProjectPreferences();
    projectPreferencesWritable.value = false;
    gameInformation.value = null;
    runtimeManifestSparse = false;
  }

  async function openProjectReloadDialog(mode: "folder" | "script"): Promise<void> {
    await projectReload.openDialog(mode, runtimeReady.value && !gameInteractionsBlocked.value);
  }

  function closeProjectReloadDialog(): void {
    projectReload.closeDialog();
  }

  async function confirmProjectReload(target: string): Promise<void> {
    const scope = projectReload.selectedScope(target);
    if (scope) await reloadProject(scope);
  }

  async function reloadProject(scope: ProjectReloadScope = { type: "all" }): Promise<void> {
    if (projectLoading.value || runtimePump.transitioning || diagnosisExporting.value) return;
    beginProjectLoad("正在重新加载项目…");
    runtimePump.setTransitioning(true);
    try {
      await runtimePump.waitUntilIdle();
      await compiledCacheExport.cancel();
      const submission = await bridge.reloadProject(scope);
      projectReload.begin(submission.messageId);
      continueProjectBuildProgress();
    } catch (error) {
      await projectReload.failSubmission();
      finishProjectLoad();
      const message = `重新加载项目失败：${String(error)}`;
      baseStatus.value = message;
      log("error", message);
    } finally {
      runtimePump.setTransitioning(false);
      schedulePump(0);
    }
  }

  function dismissFault(): void {
    fault.value = null;
    diagnosisResult.value = "";
  }

  async function recoverFromFault(action: "title" | "reload"): Promise<void> {
    if (faultActionBusy.value || diagnosisExporting.value) return;
    faultActionBusy.value = true;
    fault.value = null;
    diagnosisResult.value = "";
    baseStatus.value = action === "title" ? "正在返回主菜单…" : "正在重启并重新编译…";
    try {
      if (action === "title") {
        await returnToTitle();
        baseStatus.value = GAME_RUNNING_STATUS;
      } else await reloadProject();
    } catch (error) {
      const message = `错误恢复失败：${String(error)}`;
      fault.value = { code: "frontend.recovery_failed", message };
      baseStatus.value = message;
      log("error", message, false, "none");
    } finally {
      faultActionBusy.value = false;
    }
  }

  async function exportDiagnosis(): Promise<void> {
    if (!canExportDiagnosis.value) return;
    const projectName = diagnosisProjectName(
      diagnosisProjectTitle(
        gameInformation.value?.title,
        presentation.title === "RustyEra" ? undefined : presentation.title,
        bridge.projectName(),
      ),
    );
    const exportedAt = testEnvironment.clock ?? new Date();
    runtimeDiagnosis.begin(projectName, formatDiagnosisLogs(logs), exportedAt);
    if (!exportState) await startDiagnosisStateExport("diagnosis_replay");
  }

  async function startDiagnosisStateExport(kind: DiagnosisStateExportKind): Promise<void> {
    if (!runtimeDiagnosis.active || !diagnosisExporting.value) return;
    runtimeDiagnosis.setProgress(kind === "diagnosis_replay" ? "input_replay" : "vm_snapshot");
    const activeExport: ExportState = {
      name: runtimeDiagnosis.active.name,
      kind,
      chunks: [],
      received: 0,
    };
    exportState = activeExport;
    try {
      const messageId = await send({
        type: "state_export_request",
        value: diagnosisStateExportRequest[kind],
      });
      if (exportState === activeExport) activeExport.requestMessageId = String(messageId);
    } catch (error) {
      if (exportState === activeExport)
        await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
    }
  }

  async function exportSnapshot(purpose: "normal" | "debug" = "normal"): Promise<void> {
    if (diagnosisExporting.value) return;
    if (exportState) {
      baseStatus.value = "另一项状态导出仍在进行，请稍后重试";
      return;
    }
    exportState = {
      name: snapshotFileName(),
      kind: "download",
      chunks: [],
      received: 0,
    };
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "vm_snapshot", snapshot_purpose: purpose },
    });
    if (exportState?.kind === "download") exportState.requestMessageId = String(messageId);
  }

  async function exportTraditionalSaveForTest(): Promise<void> {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
      throw new Error("传统存档测试导出只能在 VITE_RUSTYERA_TEST 中使用");
    if (exportState) throw new Error("另一项状态导出仍在进行");
    exportState = {
      name: "save00.sav",
      kind: "download",
      chunks: [],
      received: 0,
    };
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "traditional_save", snapshot_purpose: "normal" },
    });
    if (exportState?.kind === "download") exportState.requestMessageId = String(messageId);
  }

  function testTransferState(): Record<string, unknown> {
    return {
      export: exportState
        ? {
            name: exportState.name,
            received: exportState.received,
            descriptor: exportState.descriptor,
          }
        : null,
      ...runtimeImport.testState(),
    };
  }

  function recordTestAudioPlayback(event: "started" | "ended", resourceId: string): void {
    const current = testAudioPlayback.get(resourceId) ?? { starts: 0, active: 0 };
    if (event === "started") {
      current.starts += 1;
      current.active += 1;
    } else {
      current.active = Math.max(0, current.active - 1);
    }
    testAudioPlayback.set(resourceId, current);
  }

  function testAudioPlaybackState(): Record<string, { starts: number; active: number }> {
    return Object.fromEntries(
      [...testAudioPlayback.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  async function openTraditionalSaveDialog(mode: "export" | "import"): Promise<void> {
    await traditionalSaves.open(mode, canManageTraditionalSaves.value);
  }

  function closeTraditionalSaveDialog(): void {
    traditionalSaves.close();
  }

  async function pickTraditionalSaveImport(): Promise<void> {
    await traditionalSaves.pickImport();
  }

  async function confirmTraditionalSaveTransfer(slot: number): Promise<void> {
    await traditionalSaves.confirm(slot);
  }

  function cancelTraditionalSaveOverwrite(): void {
    traditionalSaves.cancelOverwrite();
  }

  async function confirmTraditionalSaveOverwrite(): Promise<void> {
    await traditionalSaves.confirmOverwrite();
  }

  function scheduleCompiledCacheExport(delayMs = 0): void {
    if (!bridge.automaticCompiledCacheExport) return;
    compiledCacheExport.schedule(delayMs);
  }

  async function refreshCompiledCacheAfterConfigurationUpdate(): Promise<void> {
    if (exportState?.kind === "compiled_cache") await compiledCacheExport.cancel();
    // A cache hit leaves Runtime with an intentionally sparse project manifest. It cannot rebuild
    // bytecode after a configuration edit; the host has already invalidated that cache, so the
    // next project load will materialize source and produce a replacement safely.
    if (runtimeManifestSparse) return;
    scheduleCompiledCacheExport();
  }

  async function exportProjectFile(): Promise<void> {
    if (
      !runtimeReady.value ||
      gameInteractionsBlocked.value ||
      !bridge.fullProjectExportSupported()
    )
      return;
    if (exportState && exportState.kind !== "compiled_cache") return;
    const title = diagnosisProjectName(
      presentation.title.trim() || bridge.projectName() || "RustyEra项目",
    );
    const name = `${title}.reraproj`;
    if (!(await bridge.beginProjectFileExport(name))) {
      baseStatus.value = "已取消导出全量项目文件";
      return;
    }
    if (exportState?.kind === "compiled_cache") {
      projectFileExportState.resumeCacheWhenFinished();
      try {
        await compiledCacheExport.cancel();
      } catch (error) {
        await bridge.cancelProjectFileExport();
        throw error;
      }
    }
    projectFileExportState.begin();
    const activeExport: FullProjectExportState = {
      name,
      kind: "project_file",
      chunks: [],
      received: 0,
    };
    exportState = activeExport;
    baseStatus.value = "正在读取全量项目文件…";
    try {
      await stageFullManifestImport(activeExport, "project_file");
    } catch (error) {
      const cancelled = !projectFileExporting.value && exportState == null;
      await finishProjectFileExport(cancelled ? "cancelled" : "failed");
      if (cancelled) return;
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
      messageId = await send({
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      });
    } catch (error) {
      settleFullProjectRequestSubmission(activeExport, submission);
      throw error;
    }
    if (exportState !== activeExport) {
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
    const descriptor = await bridge.stageFullProjectManifest();
    if (!projectFileExporting.value && purpose === "project_file") {
      await bridge.releaseFullProjectManifest();
      return;
    }
    if (exportState !== activeExport) {
      await bridge.releaseFullProjectManifest();
      return;
    }
    if (!descriptor) {
      await requestFullProjectExport(activeExport);
      return;
    }
    if (descriptor.totalBytes > 1024 * 1024 * 1024) {
      await bridge.releaseFullProjectManifest();
      throw new Error("full project manifest exceeds the 1 GiB transfer limit");
    }
    const pending: NonNullable<typeof fullManifestImport> = {
      activeExport,
      totalBytes: descriptor.totalBytes,
      purpose,
      commandMessageIds: new Set<string>(),
      cancelled: false,
      cancelSent: false,
      commitStarted: false,
      runtimeSubmission: Promise.resolve(),
    };
    fullManifestImport = pending;
    fullManifestImports.add(pending);
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
    const pending = [...fullManifestImports].find(
      (candidate) => candidate.beginMessageId === String(correlationId),
    );
    if (!pending) return false;
    if (pending.transferId != null) {
      log("warning", "Runtime 返回了重复的完整项目 manifest transfer", true);
      await send({ type: "state_transfer_cancel", value: { transfer_id: value.transfer_id } });
      return true;
    }
    pending.transferId = Number(value.transfer_id);
    if (pending.cancelled) {
      await requestFullManifestTransferCancel(pending);
      return true;
    }
    const hasher = blake3.create();
    for (let offset = 0; offset < pending.totalBytes; offset += FULL_PROJECT_MANIFEST_CHUNK_BYTES) {
      if (pending.cancelled) return true;
      const expected = Math.min(FULL_PROJECT_MANIFEST_CHUNK_BYTES, pending.totalBytes - offset);
      let data: Uint8Array;
      try {
        data = await bridge.readFullProjectManifestChunk(offset, expected);
      } catch (error) {
        if (pending.cancelled) return true;
        throw error;
      }
      if (pending.cancelled) return true;
      if (data.byteLength !== expected) throw new Error("完整项目 manifest 临时文件读取不完整");
      hasher.update(data);
      await submitFullManifestCommand(pending, {
        type: "state_import_chunk",
        value: {
          transfer_id: value.transfer_id,
          offset,
          data,
        },
      });
      if (pending.cancelled) return true;
    }
    pending.commitStarted = true;
    const messageId = await submitFullManifestCommand(pending, {
      type: "state_import_commit",
      value: { transfer_id: value.transfer_id, digest: hasher.digest() },
    });
    pending.commitMessageId = String(messageId);
    await releaseFullManifestHost(pending);
    return true;
  }

  async function finishFullManifestImport(
    value: any,
    correlationId?: number | bigint,
  ): Promise<boolean> {
    const pending = [...fullManifestImports].find(
      (candidate) => candidate.commitMessageId === String(correlationId),
    );
    if (!pending) return false;
    if (
      pending.transferId !== Number(value.transfer_id) ||
      value.kind !== "full_project_manifest" ||
      pending.commitMessageId !== String(correlationId)
    ) {
      if (!pending.cancelled) log("warning", "Runtime 返回了不匹配的完整项目 manifest Ready", true);
      return true;
    }
    retireFullManifestImport(pending);
    if (pending.cancelled || exportState !== pending.activeExport) return true;
    await requestFullProjectExport(pending.activeExport);
    return true;
  }

  async function submitFullManifestCommand(
    pending: FullManifestImportTransaction,
    message: RuntimeMessage,
  ): Promise<number | bigint> {
    const submission = pending.runtimeSubmission.then(() => send(message));
    pending.runtimeSubmission = submission.then(
      () => undefined,
      () => undefined,
    );
    const messageId = await submission;
    pending.commandMessageIds.add(String(messageId));
    return messageId;
  }

  function releaseFullManifestHost(pending: FullManifestImportTransaction): Promise<void> {
    pending.hostRelease ??= Promise.resolve(bridge.releaseFullProjectManifest()).catch(
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
      const messageId = await send({
        type: "state_transfer_cancel",
        value: { transfer_id: transferId },
      });
      const correlation = String(messageId);
      pending.commandMessageIds.add(correlation);
      if (!fullManifestImports.has(pending)) rememberRetiredFullManifestCommandId(correlation);
    });
    pending.runtimeSubmission = cancellation.then(
      () => undefined,
      () => undefined,
    );
    await cancellation.catch(() => undefined);
    if (pending.cancelled && !pending.commitStarted) retireFullManifestImport(pending);
  }

  function retireFullManifestImport(pending: FullManifestImportTransaction): void {
    fullManifestImports.delete(pending);
    if (fullManifestImport === pending) fullManifestImport = undefined;
    for (const messageId of pending.commandMessageIds)
      rememberRetiredFullManifestCommandId(messageId);
  }

  function rememberRetiredFullManifestCommandId(messageId: string): void {
    retiredFullManifestCommandIds.add(messageId);
    while (retiredFullManifestCommandIds.size > 64) {
      const oldest = retiredFullManifestCommandIds.values().next().value;
      if (oldest == null) break;
      retiredFullManifestCommandIds.delete(oldest);
    }
  }

  async function cleanupFullManifestImport(
    cancelRuntime: boolean,
    pending = fullManifestImport,
  ): Promise<void> {
    if (!pending) return;
    pending.cancelled = true;
    if (fullManifestImport === pending) fullManifestImport = undefined;
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
      else log("warning", formatDiagnostic(rejection.value), true);
    }
    return preparationRejected;
  }

  function scheduleFullProjectExportRetry(activeExport: FullProjectExportState): void {
    activeExport.requestMessageId = undefined;
    projectFileExportState.scheduleRetry(() => {
      if (exportState !== activeExport || exportState.descriptor) return;
      void requestFullProjectExport(activeExport).catch((error) => {
        void failFullProjectExportRequest(activeExport, error);
      });
    });
  }

  async function failFullProjectExportRequest(
    activeExport: FullProjectExportState,
    error: unknown,
  ): Promise<void> {
    if (exportState !== activeExport) return;
    if (activeExport.kind === "diagnosis_project") {
      await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
      return;
    }
    const message = `全量项目文件导出失败：${String(error)}`;
    await finishProjectFileExport("failed", message);
    log("error", message);
  }

  async function requestCompiledCacheExport(activeExport: ExportState): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (exportState === activeExport) activeExport.requestMessageId = String(messageId);
  }

  async function cancelProjectFileExport(): Promise<void> {
    if (!projectFileExporting.value) return;
    await finishProjectFileExport("cancelled", "已取消导出全量项目文件", true);
  }

  async function finishProjectFileExport(
    outcome: "success" | "cancelled" | "failed",
    message?: string,
    cancelRuntime = outcome !== "success",
  ): Promise<void> {
    const pendingManifest = fullManifestImport;
    exportState = undefined;
    const resumeCache = projectFileExportState.finish();
    if (pendingManifest) await cleanupFullManifestImport(cancelRuntime, pendingManifest);
    if (outcome !== "success") {
      try {
        if (cancelRuntime)
          await send({ type: "state_export_cancel", value: { kind: "full_project_file" } });
      } catch (error) {
        log("warning", `取消 Runtime 全量项目导出失败：${String(error)}`);
      } finally {
        try {
          await bridge.cancelProjectFileExport();
        } catch (error) {
          log("warning", `清理全量项目导出临时文件失败：${String(error)}`);
        }
      }
    }
    if (message) baseStatus.value = message;
    if (resumeCache) scheduleCompiledCacheExport();
    if (diagnosisExporting.value && !exportState)
      await startDiagnosisStateExport("diagnosis_replay");
  }

  async function finishExportTransfer(completed = exportState): Promise<void> {
    if (!completed) return;
    await completed.hostWrite;
    if (exportState !== completed) return;
    if (completed.hostWriteFailure) throw completed.hostWriteFailure.error;
    const result =
      completed.kind === "compiled_cache"
        ? new Uint8Array()
        : (completed.buffer ?? concatenateChunks(completed.chunks, completed.received));
    completed.buffer = undefined;
    completed.chunks.length = 0;
    try {
      if (completed.kind === "download") {
        const saved = await bridge.saveDownload(completed.name, result);
        baseStatus.value = saved ? `已导出 ${completed.name}` : "已取消导出 VM 快照";
        exportState = undefined;
        if (diagnosisExporting.value) await startDiagnosisStateExport("diagnosis_replay");
      } else if (completed.kind === "project_file") {
        await finishProjectFileExport("success", `已导出 ${completed.name}`);
      } else if (completed.kind === "compiled_cache") {
        compiledCacheExport.finish(completed, "success");
        if (diagnosisExporting.value) await startDiagnosisStateExport("diagnosis_replay");
      } else if (completed.kind === "diagnosis_replay") {
        if (!runtimeDiagnosis.active) throw new Error("诊断导出状态缺失");
        runtimeDiagnosis.active.inputReplay = result;
        exportState = undefined;
        await startDiagnosisStateExport("diagnosis_snapshot");
      } else if (completed.kind === "diagnosis_snapshot") {
        if (!runtimeDiagnosis.active) throw new Error("诊断导出状态缺失");
        runtimeDiagnosis.active.snapshot = result;
        const activeExport: FullProjectExportState = {
          name: runtimeDiagnosis.active.name,
          kind: "diagnosis_project",
          chunks: [],
          received: 0,
        };
        exportState = activeExport;
        await stageFullManifestImport(activeExport, "diagnosis_project");
      } else {
        if (!runtimeDiagnosis.active?.snapshot || !runtimeDiagnosis.active.inputReplay)
          throw new Error("诊断归档输入缺失");
        runtimeDiagnosis.setProgress("archive");
        const saved = await bridge.saveDiagnosis(
          runtimeDiagnosis.active.name,
          {
            projectName: runtimeDiagnosis.active.projectName,
            snapshot: runtimeDiagnosis.active.snapshot,
            inputReplay: runtimeDiagnosis.active.inputReplay,
            logs: runtimeDiagnosis.active.logs,
            projectFile: result,
            exportedAt: runtimeDiagnosis.active.exportedAt,
          },
          ({ completed, total }) => runtimeDiagnosis.setProgress("archive", completed, total),
        );
        finishDiagnosis(
          true,
          saved ? `诊断信息已导出：${runtimeDiagnosis.active.name}` : "已取消导出诊断信息",
        );
      }
    } catch (error) {
      if (completed.kind.startsWith("diagnosis_")) {
        const activeDiagnosis =
          exportState?.kind.startsWith("diagnosis_") === true ? exportState : completed;
        await failDiagnosisExport(activeDiagnosis, `诊断信息导出失败：${String(error)}`);
      } else {
        if (completed.kind === "project_file") {
          await finishProjectFileExport("failed");
        } else if (completed.kind === "compiled_cache") {
          await compiledCacheExport.fail(completed, error);
          return;
        } else {
          exportState = undefined;
        }
        const message = `状态导出失败：${String(error)}`;
        baseStatus.value = message;
        log("error", message);
      }
    }
  }

  function finishDiagnosis(success: boolean, message: string): void {
    exportState = undefined;
    runtimeDiagnosis.finish(message);
    baseStatus.value = message;
    log(success ? "info" : "error", message, false, "none");
  }

  async function failDiagnosisExport(activeExport: ExportState, message: string): Promise<void> {
    if (exportState !== activeExport || !activeExport.kind.startsWith("diagnosis_")) return;
    const pendingManifest = fullManifestImport;
    exportState = undefined;
    runtimeDiagnosis.active = undefined;
    if (pendingManifest) await cleanupFullManifestImport(true, pendingManifest);
    if (activeExport.kind === "diagnosis_replay" || activeExport.kind === "diagnosis_snapshot") {
      try {
        if (activeExport.descriptor?.transfer_id != null) {
          await send({
            type: "state_transfer_cancel",
            value: { transfer_id: activeExport.descriptor.transfer_id },
          });
        } else if (activeExport.requestMessageId) {
          await send({
            type: "state_export_cancel",
            value: {
              kind: activeExport.kind === "diagnosis_replay" ? "input_replay" : "vm_snapshot",
            },
          });
        }
      } catch (error) {
        log("warning", `取消 Runtime 诊断状态导出失败：${String(error)}`);
      }
    } else if (isFullProjectExport(activeExport) && activeExport.kind === "diagnosis_project") {
      if (
        activeExport.requestMessageId ||
        activeExport.runtimeRequestMayBeActive ||
        activeExport.descriptor
      ) {
        try {
          await send({ type: "state_export_cancel", value: { kind: "full_project_file" } });
        } catch (error) {
          log("warning", `取消 Runtime 诊断项目导出失败：${String(error)}`);
        }
      }
      try {
        await bridge.cancelProjectFileExport();
      } catch (error) {
        log("warning", `清理诊断项目导出状态失败：${String(error)}`);
      }
    }
    finishDiagnosis(false, message);
  }

  async function restoreSnapshot(): Promise<void> {
    if (diagnosisExporting.value) return;
    const bytes = await runtimeImport.pickSnapshot();
    if (!bytes) return;
    if (bridge.snapshotRestoreMode === "fresh_session") {
      await restartSession({ type: "vm_snapshot", bytes }, "恢复快照");
    } else {
      await runtimeImport.begin("vm_snapshot", bytes);
    }
  }

  async function restoreState(
    kind: Exclude<RuntimeStartKind, "new_game">,
    bytes: Uint8Array,
  ): Promise<void> {
    await runtimeImport.begin(kind, bytes);
  }

  async function enableDebug(): Promise<void> {
    if (diagnosisExporting.value) return;
    await ensureSession();
    if (!debugEnabled.value) {
      await requestDebugGrant();
    } else {
      if (debugGrant.value)
        await bridge.submitDebug({
          type: "revoke",
          value: { grant_id: debugGrant.value.token.grant_id, reason: "disabled by user" },
        });
      debugRequests.pausePending = false;
      debugRequests.pauseWanted = false;
      debugRequests.surfacePauseActive = false;
      debugRequests.surfaceResumePending = false;
      debugRequests.reset();
      runtimeDebug.revokeGrant();
    }
  }

  async function handleDebug(message: any, correlationId?: number | bigint): Promise<void> {
    if (message.type === "grant") {
      debugRequests.pausePending = false;
      debugRequests.grantRefreshNeeded = false;
      runtimeDebug.acceptGrant(message.value);
    } else if (message.type === "revoke") {
      debugRequests.pausePending = false;
      debugRequests.pauseWanted = false;
      debugRequests.surfacePauseActive = false;
      debugRequests.surfaceResumePending = false;
      runtimeDebug.revokeGrant();
    } else if (message.type === "stopped") {
      debugRequests.pausePending = false;
      debugRequests.pauseWanted = false;
      runtimeDebug.acceptStop(message.value);
      debugRequests.take(correlationId);
      // The stop token is authoritative only after this event. Start refreshing here so
      // dialog visibility cannot race a Vue watcher against the pause response. Pagination
      // must continue asynchronously because its later pages arrive in future pump batches.
      void refreshOpenDebugSurfaces().catch((error) => log("warning", String(error)));
      if (debugRequests.surfaceResumePending && !singleStepEnabled.value) {
        debugRequests.surfaceResumePending = false;
        void continueDebug().catch((error) => log("warning", String(error)));
      }
      if (singleStepEnabled.value && message.value?.reason?.type === "host_wait")
        void continueDebug(true).catch((error) => log("warning", String(error)));
    } else if (message.type === "response") {
      const request = debugRequests.take(correlationId);
      const response = message.value;
      const fiber = runtimeDebug.applyResponse(response);
      if (response.type === "fiber_page") {
        if (stackOpen.value && fiber)
          await debugCommand({
            type: "read_call_stack",
            stop: debugStopToken(debugStop.value),
            fiber_id: fiber.fiber_id,
          });
      }
      request?.resolve?.(response);
    } else if (message.type === "error") {
      const request = debugRequests.take(correlationId);
      if (request?.commandType === "pause") debugRequests.pausePending = false;
      if (debugEnabled.value && isStaleDebugGrantError(message.value)) {
        const currentToken = debugGrant.value?.token;
        if (!currentToken || !request || sameDebugGrant(request.grant, currentToken)) {
          runtimeDebug.clearGrant();
          debugRequests.grantRefreshNeeded = true;
        }
      } else {
        if (request?.commandType === "pause") {
          debugRequests.pauseWanted = false;
          debugRequests.surfacePauseActive = false;
          debugRequests.surfaceResumePending = false;
        }
        log("warning", message.value.message);
      }
      request?.reject?.(new Error(message.value.message ?? "debug request failed"));
    }
  }

  async function requestDebugGrant(): Promise<void> {
    await bridge.submitDebug(
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
    schedulePump(0);
  }

  async function debugCommand(command: any): Promise<void> {
    if (!debugGrant.value || diagnosisExporting.value) return;
    const grant = debugGrant.value.token;
    const messageId = await bridge.submitDebug(
      transportValue({
        type: "request",
        value: { grant, command },
      }),
    );
    debugRequests.register(messageId, grant, command?.type);
  }

  async function debugRequest(command: any, timeoutMs = 10_000): Promise<any> {
    if (!debugGrant.value) throw new Error("debug grant 尚未就绪");
    const grant = debugGrant.value.token;
    const messageId = await bridge.submitDebug(
      transportValue({
        type: "request",
        value: { grant, command },
      }),
    );
    const response = debugRequests.wait(messageId, grant, command?.type, timeoutMs);
    schedulePump(0);
    return response;
  }

  async function inspectWatches(watches: string[]): Promise<Record<string, unknown>> {
    if (!debugEnabled.value) {
      await enableDebug();
      await waitUntil(() => debugGrant.value != null, 10_000, "debug grant");
    }
    const alreadyStopped = debugStopToken(debugStop.value) != null;
    if (!alreadyStopped) {
      await pauseDebug();
      await waitUntil(() => debugStopToken(debugStop.value) != null, 10_000, "debug stop");
    }
    const stop = debugStopToken(debugStop.value);
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
    debugRequests.pauseWanted = true;
    await requestPendingDebugPause();
  }

  async function requestPendingDebugPause(): Promise<void> {
    if (
      !debugRequests.pauseWanted ||
      !debugGrant.value ||
      debugStopToken(debugStop.value) ||
      debugRequests.pausePending ||
      !["running", "waiting_input", "waiting_external"].includes(phase.value)
    )
      return;
    debugRequests.pausePending = true;
    try {
      await debugCommand({ type: "pause" });
    } catch (error) {
      debugRequests.pausePending = false;
      throw error;
    }
  }

  async function openDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (diagnosisExporting.value) return;
    if (kind === "console") debugConsoleOpen.value = true;
    else if (kind === "variables") {
      variablesOpen.value = true;
      runtimeDebug.clearVariables();
    } else {
      stackOpen.value = true;
      runtimeDebug.clearStack();
    }
    if (debugStopToken(debugStop.value)) await refreshOpenDebugSurfaces();
    else {
      debugRequests.surfacePauseActive = true;
      debugRequests.surfaceResumePending = false;
      await pauseDebug();
    }
  }

  async function closeDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (kind === "console") debugConsoleOpen.value = false;
    else if (kind === "variables") variablesOpen.value = false;
    else stackOpen.value = false;
    if (debugConsoleOpen.value || variablesOpen.value || stackOpen.value) return;
    if (!debugRequests.surfacePauseActive) return;
    debugRequests.surfacePauseActive = false;
    if (singleStepEnabled.value) return;
    if (debugStopToken(debugStop.value)) await continueDebug();
    else debugRequests.surfaceResumePending = true;
  }

  async function refreshOpenDebugSurfaces(): Promise<void> {
    const stop = debugStopToken(debugStop.value);
    if (!stop) return;
    const commands = [debugCommand({ type: "list_fibers", stop, cursor: null, limit: 256 })];
    if (variablesOpen.value) commands.push(refreshDebugVariables(stop));
    await Promise.all(commands);
  }

  async function refreshDebugVariables(stop: any): Promise<void> {
    const refreshId = debugRequests.nextVariableRefresh();
    debugVariablesLoading.value = true;
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
        debugRequests.isCurrentVariableRefresh(refreshId)
      );
      if (debugRequests.isCurrentVariableRefresh(refreshId)) debugVariables.value = variables;
    } finally {
      if (debugRequests.isCurrentVariableRefresh(refreshId)) debugVariablesLoading.value = false;
    }
  }

  async function stepDebug(): Promise<void> {
    if (!singleStepEnabled.value || diagnosisExporting.value) return;
    const command = sourceLineStepCommand(debugStop.value);
    if (!command) return;
    const previousStop = debugStop.value;
    debugRequests.pauseWanted = false;
    debugStop.value = null;
    try {
      await debugRequest(command);
    } catch (error) {
      debugStop.value = previousStop;
      throw error;
    }
  }

  async function continueDebug(preserveSingleStep = false): Promise<void> {
    if (diagnosisExporting.value) return;
    const stop = debugStopToken(debugStop.value);
    if (!stop) return;
    if (!preserveSingleStep) singleStepEnabled.value = false;
    const previousStop = debugStop.value;
    debugRequests.pauseWanted = false;
    debugRequests.surfacePauseActive = false;
    debugRequests.surfaceResumePending = false;
    debugStop.value = null;
    try {
      await debugRequest({ type: "continue", stop });
    } catch (error) {
      debugStop.value = previousStop;
      throw error;
    }
  }

  async function toggleSingleStep(): Promise<void> {
    if (!debugEnabled.value || diagnosisExporting.value) return;
    singleStepEnabled.value = !singleStepEnabled.value;
    if (singleStepEnabled.value) {
      if (!debugStopToken(debugStop.value)) await pauseDebug();
    } else if (debugStopToken(debugStop.value)) {
      await continueDebug(true);
    }
  }

  async function saveProjectSettings(
    changes: ProjectConfigurationChange[] = [],
    restartAfterApply = false,
  ): Promise<void> {
    await runtimeProjectSettings.save(changes, restartAfterApply);
  }

  async function continueLoadedProject(runtimeAcceptedCompiledCache: boolean): Promise<void> {
    if (runtimeAcceptedCompiledCache) {
      showProjectLoadTransition("项目缓存命中，正在准备脚本热重载…");
      await bridge.prepareProjectReloadBaseline();
    }
    await settleProjectViewport();
    startupTelemetryState.completeFrontendReadiness();
    if (["running", "waiting_input", "waiting_external"].includes(phase.value)) {
      const telemetry = startupTelemetry.value;
      if (telemetry?.outcome === "loading") {
        telemetry.milestones.firstGamePhaseMs ??= startupTelemetryState.elapsedMs();
        telemetry.outcome = "success";
      }
      finishProjectLoad();
      baseStatus.value = GAME_RUNNING_STATUS;
      if (!runtimeManifestSparse) scheduleCompiledCacheExport(1000);
      return;
    }
    baseStatus.value = PROJECT_STARTING_STATUS;
    finishProjectLoad();
    const start = pendingStart;
    pendingStart = { type: "new_game" };
    if (start.type === "new_game") {
      await send({
        type: "start",
        value: { mode: { type: "new_game", seed: start.seed ?? null } },
      });
    } else {
      await restoreState(start.type, start.bytes);
    }
    if (!runtimeManifestSparse) scheduleCompiledCacheExport(1000);
  }

  function refreshProjectPreferences(): void {
    projectPreferences.value = bridge.currentProjectPreferences() ?? defaultProjectPreferences();
    projectPreferencesWritable.value = bridge.projectPreferencesWritable();
  }

  async function applyEffectiveClientConfiguration(): Promise<void> {
    if (!projectConfiguration.value) return;
    try {
      await bridge.applyProjectConfiguration(
        configurationEntries.value,
        runtimeViewport.chrome(currentGameViewportMeasurement()),
      );
    } catch (error) {
      log("warning", `客户端项目配置应用失败：${String(error)}`);
    }
  }

  async function saveClientPreferences(
    scope: "global" | "project",
    value: ProjectPreferences,
  ): Promise<void> {
    await runtimeClientPreferences.save(scope, value);
  }

  async function projectViewport(measurement = currentGameViewportMeasurement()): Promise<void> {
    await runtimeViewport.observe(
      measurement,
      runtimePump.ready,
      presentation.revision,
      prompt.value,
    );
  }

  async function settleProjectViewport(): Promise<void> {
    await runtimeViewport.settle(projectViewport);
  }

  async function sendClientState(): Promise<void> {
    if (!runtimePump.ready || diagnosisExporting.value) return;
    await send({
      type: "client_state_changed",
      value: {
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        audio_available: true,
        reduce_motion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        high_contrast: matchMedia("(prefers-contrast: more)").matches,
        screen_reader: false,
      },
    });
  }

  async function shutdown(): Promise<void> {
    if (diagnosisExporting.value) return;
    if (fullManifestImport) await cleanupFullManifestImport(true);
    if (bridge.kind === "browser") {
      requestBrowserTabClose();
      return;
    }
    if (!runtimePump.ready) return bridge.close();
    await send({ type: "shutdown_request", value: { graceful: true } });
  }

  async function send(message: RuntimeMessage, correlationId?: number): Promise<number | bigint> {
    const telemetry = startupTelemetry.value;
    const startupStart =
      message.type === "start" &&
      telemetry?.outcome === "loading" &&
      telemetry.milestones.startSubmittedMs == null;
    if (startupStart) telemetry.milestones.startSubmittedMs = startupTelemetryState.elapsedMs();
    const submission = bridge.submitRuntime(transportValue(message), correlationId);
    // WorkerClient posts both requests to one Worker port, so queue the drive immediately:
    // FIFO delivery still guarantees that the runtime accepts this command before pumping it.
    // Native IPC does not expose that ordering guarantee and keeps the acknowledgement barrier.
    if (bridge.kind === "browser") schedulePump(0);
    const messageId = await submission;
    if (startupStart) startupTelemetryState.startMessageId = String(messageId);
    if (bridge.kind !== "browser") schedulePump(0);
    return messageId;
  }

  function applyInputUndo(value: any): void {
    runtimeInput.applyUndo(value);
    inputUndo.value = value;
  }

  async function waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(`等待 ${description} 超时`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
  }

  function log(
    level: LogEntry["level"],
    message: string,
    authoritative = false,
    notificationPolicy: LogNotificationPolicy = "all",
  ): void {
    runtimeLogs.record(level, message, authoritative, notificationPolicy);
  }

  function appendLogEntries(
    entries: LogEntry[],
    notificationPolicy: LogNotificationPolicy | readonly LogNotificationPolicy[] = "all",
  ): void {
    runtimeLogs.append(entries, notificationPolicy);
  }

  function dismissLogNotification(id: number): void {
    runtimeLogs.dismiss(id);
  }

  function beginProjectLoad(message: string): void {
    projectLoad.begin();
    baseStatus.value = message;
  }

  function continueProjectBuildProgress(cacheImported = false): void {
    if (!projectLoad.continueBuild()) return;
    baseStatus.value = cacheImported
      ? "项目缓存命中，正在加载缓存…"
      : "项目文件读取完成，正在准备编译与校验…";
  }

  function showProjectLoadTransition(message: string): void {
    projectLoad.transition();
    baseStatus.value = message;
  }

  function finishProjectLoad(): void {
    projectLoad.finish();
  }

  function handleProjectProgress(value: ProjectProgress): void {
    const progress = normalizeProjectProgress(value);
    if (!progress) return;
    if (diagnosisExporting.value && exportState?.kind === "diagnosis_project") {
      runtimeDiagnosis.setProgress(
        progress.stage === "scanning"
          ? "project_scanning"
          : progress.stage === "packaging"
            ? "project_packaging"
            : "project_preparing",
        progress.completed,
        progress.total,
      );
      return;
    }
    if (projectFileExporting.value) {
      projectFileExportState.setProgress(progress);
      baseStatus.value = formatProjectProgress(progress);
      return;
    }
    if (!projectLoad.record(progress)) return;
    startupTelemetryState.recordProgress(progress);
    baseStatus.value = formatProjectProgress(progress);
  }

  function requestBrowserTabClose(): void {
    window.close();
    window.setTimeout(() => {
      if (window.closed) return;
      const message = "浏览器阻止了关闭当前标签页，请手动关闭此标签页。";
      baseStatus.value = message;
      log("warning", message);
    }, 0);
  }

  function onKeyDown(event: KeyboardEvent): void {
    heldKeys.add(event.keyCode);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      openPreferencesFromUser();
    } else if (
      event.key === "F10" &&
      debugEnabled.value &&
      singleStepEnabled.value &&
      !diagnosisExporting.value
    ) {
      event.preventDefault();
      void stepDebug();
    } else if (
      !event.defaultPrevented &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !isModifierKey(event.key) &&
      canInteract.value &&
      currentPresentation().inputWait?.kind === "any_key"
    ) {
      event.preventDefault();
      void submitIntent({ type: "any_key", value: event.key || "\n" }, false);
    }
  }

  function isModifierKey(key: string): boolean {
    return ["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(key);
  }

  function onKeyUp(event: KeyboardEvent): void {
    heldKeys.delete(event.keyCode);
  }

  return {
    bridgeKind: bridge.kind,
    directProjectDirectoryAccess: bridge.directProjectDirectoryAccess === true,
    memoryConstrained: bridge.memoryConstrained === true,
    presentation,
    preferences,
    projectPreferences,
    configurationEntries,
    projectSource,
    configurationReadOnly,
    configurationSessionOnly,
    configurationRestartPending,
    viewportMeasurement,
    menuMode,
    useMouse,
    replaceFullWidthSpaces,
    scrollHeight,
    effectivePreferences,
    gameTextStyle,
    gameLineHeightPx,
    systemFonts,
    availableFontFamilies,
    fontAccessStatus,
    fontAccessError,
    phase,
    runtimeEpoch,
    projectResourceGeneration,
    status,
    projectOpen,
    gameInformation,
    coreVersion,
    projectLoading,
    startupTelemetry,
    projectLoadProgressLabel,
    projectLoadProgressValue,
    openProjectConfirmationOpen,
    gameProgressLossConfirmation,
    projectReloadDialogMode,
    projectReloadTargetOptions,
    projectReloadDialogBusy,
    projectReloadDialogError,
    prompt,
    inputUndo,
    fault,
    faultMessage,
    faultActionBusy,
    logs,
    projectSettingsOpen,
    preferencesOpen,
    projectPreferencesWritable,
    settingsBusy,
    projectSettingsError,
    preferencesError,
    logsOpen,
    debugConsoleOpen,
    variablesOpen,
    stackOpen,
    debugEnabled,
    singleStepEnabled,
    debugStop,
    debugOutput,
    debugVariables,
    debugVariablesLoading,
    debugFibers,
    debugFrames,
    debugVariableValues,
    diagnosisExporting,
    diagnosisProgress,
    diagnosisProgressLabel,
    diagnosisProgressValue,
    diagnosisResult,
    projectFileExporting,
    projectFileExportProgressLabel,
    projectFileExportProgressValue,
    logNotifications,
    traditionalSaveDialogMode,
    traditionalSaveSlots,
    traditionalSaveImportName,
    traditionalSaveTransferBusy,
    traditionalSaveTransferError,
    traditionalSaveOverwriteSlot,
    runtimeReady,
    canExportDiagnosis,
    fullProjectExportSupported,
    canExportProjectFile,
    canManageTraditionalSaves,
    gameInteractionsBlocked,
    canOpenProject,
    canStepDebug,
    canInteract,
    interactionEnabled,
    promptPlaceholder,
    openPreferencesFromUser,
    openProjectSettingsFromUser,
    requestSystemFonts,
    initialize,
    openProject,
    openProjectFile,
    cancelOpenProject,
    confirmOpenProject,
    submitText,
    activate,
    skip,
    continueFromViewport,
    undo,
    restart,
    returnToTitle,
    requestRestart,
    requestReturnToTitle,
    cancelGameProgressLossAction,
    confirmGameProgressLossAction,
    openProjectReloadDialog,
    closeProjectReloadDialog,
    confirmProjectReload,
    reloadProject,
    dismissFault,
    recoverFromFault,
    exportDiagnosis,
    dismissLogNotification,
    exportSnapshot,
    exportProjectFile,
    cancelProjectFileExport,
    exportTraditionalSaveForTest,
    restoreSnapshot,
    openTraditionalSaveDialog,
    closeTraditionalSaveDialog,
    pickTraditionalSaveImport,
    confirmTraditionalSaveTransfer,
    cancelTraditionalSaveOverwrite,
    confirmTraditionalSaveOverwrite,
    enableDebug,
    debugCommand,
    inspectWatches,
    openDebugDialog,
    closeDebugDialog,
    stepDebug,
    toggleSingleStep,
    continueDebug,
    saveProjectSettings,
    saveClientPreferences,
    shutdown,
    projectViewport,
    configureTestRun,
    restoreState,
    testTransferState,
    testAudioPlaybackState,
  };
});
