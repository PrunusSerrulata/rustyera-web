import { blake3 } from "@noble/hashes/blake3.js";
import { defineStore } from "pinia";
import { computed, nextTick, reactive, ref, shallowReactive, toRaw } from "vue";

import { AudioEngine } from "@/core/audio";
import {
  clientConfigurationEntries,
  equalConfigurationIdentity,
  parsePreparedConfiguration,
  parseProjectConfiguration,
  prepareConfigurationUpdate,
} from "@/core/configuration";
import { diagnosisArchiveName, diagnosisProjectName } from "@/core/diagnosis";
import {
  debugStopToken,
  debugVariableKey,
  formatDebugValue,
  isStaleDebugGrantError,
  refreshDebugStop,
  sameDebugGrant,
  selectedDebugFiber,
  sourceLineStepCommand,
} from "@/core/debug";
import { preferredRuntimeLocales, resolveGameTextStyle } from "@/core/gameText";
import { decodeImageMetadata } from "@/core/imageMetadata";
import type { LogNotificationState } from "@/core/log";
import {
  isMessageContinuationWait,
  isMessageSkipWait,
  messageWaitIntent,
  type MessageWaitIntent,
} from "@/core/messageSkip";
import {
  at,
  concatenateChunks,
  formatDiagnostic,
  formatDiagnosisLogs,
  formatProjectProgress,
  isRecoverableStaleDebugLog,
  mapOf,
  safeNumber,
  saveSlotFileName,
  snapshotFileName,
  type DiagnosisLogEntry,
} from "@/core/runtimeSupport";
import { formatRuntimeFault } from "@/core/runtimeFault";
import {
  applyDelta,
  applySnapshot,
  emptyPresentation,
  hasEnabledButton,
  plainLine,
  printedHtmlLine,
  restoreButtons,
  retireEnabledButtons,
  type PresentationState,
} from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  defaultPreferences,
  type InteractionToken,
  type Preferences,
  type ProjectConfigurationChange,
  type ProjectConfigurationSnapshot,
  type ProjectOpenMetrics,
  type ProjectFontLoadResult,
  type ProjectProgress,
  type ProjectProgressStage,
  type PumpBatch,
  type RuntimeMessage,
  type SessionOptions,
  type TraditionalSaveSlot,
} from "@/core/types";
import { platformBridge } from "@/platform";
import {
  currentGameViewportMeasurement,
  type GameViewportMeasurement,
} from "@/platform/viewportMeasurement";
import { RuntimePumpCoordinator } from "@/stores/runtimePump";
import { useSystemFontAccess } from "@/stores/systemFontAccess";
import { transportValue } from "@/stores/runtimeTransport";

type LogEntry = DiagnosisLogEntry & { authoritative: boolean };
type LogNotificationPolicy = "all" | "errors_only" | "none";

type RuntimeInputIntent =
  | MessageWaitIntent
  | { type: "commit_text"; value: string }
  | { type: "activate"; value: InteractionToken }
  | { type: "continue" }
  | { type: "cancel" }
  | {
      type: "primitive";
      value: {
        input_type: number;
        result_1: number;
        result_2: number;
        result_3: number;
        result_4: number;
        selection_token: InteractionToken | null;
      };
    }
  | { type: "activate_key_macro"; value: { group: number; slot: number } };

const sessionFontFallback = ["system-ui", "sans-serif", "serif", "monospace"];

interface ExportState {
  name: string;
  kind: "download" | "project_file" | "compiled_cache" | "diagnosis_snapshot" | "diagnosis_project";
  chunks: Uint8Array[];
  buffer?: Uint8Array;
  received: number;
  descriptor?: any;
  requestMessageId?: string;
  hostWrite?: Promise<void>;
  hostWriteFailure?: { error: unknown };
  statusToken?: number;
}

type TransientStatusOwner = "settings" | "compiled_cache";

interface TransientStatusState {
  token: number;
  message: string;
  timer?: number;
}

type FullProjectExportState = ExportState & {
  kind: "project_file" | "diagnosis_project";
};

function isFullProjectExport(state: ExportState | undefined): state is FullProjectExportState {
  return state?.kind === "project_file" || state?.kind === "diagnosis_project";
}

function runtimeDebugVariant(value: unknown): string {
  return String(value ?? "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function suppressedMirroredLogNotificationIndexes(events: PumpBatch["events"]): Set<number> {
  const suppressed = new Set<number>();
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];
    if (
      event.channel === "runtime" &&
      event.message.type === "fault" &&
      previous.channel === "runtime" &&
      previous.message.type === "log" &&
      (previous.message as RuntimeMessage).value.level === "error"
    ) {
      suppressed.add(index - 1);
      continue;
    }
    if (
      event.channel === "runtime" &&
      event.message.type === "log" &&
      previous.channel === "runtime" &&
      previous.message.type === "command_rejected"
    ) {
      const rejection = (previous.message as RuntimeMessage).value as {
        code?: unknown;
        message?: unknown;
      };
      const entry = (event.message as RuntimeMessage).value as {
        level?: unknown;
        message?: unknown;
      };
      const expected = `command rejected [${runtimeDebugVariant(rejection.code)}]: ${String(rejection.message ?? "")}`;
      if (
        ["warning", "error"].includes(String(entry.level ?? "")) &&
        String(entry.message ?? "") === expected
      )
        suppressed.add(index);
      continue;
    }
    if (
      event.channel === "runtime" &&
      event.message.type === "state_export_ready" &&
      previous.channel === "runtime" &&
      previous.message.type === "log"
    ) {
      const ready = (event.message as RuntimeMessage).value as {
        result?: { type?: unknown; reasons?: unknown[] };
      };
      const entry = (previous.message as RuntimeMessage).value as {
        level?: unknown;
        message?: unknown;
      };
      const reasons = ready.result?.reasons ?? [];
      const expected = `state export is ineligible: [${reasons.map(runtimeDebugVariant).join(", ")}]`;
      if (
        ready.result?.type === "ineligible" &&
        entry.level === "warning" &&
        entry.message === expected
      )
        suppressed.add(index - 1);
    }
  }
  return suppressed;
}

interface DiagnosisState {
  name: string;
  projectName: string;
  logs: string;
  exportedAt: Date;
  snapshot?: Uint8Array;
}

interface PendingGameInput {
  waitIdentity: string;
  waitId: string;
  messageId?: string;
  waitKind: string;
  intent: RuntimeInputIntent;
  messageSkip: boolean;
  waitClosed?: boolean;
  retryPending?: boolean;
  retryError?: string;
  staleRetries: number;
  retiredButtonTokens: string[];
}

interface PendingInputUndo {
  tokenIdentity: string;
  messageId?: string;
}

interface PendingConfigurationBase {
  snapshot: ProjectConfigurationSnapshot;
  changedCodes: string[];
  sessionOnly: boolean;
  automatic: boolean;
  statusToken?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type PendingConfigurationUpdate =
  | (PendingConfigurationBase & {
      stage: "preparing";
      prepareMessageId: number | bigint;
    })
  | (PendingConfigurationBase & {
      stage: "finalizing";
      prepareMessageId: number | bigint;
      finalizeMessageId: number | bigint;
      outcome: "commit" | "abort";
      writeError?: unknown;
    });

export type RuntimeStartKind = "new_game" | "traditional_save" | "vm_snapshot";

export interface RuntimeTestConfiguration {
  start: {
    type: RuntimeStartKind;
    seed?: number;
    bytes?: Uint8Array;
  };
  clock?: string;
  monotonicStartNs?: number;
}

export interface StartupTelemetry {
  attemptId: number;
  client: "browser" | "tauri";
  scenario: "cold" | "warm" | "project_file";
  submittedAtMs: number;
  bridge: {
    quickScanMs: number | null;
    cacheReadMs: number | null;
    sourceReadMs: number | null;
    submitMs: number | null;
  };
  durations: {
    enumerateMs: number | null;
    statAndIndexReadMs: number | null;
    indexWriteMs: number | null;
    sourceReadDecodeHashMs: number | null;
    cacheReadMs: number | null;
    submissionTransferMs: number | null;
    cacheDecodeMs: number | null;
    parseMs: number | null;
    analyzeMs: number | null;
    compileMs: number | null;
    validateMs: number | null;
  };
  observedStages: Partial<Record<ProjectProgressStage, number>>;
  milestones: {
    runtimeValidationReportedMs: number | null;
    frontendReadyToStartMs: number | null;
    startSubmittedMs: number | null;
    firstGamePhaseMs: number | null;
  };
  cacheHit: boolean | null;
  outcome: "loading" | "success" | "failure";
  error: string | null;
}

const DEBUG_VARIABLE_PAGE_LIMIT = 256;
const DEBUG_VARIABLE_MAX_PAGES = 16;
const TIME_ADVANCE_INTERVAL_NS = 16_000_000;
const MAXIMUM_LOG_ENTRIES = 10_000;
const STATUS_FEEDBACK_DURATION_MS = 2_000;
const PROJECT_STARTING_STATUS = "项目加载完成，正在启动游戏…";
const GAME_RUNNING_STATUS = "游戏运行中";

export const useRuntimeStore = defineStore("runtime", () => {
  const bridge = platformBridge();
  const presentation = reactive(emptyPresentation());
  let stagedPresentation: PresentationState | undefined;
  let stagedPresentationReady = false;
  let stagedPresentationCanFlushWhenIdle = false;
  const presentationStaged = ref(false);
  const preferences = ref<Preferences>(defaultPreferences());
  const projectConfiguration = ref<ProjectConfigurationSnapshot | null>(null);
  let pendingConfigurationUpdate: PendingConfigurationUpdate | undefined;
  const configurationProfileValid = ref(true);
  const configurationMigrationFailed = ref(false);
  const viewportMeasurement = ref<GameViewportMeasurement>();
  const previewPreferences = ref<Preferences | null>(null);
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
  const baseStatus = ref("请选择 Era 项目文件夹");
  const transientStatuses = reactive<Partial<Record<TransientStatusOwner, TransientStatusState>>>(
    {},
  );
  let transientStatusSequence = 0;
  const status = computed(
    () =>
      transientStatuses.settings?.message ??
      transientStatuses.compiled_cache?.message ??
      baseStatus.value,
  );
  const projectOpen = ref(false);
  const projectLoading = ref(false);
  const projectSelecting = ref(false);
  const projectProgress = ref<ProjectProgress>();
  const projectFileExporting = ref(false);
  const projectFileExportProgress = ref<ProjectProgress>();
  const projectLoadElapsedSeconds = ref(0);
  const startupTelemetry = ref<StartupTelemetry>();
  const openProjectConfirmationOpen = ref(false);
  const gameProgressLossConfirmation = ref<"restart" | "title" | null>(null);
  let pendingProjectSelection: "directory" | "file" = "directory";
  let activeProjectSelection: "directory" | "file" = "directory";
  const prompt = ref("");
  const inputUndo = ref<any>(null);
  const fault = ref<any>(null);
  const faultMessage = computed(() => formatRuntimeFault(fault.value));
  const faultActionBusy = ref(false);
  const logs = shallowReactive<LogEntry[]>([]);
  const preferencesOpen = ref(false);
  const settingsBusy = ref(false);
  const settingsError = ref("");
  let settingsStartedAt: number | undefined;
  let settingsElapsedTimer: number | undefined;
  const logsOpen = ref(false);
  const debugConsoleOpen = ref(false);
  const variablesOpen = ref(false);
  const stackOpen = ref(false);
  const debugEnabled = ref(false);
  const singleStepEnabled = ref(false);
  const debugGrant = ref<any>(null);
  const debugStop = ref<any>(null);
  const debugOutput = ref<string[]>([]);
  const debugVariables = ref<any[]>([]);
  const debugVariablesLoading = ref(false);
  const debugFibers = ref<any[]>([]);
  const debugFrames = ref<any[]>([]);
  const debugVariableValues = ref<Record<string, string>>({});
  const diagnosisExporting = ref(false);
  const diagnosisNotification = ref("");
  const logNotifications = shallowReactive<LogNotificationState[]>([]);
  const traditionalSaveDialogMode = ref<"export" | "import" | null>(null);
  const traditionalSaveSlots = ref<TraditionalSaveSlot[]>([]);
  const traditionalSaveImportName = ref("");
  const traditionalSaveTransferBusy = ref(false);
  const traditionalSaveTransferError = ref("");
  const traditionalSaveOverwriteSlot = ref<number | null>(null);
  const heldKeys = new Set<number>();
  const testAudioPlayback = new Map<string, { starts: number; active: number }>();
  const audio = new AudioEngine(
    bridge,
    preferences.value,
    (error) => log("warning", `音频播放失败：${String(error)}`),
    import.meta.env.VITE_RUSTYERA_TEST === "1" ? recordTestAudioPlayback : undefined,
  );
  bridge.setProjectProgressListener(handleProjectProgress);
  let compiledCacheTimer: number | undefined;
  let exportState: ExportState | undefined;
  let resumeCacheAfterProjectExport = false;
  let diagnosisState: DiagnosisState | undefined;
  let projectTitleCaptured = false;
  let diagnosisNotificationTimer: number | undefined;
  let logNotificationId = 0;
  let importBytes: Uint8Array | undefined;
  let importKind: Exclude<RuntimeStartKind, "new_game"> | undefined;
  let traditionalSaveImportBytes: Uint8Array | undefined;
  let pendingStart: RuntimeTestConfiguration["start"] = { type: "new_game" };
  let testClock: Date | undefined;
  let testEntropyState: bigint | undefined;
  let testMonotonicOrigin: { frontendMs: number; runtimeNs: number } | undefined;
  let lastTimeAdvanceNs: number | undefined;
  let nextEnvironmentRevision = 1;
  let startupAttemptSequence = 0;
  let startupProgressStage: ProjectProgressStage | undefined;
  let startupProgressStageStartedAtMs: number | undefined;
  let startupStartMessageId: string | undefined;
  let projectLoadStartedAt: number | undefined;
  let projectLoadElapsedTimer: number | undefined;
  let runtimeManifestSparse = false;
  let acceptingProjectProgress = false;
  let batchMediaDirty = false;
  let debugPausePending = false;
  let debugPauseWanted = false;
  let debugSurfacePauseActive = false;
  let debugSurfaceResumePending = false;
  let debugGrantRefreshNeeded = false;
  let debugVariableRefreshId = 0;
  const pendingDebugRequests = new Map<
    string,
    {
      grant: any;
      commandType: string | undefined;
      resolve?: (value: any) => void;
      reject?: (error: Error) => void;
    }
  >();
  const pendingGameInput = ref<PendingGameInput>();
  const pendingInputUndo = ref<PendingInputUndo>();
  const pendingProjectionMessages = new Set<string>();
  const runtimePump = new RuntimePumpCoordinator(bridge, {
    handleBatch,
    advanceTimedWait,
    handleError(error) {
      gameProgressLossConfirmation.value = null;
      failStartupTelemetry(error);
      finishProjectLoad();
      fault.value = { code: "frontend", message: String(error) };
      log("error", String(error), false, "none");
    },
  });

  const effectivePreferences = computed(() => previewPreferences.value ?? preferences.value);
  const configurationEntries = computed(() =>
    clientConfigurationEntries(projectConfiguration.value, bridge.kind),
  );
  const configurationReadOnly = computed(
    () =>
      projectConfiguration.value != null &&
      (!bridge.projectConfigurationWritable() ||
        !configurationProfileValid.value ||
        configurationMigrationFailed.value),
  );
  const configurationSessionOnly = computed(
    () =>
      projectConfiguration.value != null &&
      !bridge.projectConfigurationWritable() &&
      configurationProfileValid.value,
  );
  const configurationRestartPending = computed(
    () => projectConfiguration.value?.restart_pending ?? false,
  );
  const useMenu = computed(() => configurationBoolean("UseMenu", true));
  const useMouse = computed(() => configurationBoolean("UseMouse", true));
  const replaceFullWidthSpaces = computed(() =>
    configurationBoolean("ReplaceFullWidthSpaces", false),
  );
  const scrollHeight = computed(() => {
    const value = Number(configurationValue("ScrollHeight") ?? 1);
    return Number.isSafeInteger(value) ? Math.max(1, value) : 1;
  });
  const gameTextStyle = computed(() =>
    resolveGameTextStyle(
      effectivePreferences.value,
      presentation.lines,
      configurationValue("FontName"),
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

  function beginTransientStatus(owner: TransientStatusOwner, message: string): number {
    clearTransientStatus(owner);
    const token = ++transientStatusSequence;
    transientStatuses[owner] = { token, message };
    return token;
  }

  function updateTransientStatus(
    owner: TransientStatusOwner,
    token: number | undefined,
    message: string,
  ): void {
    const active = transientStatuses[owner];
    if (token == null || active?.token !== token) return;
    active.message = message;
  }

  function finishTransientStatus(
    owner: TransientStatusOwner,
    token: number | undefined,
    message?: string,
  ): void {
    const active = transientStatuses[owner];
    if (token == null || active?.token !== token) return;
    if (!message) {
      clearTransientStatus(owner, token);
      return;
    }
    active.message = message;
    active.timer = window.setTimeout(
      () => clearTransientStatus(owner, token),
      STATUS_FEEDBACK_DURATION_MS,
    );
  }

  function clearTransientStatus(owner: TransientStatusOwner, token?: number): void {
    const active = transientStatuses[owner];
    if (!active || (token != null && active.token !== token)) return;
    if (active.timer != null) window.clearTimeout(active.timer);
    delete transientStatuses[owner];
  }

  function resetTransientStatuses(): void {
    clearTransientStatus("settings");
    clearTransientStatus("compiled_cache");
    finishSettingsElapsedTimer();
  }

  async function initialize(): Promise<void> {
    // Host end-to-end tests must not inherit a developer's persisted font/image
    // preferences. Those values change Emuera geometry and made identical test
    // binaries report different image positions on different machines.
    preferences.value =
      import.meta.env.VITE_RUSTYERA_TEST === "1"
        ? defaultPreferences()
        : await bridge.loadPreferences();
    audio.setPreferences(preferences.value);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", sendClientState);
    window.addEventListener("focus", sendClientState);
    window.addEventListener("blur", sendClientState);
    window.addEventListener("resize", () => void projectViewport());
  }

  function configureTestRun(configuration: RuntimeTestConfiguration): void {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
      throw new Error("测试运行配置只能在 VITE_RUSTYERA_TEST 中使用");
    const { start } = configuration;
    if (start.type === "new_game") {
      if (!Number.isInteger(start.seed) || start.seed! < 0 || start.seed! > 0x7fff_ffff)
        throw new Error("new_game 测试必须提供非负 32 位 seed");
    } else if (!start.bytes?.length) {
      throw new Error(`${start.type} 测试必须提供状态文件`);
    }
    pendingStart = { ...start, bytes: start.bytes ? new Uint8Array(start.bytes) : undefined };
    testClock = configuration.clock
      ? new Date(configuration.clock)
      : new Date("2026-01-01T00:00:00Z");
    if (Number.isNaN(testClock.getTime())) throw new Error("测试 clock 不是有效日期");
    testEntropyState = BigInt(start.seed ?? 1) || 1n;
    testMonotonicOrigin = {
      frontendMs: performance.now(),
      runtimeNs: configuration.monotonicStartNs ?? 1_000_000,
    };
  }

  async function ensureSession(): Promise<void> {
    if (runtimePump.ready) return;
    if (bridge.kind === "tauri") await requestSystemFonts();
    const batch = await bridge.createSession(sessionOptions());
    runtimePump.setReady(true);
    await handleBatch(batch);
    schedulePump(0);
  }

  function openPreferencesFromUser(): void {
    preferencesOpen.value = true;
    void requestSystemFonts();
  }

  function openPreferencesFromRuntime(): void {
    preferencesOpen.value = true;
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
    acceptingProjectProgress = true;
    unlockAudioFromUserGesture();
    let currentSessionReplaced = false;
    let selectionSubmitted = false;
    try {
      const prepareAfterSelection = async () => {
        if (replaceCurrent) {
          currentSessionReplaced = true;
          await recreateSessionForProjectSelection();
        } else await ensureSession();
        baseStatus.value = "正在读取项目…";
      };
      const onSubmitted = (submittedAtMs: number) => {
        selectionSubmitted = true;
        beginStartupTelemetry(submittedAtMs, selection);
      };
      const metrics = await (selection === "file"
        ? bridge.openProjectFile(onSubmitted, prepareAfterSelection)
        : bridge.openProject(onSubmitted, prepareAfterSelection));
      if (!metrics) {
        finishProjectLoad();
        baseStatus.value = "已取消打开项目";
        return;
      }
      refreshProjectFontFamilies(metrics.projectFonts);
      projectOpen.value = true;
      activeProjectSelection = selection;
      if (!startupTelemetry.value) beginStartupTelemetry(metrics.submittedAtMs, selection);
      applyStartupBridgeMetrics(metrics);
      log(
        "info",
        `项目读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress(metrics.cacheImported);
      schedulePump(0);
    } catch (error) {
      if (selectionSubmitted) failStartupTelemetry(error);
      if (currentSessionReplaced) projectOpen.value = false;
      finishProjectLoad();
      baseStatus.value = String(error);
      log("error", baseStatus.value);
    } finally {
      projectSelecting.value = false;
      if (currentSessionReplaced) {
        runtimePump.setTransitioning(false);
        schedulePump(0);
      }
    }
  }

  async function recreateSessionForProjectSelection(): Promise<void> {
    runtimePump.setTransitioning(true);
    try {
      clearSessionTimers();
      resetSessionState(true);
      baseStatus.value = "正在创建新的 Runtime session…";
      unlockAudioFromUserGesture();
      await audio
        .synchronize([])
        .catch((error) => log("warning", `更换项目时停止音频失败：${String(error)}`));
      await runtimePump.waitUntilIdle();
      await cancelCompiledCacheExport();
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
    if (compiledCacheTimer != null) {
      window.clearTimeout(compiledCacheTimer);
      compiledCacheTimer = undefined;
    }
  }

  function schedulePump(delay = 16): void {
    runtimePump.schedule(delay);
  }

  async function handleBatch(batch: PumpBatch): Promise<void> {
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
        );
      else await handleDebug(event.message as any, event.correlationId);
      index += 1;
    }
    if (
      stagedPresentationReady ||
      (stagedPresentationCanFlushWhenIdle &&
        stagedPresentation &&
        !["more_work", "output_ready"].includes(batch.state))
    )
      batchMediaDirty = publishStagedPresentation() || batchMediaDirty;
    if (batchMediaDirty) await synchronizeMedia();
    if (debugGrantRefreshNeeded) {
      debugGrantRefreshNeeded = false;
      await requestDebugGrant();
    } else if (debugPauseWanted) {
      await requestPendingDebugPause();
    }
    await settlePendingGameInput();
  }

  async function handleRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
    suppressNotification = false,
  ): Promise<void> {
    const value = message.value;
    switch (message.type) {
      case "server_hello":
        configurationProfileValid.value = value.configuration_profile === bridge.kind;
        if (!configurationProfileValid.value)
          log("error", "Runtime 返回的设置宿主类别与当前客户端不一致，项目设置已停用");
        baseStatus.value = "Runtime 已就绪";
        break;
      case "project_load_report": {
        finishStartupProgressStage();
        if (startupTelemetry.value)
          startupTelemetry.value.milestones.runtimeValidationReportedMs = startupElapsedMs();
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
          "errors_only",
        );
        updateProjectConfiguration(value.configuration);
        await persistGeneratedConfiguration();
        if (value.success) {
          if (projectConfiguration.value) {
            try {
              await bridge.applyProjectConfiguration(
                configurationEntries.value,
                viewportChrome(currentGameViewportMeasurement()),
              );
            } catch (error) {
              log("warning", `客户端项目配置应用失败：${String(error)}`);
            }
          }
          await settleProjectViewport();
          completeStartupFrontendReadiness();
          baseStatus.value = PROJECT_STARTING_STATUS;
          finishProjectLoad();
          if (pendingStart.type === "new_game") {
            await send({
              type: "start",
              value: { mode: { type: "new_game", seed: pendingStart.seed ?? null } },
            });
          } else {
            await restoreState(pendingStart.type, pendingStart.bytes!);
          }
          if (!runtimeManifestSparse) scheduleCompiledCacheExport(1000);
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
          failStartupTelemetry("项目加载失败");
          finishProjectLoad();
          baseStatus.value = "项目加载失败，请查看日志";
        }
        break;
      }
      case "state_changed":
        phase.value = value.phase;
        if (value.phase === "faulted" || value.phase === "stopped")
          gameProgressLossConfirmation.value = null;
        if (
          startupTelemetry.value?.milestones.startSubmittedMs != null &&
          startupTelemetry.value.outcome === "loading" &&
          startupTelemetry.value.milestones.firstGamePhaseMs == null &&
          ["running", "waiting_input", "waiting_external"].includes(value.phase)
        ) {
          startupTelemetry.value.milestones.firstGamePhaseMs = startupElapsedMs();
          startupTelemetry.value.outcome = "success";
          startupStartMessageId = undefined;
          // Host-side work such as font registration may finish after Runtime has already
          // entered the game. The first game phase is the authoritative load boundary.
          finishProjectLoad();
          baseStatus.value = GAME_RUNNING_STATUS;
        }
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        if (value.phase === "faulted" || value.phase === "stopped") {
          const startupWasLoading = startupTelemetry.value?.outcome === "loading";
          failStartupTelemetry(`Runtime entered ${value.phase} during startup`);
          if (startupWasLoading) finishProjectLoad();
        }
        if (value.phase !== "debug_paused") debugStop.value = null;
        break;
      case "presentation_snapshot":
        batchMediaDirty = projectPresentationSnapshot(value) || batchMediaDirty;
        captureProjectTitle(currentPresentation());
        break;
      case "presentation_delta":
        try {
          batchMediaDirty = projectPresentationDelta(value) || batchMediaDirty;
          captureProjectTitle(currentPresentation());
        } catch (error) {
          stagedPresentation = undefined;
          stagedPresentationReady = false;
          stagedPresentationCanFlushWhenIdle = false;
          presentationStaged.value = false;
          log("warning", String(error));
          await send({ type: "resynchronize", value: { after_sequence: null } });
        }
        break;
      case "runtime_resynchronized":
        phase.value = value.phase;
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        batchMediaDirty = projectPresentationSnapshot(value.presentation) || batchMediaDirty;
        applyInputUndo(value.input_undo ?? null);
        updateProjectConfiguration(value.configuration);
        await persistGeneratedConfiguration();
        captureProjectTitle(currentPresentation());
        break;
      case "configuration_update_prepared": {
        const pending = pendingConfigurationUpdate;
        if (
          pending?.stage !== "preparing" ||
          String(pending.prepareMessageId) !== String(correlationId)
        ) {
          log("warning", "忽略了过期的项目配置保存响应");
          break;
        }
        let writeError: unknown;
        try {
          const prepared = parsePreparedConfiguration(value);
          if (!equalConfigurationIdentity(prepared, pending.snapshot))
            throw new Error("项目配置在保存前已经变化");
          const contentsDigest = blake3(new TextEncoder().encode(prepared.contents));
          if (
            contentsDigest.length !== prepared.prepared_source_digest.length ||
            !contentsDigest.every((byte, index) => byte === prepared.prepared_source_digest[index])
          )
            throw new Error("Runtime 返回的项目配置摘要无效");
          if (pending.sessionOnly && prepared.restart_required)
            throw new Error("项目文件仅支持当前会话内即时生效的设置");
          if (!pending.sessionOnly)
            await bridge.writeProjectConfiguration(
              prepared.expected_source_digest,
              prepared.contents,
            );
        } catch (error) {
          writeError = error;
        }
        await beginConfigurationFinalization(
          pending,
          writeError == null ? "commit" : "abort",
          writeError,
        );
        if (
          writeError == null &&
          !pending.automatic &&
          pendingConfigurationUpdate?.stage === "finalizing"
        )
          updateTransientStatus("settings", pending.statusToken, "正在应用项目配置…");
        break;
      }
      case "configuration_update_committed": {
        const pending = pendingConfigurationUpdate;
        if (
          pending?.stage !== "finalizing" ||
          String(pending.finalizeMessageId) !== String(correlationId)
        ) {
          log("warning", "忽略了过期的项目配置提交响应");
          break;
        }
        pendingConfigurationUpdate = undefined;
        updateProjectConfiguration(value.configuration);
        if (pending.outcome === "abort") {
          const error = new Error(`保存项目配置失败：${String(pending.writeError)}`);
          log("error", error.message);
          pending.reject(error);
          break;
        }
        if (!pending.automatic) {
          try {
            await bridge.applyProjectConfiguration(
              configurationEntries.value,
              viewportChrome(viewportMeasurement.value),
              pending.changedCodes,
            );
          } catch (error) {
            log("warning", `客户端项目配置应用失败：${String(error)}`);
          }
          updateTransientStatus("settings", pending.statusToken, "正在保存客户端偏好…");
          if (!pending.sessionOnly) await refreshCompiledCacheAfterConfigurationUpdate();
        }
        pending.resolve();
        break;
      }
      case "wait_changed":
        if (value.type === "opened" || value.type === "updated") {
          if (
            pendingGameInput.value &&
            pendingGameInput.value.waitIdentity !== inputWaitIdentity(value.value)
          )
            pendingGameInput.value.waitClosed = true;
          currentPresentation().inputWait = value.value;
          if (stagedPresentation) stagedPresentationReady = true;
        } else if (value.type === "closed") {
          currentPresentation().inputWait = null;
          if (pendingGameInput.value) pendingGameInput.value.waitClosed = true;
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
        await handleExportReady(value);
        break;
      case "state_export_chunk":
        await handleExportChunk(value);
        break;
      case "state_import_accepted":
        await handleImportAccepted(value);
        break;
      case "state_import_ready":
        if (!importKind) throw new Error("状态导入完成但没有待启动的状态类型");
        await send({
          type: "start",
          value: { mode: { type: importKind, transfer_id: value.transfer_id } },
        });
        importBytes = undefined;
        importKind = undefined;
        break;
      case "fault": {
        gameProgressLossConfirmation.value = null;
        const startupWasLoading = startupTelemetry.value?.outcome === "loading";
        failStartupTelemetry(value.message ?? "Runtime fault");
        if (startupWasLoading) finishProjectLoad();
        fault.value = value;
        log("error", formatRuntimeFault(value), true, "none");
        break;
      }
      case "diagnostic":
        log(value.level ?? "info", formatDiagnostic(value), true);
        if (
          value.code === "runtime.compiled_cache_ready" &&
          exportState?.kind === "compiled_cache" &&
          !exportState.descriptor
        ) {
          const activeExport = exportState;
          try {
            await requestCompiledCacheExport(activeExport);
          } catch (error) {
            await failCompiledCacheExport(activeExport, error);
          }
        } else if (
          value.code === "runtime.compiled_cache_failed" &&
          exportState?.kind === "compiled_cache" &&
          !exportState.descriptor
        ) {
          await failCompiledCacheExport(
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
        if (
          startupTelemetry.value?.outcome === "loading" &&
          String(correlationId) === startupStartMessageId
        ) {
          const message = String(value.message ?? "Runtime rejected startup");
          failStartupTelemetry(message);
          finishProjectLoad();
          baseStatus.value = `项目启动失败：${message}`;
        }
        const correlation = String(correlationId);
        const exportRejection = String(value.message ?? "");
        const activeExport = exportState;
        const compiledCachePreparing =
          activeExport?.kind === "compiled_cache" &&
          activeExport.requestMessageId === correlation &&
          (exportRejection.includes("compiled project cache preparation started") ||
            exportRejection.includes("compiled project cache is still being prepared"));
        const staleProjection =
          pendingProjectionMessages.delete(correlation) &&
          [
            "projection environment revision is not newer",
            "projection observation does not match the canonical presentation",
          ].includes(String(value.message ?? ""));
        const rejectedInput =
          pendingGameInput.value?.messageId === correlation ? pendingGameInput.value : undefined;
        const staleInput =
          rejectedInput != null &&
          ["input wait identity is stale", "no input is pending"].includes(
            String(value.message ?? ""),
          );
        const willRetryInput =
          staleInput && rejectedInput != null && rejectedInput.staleRetries === 0;
        if (willRetryInput) {
          rejectedInput.messageId = undefined;
          rejectedInput.retryPending = true;
          rejectedInput.waitClosed = false;
          rejectedInput.retryError = String(value.message ?? "Runtime 拒绝了输入");
        } else if (rejectedInput) {
          restoreButtons(currentPresentation(), rejectedInput.retiredButtonTokens);
          pendingGameInput.value = undefined;
        }
        if (pendingInputUndo.value?.messageId === correlation) pendingInputUndo.value = undefined;
        if (!staleProjection && !willRetryInput && !compiledCachePreparing)
          log("warning", formatDiagnostic(value), true);
        rejectPendingConfiguration(correlationId, value.message ?? "Runtime 拒绝了命令");
        const fullProjectPreparing =
          isFullProjectExport(activeExport) &&
          activeExport.requestMessageId === correlation &&
          (exportRejection.includes("full project preparation started") ||
            exportRejection.includes("full project is still being prepared"));
        if (fullProjectPreparing) {
          activeExport.requestMessageId = undefined;
          window.setTimeout(() => {
            if (exportState !== activeExport || exportState.descriptor) return;
            void requestFullProjectExport(activeExport);
          }, 50);
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
              await failCompiledCacheExport(exportState, message, "none");
            } else {
              exportState = undefined;
            }
            if (!projectFileFailed && !compiledCacheFailed) baseStatus.value = message;
            if (diagnosisExporting.value) void startDiagnosisSnapshot();
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

  async function synchronizeMedia(): Promise<void> {
    document.title = presentation.title || "RustyEra";
    try {
      await audio.synchronize(presentation.audio);
    } catch (error) {
      log("warning", `音频播放失败：${String(error)}`);
    }
  }

  function currentPresentation(): PresentationState {
    return stagedPresentation ?? presentation;
  }

  function clonePresentation(source: PresentationState): PresentationState {
    return structuredClone(toRaw(source));
  }

  function stagePresentation(): PresentationState {
    if (!stagedPresentation) {
      stagedPresentation = clonePresentation(presentation);
      stagedPresentationReady = false;
      stagedPresentationCanFlushWhenIdle = false;
      presentationStaged.value = true;
    }
    return stagedPresentation;
  }

  function publishStagedPresentation(): boolean {
    if (!stagedPresentation) return false;
    // Redraw-disabled map refreshes can delete and recreate their tail across separate deltas.
    // Compare the completed frame with the last published frame, not the staged intermediate
    // length, before deciding whether the viewport should follow new history to the bottom.
    if (stagedPresentation.lines.length <= presentation.lines.length)
      stagedPresentation.historyRevision = presentation.historyRevision;
    Object.assign(presentation, stagedPresentation);
    stagedPresentation = undefined;
    stagedPresentationReady = false;
    stagedPresentationCanFlushWhenIdle = false;
    presentationStaged.value = false;
    return true;
  }

  function projectPresentationSnapshot(snapshot: any): boolean {
    const next = clonePresentation(currentPresentation());
    applySnapshot(next, snapshot);
    if (next.redraw?.enabled === false && next.inputWait == null) {
      stagedPresentation = next;
      stagedPresentationReady = false;
      stagedPresentationCanFlushWhenIdle = false;
      presentationStaged.value = true;
      return false;
    }
    stagedPresentation = undefined;
    stagedPresentationReady = false;
    stagedPresentationCanFlushWhenIdle = false;
    presentationStaged.value = false;
    Object.assign(presentation, next);
    return true;
  }

  function projectPresentationDelta(delta: any): boolean {
    const operations = delta.operations ?? [];
    const disablesRedraw = operations.some(
      (operation: any) => operation.type === "set_redraw" && operation.redraw?.enabled === false,
    );
    const completesFrame = operations.some(
      (operation: any) =>
        (operation.type === "set_redraw" && operation.redraw?.enabled !== false) ||
        (operation.type === "set_input_wait" && operation.input_wait != null),
    );
    // CLEARLINE commonly lands in its own output batch between timed animation frames. Emuera
    // repaints the replacement immediately, but publishing that intermediate tail deletion lets
    // the browser paint an empty frame before the next zero-delay pump. Hold the previous frame
    // until replacement output, a wait/redraw boundary, or a genuinely idle runtime arrives.
    const startsTransientReplacement =
      presentation.inputWait == null &&
      !completesFrame &&
      operations.some((operation: any) =>
        ["clear", "delete_lines"].includes(String(operation.type)),
      );
    const shouldStage =
      stagedPresentation != null ||
      (presentation.redraw?.enabled === false && presentation.inputWait == null) ||
      disablesRedraw ||
      startsTransientReplacement;
    const target = shouldStage ? stagePresentation() : presentation;
    applyDelta(target, delta);
    if (target !== stagedPresentation) return true;
    if (disablesRedraw || target.redraw?.enabled === false)
      stagedPresentationCanFlushWhenIdle = false;
    else if (startsTransientReplacement) stagedPresentationCanFlushWhenIdle = true;
    if (completesFrame) stagedPresentationReady = true;
    return false;
  }

  function updateProjectConfiguration(value: unknown): void {
    if (value == null) {
      projectConfiguration.value = null;
      configurationMigrationFailed.value = false;
      audio.setGameVolume(1);
      return;
    }
    try {
      projectConfiguration.value = parseProjectConfiguration(value);
      if (projectConfiguration.value.generated_source == null)
        configurationMigrationFailed.value = false;
      const volume = Number(configurationValue("AudioVolume") ?? 100);
      audio.setGameVolume(Number.isFinite(volume) ? volume / 100 : 1);
    } catch (error) {
      projectConfiguration.value = null;
      log("error", `项目配置响应无效：${String(error)}`);
    }
  }

  async function persistGeneratedConfiguration(): Promise<void> {
    const snapshot = projectConfiguration.value;
    const source = snapshot?.generated_source;
    if (snapshot == null || source == null || !bridge.projectConfigurationWritable()) return;
    try {
      await bridge.writeProjectConfiguration(snapshot.source_digest, source);
      configurationMigrationFailed.value = true;
      if (pendingConfigurationUpdate == null) {
        const { completion } = await beginProjectConfigurationUpdate([], true);
        void completion.catch((error) => {
          configurationMigrationFailed.value = true;
          log("error", `确认 reraconfig.toml 迁移失败：${String(error)}`);
        });
      }
    } catch (error) {
      configurationMigrationFailed.value = true;
      log("error", `迁移 reraconfig.toml 失败：${String(error)}`);
      throw error;
    }
  }

  function configurationValue(code: string): string | undefined {
    return projectConfiguration.value?.entries.find((entry) => entry.code === code)
      ?.effective_value;
  }

  function configurationBoolean(code: string, fallback: boolean): boolean {
    const value = configurationValue(code)?.toUpperCase();
    if (value == null) return fallback;
    return value === "YES" || value === "TRUE" || value === "1";
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
    try {
      const query = decodeServicePayload(request.payload);
      const servicePresentation = currentPresentation();
      let response: Map<number, unknown>;
      switch (`${request.kind}/${request.operation}`) {
        case "entropy/random_seed": {
          if (testEntropyState != null) {
            testEntropyState =
              (testEntropyState * 6364136223846793005n + 1442695040888963407n) &
              0xffff_ffff_ffff_ffffn;
            response = mapOf([0, testEntropyState]);
          } else {
            const bytes = crypto.getRandomValues(new Uint32Array(2));
            response = mapOf([0, (BigInt(bytes[0]) << 32n) | BigInt(bytes[1])]);
          }
          break;
        }
        case "clock/local_date_time": {
          const now = testClock ?? new Date();
          response = mapOf(
            [0, now.getFullYear()],
            [1, now.getMonth() + 1],
            [2, now.getDate()],
            [3, now.getHours()],
            [4, now.getMinutes()],
            [5, now.getSeconds()],
            [6, now.getMilliseconds()],
            [7, -now.getTimezoneOffset()],
          );
          break;
        }
        case "input_state/get_key_state": {
          const code = Number(at(query, 0));
          response = mapOf([0, document.hasFocus()], [1, heldKeys.has(code)], [2, false]);
          break;
        }
        case "image/image_metadata": {
          const resource = String(at(query, 0));
          const metadata = await bridge.readImageMetadata(resource);
          response = mapOf(
            [0, metadata.width],
            [1, metadata.height],
            [2, metadata.format],
            [3, metadata.animated],
          );
          break;
        }
        case "image/image_pixel": {
          const resource = String(at(query, 0));
          const bitmap = await createImageBitmap(
            new Blob([(await bridge.readResource(resource)) as BlobPart]),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          const pixel = context.getImageData(Number(at(query, 2)), Number(at(query, 3)), 1, 1).data;
          response = mapOf([
            0,
            ((pixel[3] << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]) >>> 0,
          ]);
          bitmap.close();
          break;
        }
        case "canvas/decode_canvas_image": {
          const metadata = decodeImageMetadata(at(query, 0) as Uint8Array);
          response = mapOf([0, metadata.width], [1, metadata.height]);
          break;
        }
        case "presentation_query/get_display_line": {
          const index = Number(at(query, 1));
          response = mapOf(
            [0, at(query, 0)],
            [
              1,
              servicePresentation.lines[index] ? plainLine(servicePresentation.lines[index]) : "",
            ],
          );
          break;
        }
        case "presentation_query/html_get_printed_str": {
          const index = Number(at(query, 1));
          const text = servicePresentation.lines.at(-(index + 1));
          response = mapOf(
            [0, at(query, 0)],
            [
              1,
              text
                ? printedHtmlLine(text, Number(servicePresentation.settings.line_height ?? 0))
                : "",
            ],
          );
          break;
        }
        case "presentation_query/serialize_physical_history": {
          const body = servicePresentation.lines.map(plainLine).join("\n");
          response = mapOf(
            [0, at(query, 0)],
            [1, at(query, 2) ? body : `${at(query, 1)}\n\n${body}`],
          );
          break;
        }
        case "font_metrics/gget_text_size": {
          const text = String(at(query, 1));
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d")!;
          context.font = `${Number(at(query, 3)) / 1000}pt ${String(at(query, 2))}`;
          const metrics = context.measureText(text);
          response = mapOf(
            [0, at(query, 0)],
            [1, Math.ceil(metrics.width)],
            [2, Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)],
          );
          break;
        }
        default:
          throw new Error(`不支持的前端服务：${request.kind}/${request.operation}`);
      }
      await send(
        {
          type: "service_response",
          value: {
            request_id: request.request_id,
            result: { type: "ready", payload: [...encodeServicePayload(response)] },
          },
        },
        correlationId,
      );
    } catch (error) {
      await send(
        {
          type: "service_response",
          value: {
            request_id: request.request_id,
            result: {
              type: "error",
              error: {
                code: "frontend.unsupported_service",
                message: `${request.kind}/${request.operation}: ${String(error)}`,
              },
            },
          },
        },
        correlationId,
      );
    }
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
    if (!canInteract.value || !hasEnabledButton(currentPresentation().lines, token)) return;
    await submitIntent({ type: "activate", value: token }, false);
  }

  async function skip(): Promise<void> {
    const wait = currentPresentation().inputWait;
    if (canInteract.value && isMessageSkipWait(wait)) {
      await submitIntent(messageWaitIntent(wait), true);
    }
  }

  async function continueFromViewport(): Promise<void> {
    const wait = currentPresentation().inputWait;
    if (canInteract.value && isMessageContinuationWait(wait))
      await submitIntent(messageWaitIntent(wait), false);
  }

  async function submitIntent(intent: RuntimeInputIntent, messageSkip: boolean): Promise<void> {
    if (diagnosisExporting.value || pendingGameInput.value || pendingInputUndo.value) return;
    const wait = currentPresentation().inputWait;
    if (!wait) return;
    const waitIdentity = inputWaitIdentity(wait);
    const retiredButtonTokens = retireEnabledButtons(currentPresentation());
    pendingGameInput.value = {
      waitIdentity,
      waitId: String(wait.wait_id),
      waitKind: String(wait.kind),
      intent,
      messageSkip,
      staleRetries: 0,
      retiredButtonTokens,
    };
    try {
      const messageId = await send({
        type: "input",
        value: {
          wait_id: wait.wait_id,
          token: wait.submission_token,
          monotonic_time_ns: sampleMonotonicTime(),
          intent,
          message_skip: messageSkip,
        },
      });
      if (pendingGameInput.value?.waitIdentity === waitIdentity)
        pendingGameInput.value.messageId = String(messageId);
    } catch (error) {
      if (pendingGameInput.value?.waitIdentity === waitIdentity) {
        restoreButtons(currentPresentation(), retiredButtonTokens);
        pendingGameInput.value = undefined;
      }
      throw error;
    }
    if (singleStepEnabled.value && !debugStopToken(debugStop.value)) await pauseDebug();
  }

  async function settlePendingGameInput(): Promise<void> {
    const pending = pendingGameInput.value;
    if (!pending) return;
    if (!pending.retryPending) {
      if (pending.waitClosed) pendingGameInput.value = undefined;
      return;
    }
    const wait = currentPresentation().inputWait;
    if (!wait) {
      if (phase.value === "running") return;
      pendingGameInput.value = undefined;
      log("warning", pending.retryError ?? "Runtime 拒绝了输入", true);
      return;
    }
    const waitIdentity = inputWaitIdentity(wait);
    if (waitIdentity === pending.waitIdentity) return;
    if (String(wait.kind) !== pending.waitKind) {
      pendingGameInput.value = undefined;
      log("warning", pending.retryError ?? "Runtime 拒绝了输入", true);
      return;
    }
    pending.waitIdentity = waitIdentity;
    pending.waitId = String(wait.wait_id);
    pending.waitClosed = false;
    pending.retryPending = false;
    pending.retryError = undefined;
    pending.staleRetries = 1;
    try {
      const messageId = await send({
        type: "input",
        value: {
          wait_id: wait.wait_id,
          token: wait.submission_token,
          monotonic_time_ns: sampleMonotonicTime(),
          intent: pending.intent,
          message_skip: pending.messageSkip,
        },
      });
      if (pendingGameInput.value === pending) pending.messageId = String(messageId);
    } catch (error) {
      if (pendingGameInput.value === pending) pendingGameInput.value = undefined;
      throw error;
    }
  }

  async function advanceTimedWait(): Promise<void> {
    const wait = currentPresentation().inputWait;
    if (
      wait?.deadline_ns == null ||
      pendingGameInput.value != null ||
      pendingInputUndo.value != null
    )
      return;
    const now = sampleMonotonicTime();
    if (lastTimeAdvanceNs != null && now - lastTimeAdvanceNs < TIME_ADVANCE_INTERVAL_NS) return;
    lastTimeAdvanceNs = now;
    await send({ type: "advance_time", value: { monotonic_time_ns: now } });
  }

  function sampleMonotonicTime(): number {
    const frontendMs = performance.now();
    if (!testMonotonicOrigin) return Math.round(frontendMs * 1_000_000);
    return Math.round(
      testMonotonicOrigin.runtimeNs +
        Math.max(0, frontendMs - testMonotonicOrigin.frontendMs) * 1_000_000,
    );
  }

  async function undo(): Promise<void> {
    const token = inputUndo.value?.token;
    if (diagnosisExporting.value || !token || pendingGameInput.value || pendingInputUndo.value)
      return;
    const tokenIdentity = interactionTokenIdentity(token);
    pendingInputUndo.value = { tokenIdentity };
    try {
      const messageId = await send({ type: "input_undo_request", value: { token } });
      if (pendingInputUndo.value?.tokenIdentity === tokenIdentity)
        pendingInputUndo.value.messageId = String(messageId);
    } catch (error) {
      if (pendingInputUndo.value?.tokenIdentity === tokenIdentity)
        pendingInputUndo.value = undefined;
      throw error;
    }
  }

  async function restart(): Promise<void> {
    if (
      !projectOpen.value ||
      projectLoading.value ||
      runtimePump.transitioning ||
      diagnosisExporting.value
    )
      return;
    startupTelemetry.value = undefined;
    beginStartupTelemetry(performance.now(), activeProjectSelection);
    beginProjectLoad("正在创建新的 Runtime session…");
    runtimePump.setTransitioning(true);
    try {
      clearSessionTimers();
      resetSessionState(true);
      await runtimePump.waitUntilIdle();
      await cancelCompiledCacheExport();
      await audio
        .synchronize([])
        .catch((error) => log("warning", `重新开始时停止音频失败：${String(error)}`));
      resetSessionState();
      const batch = await bridge.createSession(sessionOptions());
      runtimePump.setReady(true);
      await handleBatch(batch);
      const metrics = await bridge.restartProject();
      refreshProjectFontFamilies(metrics.projectFonts);
      if (!startupTelemetry.value)
        beginStartupTelemetry(metrics.submittedAtMs, activeProjectSelection);
      applyStartupBridgeMetrics(metrics);
      log(
        "info",
        `项目重新读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress(metrics.cacheImported);
    } catch (error) {
      failStartupTelemetry(error);
      finishProjectLoad();
      const message = `重新开始失败：${String(error)}`;
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
    resetTransientStatuses();
    const compiledCacheExport =
      preserveCompiledCacheExport && exportState?.kind === "compiled_cache"
        ? exportState
        : undefined;
    if (exportState?.kind === "project_file")
      void finishProjectFileExport("failed", undefined, false);
    Object.assign(presentation, emptyPresentation());
    void audio.synchronize([]);
    testAudioPlayback.clear();
    stagedPresentation = undefined;
    stagedPresentationReady = false;
    stagedPresentationCanFlushWhenIdle = false;
    presentationStaged.value = false;
    runtimePump.setReady(false);
    phase.value = "negotiating";
    runtimeEpoch.value = 0;
    lastTimeAdvanceNs = undefined;
    inputUndo.value = null;
    fault.value = null;
    debugPausePending = false;
    debugPauseWanted = false;
    debugSurfacePauseActive = false;
    debugSurfaceResumePending = false;
    debugGrantRefreshNeeded = false;
    pendingDebugRequests.clear();
    debugEnabled.value = false;
    singleStepEnabled.value = false;
    debugGrant.value = null;
    debugStop.value = null;
    debugOutput.value = [];
    debugVariables.value = [];
    debugFibers.value = [];
    debugFrames.value = [];
    debugVariableValues.value = {};
    prompt.value = "";
    pendingGameInput.value = undefined;
    pendingInputUndo.value = undefined;
    pendingProjectionMessages.clear();
    exportState = compiledCacheExport;
    diagnosisState = undefined;
    projectTitleCaptured = false;
    diagnosisExporting.value = false;
    traditionalSaveDialogMode.value = null;
    traditionalSaveSlots.value = [];
    traditionalSaveImportName.value = "";
    traditionalSaveImportBytes = undefined;
    traditionalSaveTransferBusy.value = false;
    traditionalSaveTransferError.value = "";
    traditionalSaveOverwriteSlot.value = null;
    importBytes = undefined;
    importKind = undefined;
    projectConfiguration.value = null;
    runtimeManifestSparse = false;
    if (pendingConfigurationUpdate) {
      const pending = pendingConfigurationUpdate;
      pendingConfigurationUpdate = undefined;
      pending.reject(new Error("项目会话已重置，配置事务已取消"));
    }
    nextEnvironmentRevision = 1;
  }

  async function reloadProject(): Promise<void> {
    if (projectLoading.value || runtimePump.transitioning || diagnosisExporting.value) return;
    beginProjectLoad("正在重新加载项目…");
    runtimePump.setTransitioning(true);
    try {
      await runtimePump.waitUntilIdle();
      await cancelCompiledCacheExport();
      refreshProjectFontFamilies(await bridge.reloadProject());
      continueProjectBuildProgress();
    } catch (error) {
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
  }

  async function recoverFromFault(action: "title" | "reload"): Promise<void> {
    if (faultActionBusy.value || diagnosisExporting.value) return;
    faultActionBusy.value = true;
    fault.value = null;
    baseStatus.value = action === "title" ? "正在返回主菜单…" : "正在重启并重新编译…";
    try {
      if (action === "title") await returnToTitle();
      else await reloadProject();
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
    const projectName = diagnosisProjectName(projectTitleCaptured ? presentation.title : "project");
    const exportedAt = testClock ?? new Date();
    diagnosisState = {
      name: diagnosisArchiveName(projectName, exportedAt),
      projectName,
      logs: formatDiagnosisLogs(logs),
      exportedAt,
    };
    diagnosisExporting.value = true;
    showDiagnosisNotification("诊断信息导出中……", true);
    if (!exportState) await startDiagnosisSnapshot();
  }

  async function startDiagnosisSnapshot(): Promise<void> {
    if (!diagnosisState || !diagnosisExporting.value) return;
    exportState = {
      name: diagnosisState.name,
      kind: "diagnosis_snapshot",
      chunks: [],
      received: 0,
    };
    try {
      const messageId = await send({
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "diagnosis" },
      });
      if (exportState?.kind === "diagnosis_snapshot")
        exportState.requestMessageId = String(messageId);
    } catch (error) {
      if (exportState?.kind === "diagnosis_snapshot")
        await failDiagnosisExport(exportState, `诊断信息导出失败：${String(error)}`);
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
      importKind,
      importBytes: importBytes?.length ?? 0,
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
    const access = bridge.traditionalSaves;
    if (!access || !canManageTraditionalSaves.value) return;
    traditionalSaveDialogMode.value = mode;
    traditionalSaveSlots.value = [];
    traditionalSaveImportName.value = "";
    traditionalSaveImportBytes = undefined;
    traditionalSaveTransferError.value = "";
    traditionalSaveOverwriteSlot.value = null;
    traditionalSaveTransferBusy.value = true;
    try {
      traditionalSaveSlots.value = await access.listSlots();
    } catch (error) {
      traditionalSaveTransferError.value = `无法读取存档槽位：${String(error)}`;
    } finally {
      traditionalSaveTransferBusy.value = false;
    }
  }

  function closeTraditionalSaveDialog(): void {
    if (traditionalSaveTransferBusy.value) return;
    traditionalSaveDialogMode.value = null;
    traditionalSaveSlots.value = [];
    traditionalSaveImportName.value = "";
    traditionalSaveImportBytes = undefined;
    traditionalSaveTransferError.value = "";
    traditionalSaveOverwriteSlot.value = null;
  }

  async function pickTraditionalSaveImport(): Promise<void> {
    const access = bridge.traditionalSaves;
    if (
      !access ||
      traditionalSaveDialogMode.value !== "import" ||
      traditionalSaveTransferBusy.value
    )
      return;
    traditionalSaveTransferError.value = "";
    traditionalSaveTransferBusy.value = true;
    try {
      const selected = await access.pickImport();
      if (!selected) return;
      traditionalSaveImportName.value = selected.name;
      traditionalSaveImportBytes = selected.bytes;
      traditionalSaveOverwriteSlot.value = null;
    } catch (error) {
      traditionalSaveTransferError.value = `选择存档失败：${String(error)}`;
    } finally {
      traditionalSaveTransferBusy.value = false;
    }
  }

  async function confirmTraditionalSaveTransfer(slot: number): Promise<void> {
    const access = bridge.traditionalSaves;
    const selected = traditionalSaveSlots.value.find((entry) => entry.slot === slot);
    if (!access || !selected || traditionalSaveTransferBusy.value) return;
    traditionalSaveTransferError.value = "";
    traditionalSaveTransferBusy.value = true;
    try {
      if (traditionalSaveDialogMode.value === "export") {
        if (!selected.occupied) throw new Error("所选存档槽位为空");
        await access.exportSlot(slot);
        baseStatus.value = `已导出 ${saveSlotFileName(slot)}`;
        traditionalSaveTransferBusy.value = false;
        closeTraditionalSaveDialog();
        return;
      }
      if (traditionalSaveDialogMode.value !== "import") return;
      if (!traditionalSaveImportBytes) throw new Error("请先选择要导入的 .sav 存档文件");
      if (!/\.sav$/i.test(traditionalSaveImportName.value)) throw new Error("请选择 .sav 存档文件");
      await access.inspect(traditionalSaveImportBytes);
      traditionalSaveSlots.value = await access.listSlots();
      if (traditionalSaveSlots.value.find((entry) => entry.slot === slot)?.occupied) {
        traditionalSaveOverwriteSlot.value = slot;
        return;
      }
      await writeTraditionalSaveImport(slot);
    } catch (error) {
      traditionalSaveTransferError.value = `导入存档失败：${String(error)}`;
    } finally {
      traditionalSaveTransferBusy.value = false;
    }
  }

  function cancelTraditionalSaveOverwrite(): void {
    traditionalSaveOverwriteSlot.value = null;
  }

  async function confirmTraditionalSaveOverwrite(): Promise<void> {
    const slot = traditionalSaveOverwriteSlot.value;
    if (slot == null || traditionalSaveTransferBusy.value) return;
    traditionalSaveTransferBusy.value = true;
    traditionalSaveTransferError.value = "";
    try {
      await writeTraditionalSaveImport(slot);
    } catch (error) {
      traditionalSaveTransferError.value = `导入存档失败：${String(error)}`;
    } finally {
      traditionalSaveTransferBusy.value = false;
    }
  }

  async function writeTraditionalSaveImport(slot: number): Promise<void> {
    const access = bridge.traditionalSaves;
    if (!access || !traditionalSaveImportBytes) throw new Error("没有可导入的存档文件");
    await access.writeSlot(slot, traditionalSaveImportBytes);
    baseStatus.value = `已导入 ${saveSlotFileName(slot)}`;
    traditionalSaveTransferBusy.value = false;
    closeTraditionalSaveDialog();
  }

  async function beginCompiledCacheExport(): Promise<void> {
    if (exportState) return;
    const activeExport: ExportState = {
      name: "compiled-project.reracache",
      kind: "compiled_cache",
      chunks: [],
      received: 0,
    };
    exportState = activeExport;
    activeExport.statusToken = beginTransientStatus(
      "compiled_cache",
      "正在后台生成项目缓存，可继续游戏，但游戏运行和响应速度可能暂时受到影响…",
    );
    try {
      await requestCompiledCacheExport(activeExport);
    } catch (error) {
      await failCompiledCacheExport(activeExport, error);
    }
  }

  function scheduleCompiledCacheExport(delayMs = 0): void {
    if (compiledCacheTimer != null) return;
    compiledCacheTimer = window.setTimeout(() => {
      compiledCacheTimer = undefined;
      void beginCompiledCacheExport();
    }, delayMs);
  }

  async function refreshCompiledCacheAfterConfigurationUpdate(): Promise<void> {
    if (exportState?.kind === "compiled_cache") await cancelCompiledCacheExport();
    // A cache hit leaves Runtime with an intentionally sparse project manifest. It cannot rebuild
    // bytecode after a configuration edit; the host has already invalidated that cache, so the
    // next project load will materialize source and produce a replacement safely.
    if (runtimeManifestSparse) return;
    scheduleCompiledCacheExport();
  }

  async function exportProjectFile(): Promise<void> {
    if (!runtimeReady.value || gameInteractionsBlocked.value) return;
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
      resumeCacheAfterProjectExport = true;
      try {
        await cancelCompiledCacheExport();
      } catch (error) {
        await bridge.cancelProjectFileExport();
        throw error;
      }
    }
    projectFileExporting.value = true;
    projectFileExportProgress.value = { stage: "scanning", completed: 0, total: 0 };
    const activeExport: FullProjectExportState = {
      name,
      kind: "project_file",
      chunks: [],
      received: 0,
    };
    exportState = activeExport;
    baseStatus.value = "正在读取全量项目文件…";
    try {
      await bridge.stageFullProjectManifest();
      if (!projectFileExporting.value || exportState !== activeExport) return;
      await requestFullProjectExport(activeExport);
    } catch (error) {
      const cancelled = !projectFileExporting.value && exportState == null;
      await finishProjectFileExport(cancelled ? "cancelled" : "failed");
      if (cancelled) return;
      throw error;
    }
  }

  async function requestFullProjectExport(activeExport: FullProjectExportState): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "full_project_file", snapshot_purpose: "normal" },
    });
    if (exportState === activeExport) activeExport.requestMessageId = String(messageId);
  }

  async function requestCompiledCacheExport(activeExport: ExportState): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (exportState === activeExport) activeExport.requestMessageId = String(messageId);
  }

  async function handleExportReady(ready: any): Promise<void> {
    if (!exportState) return;
    if (ready.result.type !== "ready") {
      const message = `当前状态不能导出快照：${(ready.result.reasons ?? []).join(", ")}`;
      const activeExport = exportState;
      const failedKind = activeExport.kind;
      if (failedKind !== "compiled_cache") log("warning", message);
      if (failedKind.startsWith("diagnosis_")) {
        await failDiagnosisExport(exportState, message);
        return;
      }
      if (failedKind === "project_file") {
        await finishProjectFileExport("failed", message);
      } else if (failedKind === "compiled_cache") {
        await failCompiledCacheExport(activeExport, message);
      } else {
        exportState = undefined;
      }
      return;
    }
    exportState.descriptor = ready.result.transfer;
    const totalBytes = Number(ready.result.transfer.total_bytes);
    if (exportState.kind === "project_file") {
      projectFileExportProgress.value = { stage: "packaging", completed: 0, total: totalBytes };
    }
    if (
      exportState.kind !== "compiled_cache" &&
      exportState.kind !== "project_file" &&
      Number.isSafeInteger(totalBytes) &&
      totalBytes >= 0
    )
      exportState.buffer = new Uint8Array(totalBytes);
    const activeExport = exportState;
    try {
      await requestExportChunk();
    } catch (error) {
      if (activeExport.kind.startsWith("diagnosis_")) {
        await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
        return;
      }
      if (activeExport.kind === "compiled_cache") {
        await failCompiledCacheExport(activeExport, error);
        return;
      }
      throw error;
    }
  }

  async function requestExportChunk(): Promise<void> {
    if (!exportState?.descriptor) return;
    await send({
      type: "state_export_chunk_request",
      value: {
        transfer_id: exportState.descriptor.transfer_id,
        offset: exportState.received,
        maximum_bytes: 1024 * 1024,
      },
    });
  }

  async function handleExportChunk(chunk: any): Promise<void> {
    const activeExport = exportState;
    if (!activeExport?.descriptor || Number(chunk.offset) !== activeExport.received) return;
    const bytes = Uint8Array.from(chunk.data, (value: number | bigint) => Number(value));
    const reset = activeExport.received === 0;
    activeExport.received += bytes.length;
    if (activeExport.kind === "project_file") {
      projectFileExportProgress.value = {
        stage: "packaging",
        completed: activeExport.received,
        total: Number(activeExport.descriptor.total_bytes),
      };
    }
    try {
      if (activeExport.kind === "compiled_cache") {
        enqueueCompiledCacheWrite(activeExport, bytes, reset, chunk.complete);
      } else if (activeExport.kind === "project_file") {
        await bridge.writeProjectFileChunk(bytes, reset, chunk.complete);
      } else if (activeExport.buffer) {
        activeExport.buffer.set(bytes, Number(chunk.offset));
      } else {
        activeExport.chunks.push(bytes);
      }
    } catch (error) {
      if (activeExport.kind === "project_file") {
        await finishProjectFileExport("failed");
      } else if (activeExport.kind.startsWith("diagnosis_")) {
        await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
      } else if (activeExport.kind === "compiled_cache") {
        await failCompiledCacheExport(activeExport, error);
      } else {
        exportState = undefined;
      }
      if (activeExport.kind !== "compiled_cache" && !activeExport.kind.startsWith("diagnosis_"))
        throw error;
      return;
    }
    if (activeExport.kind === "compiled_cache") {
      continueCompiledCacheExport(activeExport, chunk.complete);
    } else {
      try {
        if (!chunk.complete) await requestExportChunk();
        else await finishExportTransfer(activeExport);
      } catch (error) {
        if (activeExport.kind.startsWith("diagnosis_")) {
          await failDiagnosisExport(activeExport, `诊断信息导出失败：${String(error)}`);
          return;
        }
        throw error;
      }
    }
  }

  function enqueueCompiledCacheWrite(
    activeExport: ExportState,
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): void {
    activeExport.hostWrite = (activeExport.hostWrite ?? Promise.resolve()).then(async () => {
      if (activeExport.hostWriteFailure) return;
      try {
        await bridge.writeCompiledCacheChunk(bytes, reset, complete);
      } catch (error) {
        activeExport.hostWriteFailure = { error };
      }
    });
  }

  function continueCompiledCacheExport(activeExport: ExportState, complete: boolean): void {
    void (async () => {
      await activeExport.hostWrite;
      if (exportState !== activeExport) return;
      if (activeExport.hostWriteFailure) throw activeExport.hostWriteFailure.error;
      if (complete) await finishExportTransfer(activeExport);
      else await requestExportChunk();
    })().catch((error) => {
      void failCompiledCacheExport(activeExport, error);
    });
  }

  async function failCompiledCacheExport(
    activeExport: ExportState,
    error: unknown,
    notificationPolicy: LogNotificationPolicy = "all",
  ): Promise<void> {
    if (exportState !== activeExport) return;
    finishCompiledCacheExport(activeExport, "failed");
    try {
      await bridge.cancelCompiledCacheExport();
    } catch (cancelError) {
      log("warning", `清理项目缓存失败：${String(cancelError)}`);
    }
    log("warning", `项目缓存生成失败：${String(error)}`, false, notificationPolicy);
  }

  function finishCompiledCacheExport(
    activeExport: ExportState,
    outcome: "success" | "cancelled" | "failed",
  ): void {
    if (exportState !== activeExport || activeExport.kind !== "compiled_cache") return;
    exportState = undefined;
    if (outcome === "success" && !projectLoading.value)
      finishTransientStatus("compiled_cache", activeExport.statusToken, "项目缓存已保存。");
    else clearTransientStatus("compiled_cache", activeExport.statusToken);
  }

  async function cancelCompiledCacheExport(): Promise<void> {
    const activeExport = exportState?.kind === "compiled_cache" ? exportState : undefined;
    if (activeExport) {
      finishCompiledCacheExport(activeExport, "cancelled");
      await activeExport.hostWrite;
    } else {
      clearTransientStatus("compiled_cache");
    }
    try {
      await send({ type: "state_export_cancel", value: { kind: "compiled_project_cache" } });
    } finally {
      await bridge.cancelCompiledCacheExport();
    }
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
    exportState = undefined;
    projectFileExporting.value = false;
    projectFileExportProgress.value = undefined;
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
    if (resumeCacheAfterProjectExport) scheduleCompiledCacheExport();
    resumeCacheAfterProjectExport = false;
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
        if (diagnosisExporting.value) await startDiagnosisSnapshot();
      } else if (completed.kind === "project_file") {
        await finishProjectFileExport("success", `已导出 ${completed.name}`);
      } else if (completed.kind === "compiled_cache") {
        finishCompiledCacheExport(completed, "success");
        if (diagnosisExporting.value) await startDiagnosisSnapshot();
      } else if (completed.kind === "diagnosis_snapshot") {
        if (!diagnosisState) throw new Error("诊断导出状态缺失");
        diagnosisState.snapshot = result;
        const activeExport: FullProjectExportState = {
          name: diagnosisState.name,
          kind: "diagnosis_project",
          chunks: [],
          received: 0,
        };
        exportState = activeExport;
        await bridge.stageFullProjectManifest();
        if (exportState === activeExport) await requestFullProjectExport(activeExport);
      } else {
        if (!diagnosisState?.snapshot) throw new Error("诊断快照缺失");
        const saved = await bridge.saveDiagnosis(diagnosisState.name, {
          projectName: diagnosisState.projectName,
          snapshot: diagnosisState.snapshot,
          logs: diagnosisState.logs,
          projectFile: result,
          exportedAt: diagnosisState.exportedAt,
        });
        finishDiagnosis(
          true,
          saved ? `诊断信息已导出：${diagnosisState.name}` : "已取消导出诊断信息",
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
          await failCompiledCacheExport(completed, error);
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
    diagnosisState = undefined;
    diagnosisExporting.value = false;
    baseStatus.value = message;
    showDiagnosisNotification(message, false);
    log(success ? "info" : "error", message);
  }

  async function failDiagnosisExport(activeExport: ExportState, message: string): Promise<void> {
    if (exportState !== activeExport || !activeExport.kind.startsWith("diagnosis_")) return;
    exportState = undefined;
    diagnosisState = undefined;
    if (activeExport.kind === "diagnosis_project") {
      if (activeExport.requestMessageId || activeExport.descriptor) {
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

  function captureProjectTitle(source: PresentationState = presentation): void {
    if (projectTitleCaptured || !projectOpen.value) return;
    const title = source.title.trim();
    if (!title || title === "RustyEra") return;
    projectTitleCaptured = true;
  }

  function showDiagnosisNotification(message: string, persistent: boolean): void {
    if (diagnosisNotificationTimer != null) window.clearTimeout(diagnosisNotificationTimer);
    diagnosisNotification.value = message;
    diagnosisNotificationTimer = undefined;
    if (!persistent)
      diagnosisNotificationTimer = window.setTimeout(() => {
        diagnosisNotification.value = "";
        diagnosisNotificationTimer = undefined;
      }, 5000);
  }

  async function restoreSnapshot(): Promise<void> {
    if (diagnosisExporting.value) return;
    const bytes = await bridge.openUpload();
    if (!bytes) return;
    await restoreState("vm_snapshot", bytes);
  }

  async function restoreState(
    kind: Exclude<RuntimeStartKind, "new_game">,
    bytes: Uint8Array,
  ): Promise<void> {
    importBytes = bytes;
    importKind = kind;
    await send({
      type: "state_import_begin",
      value: {
        kind,
        total_bytes: bytes.length,
        digest: blake3(bytes),
        artifact_id: null,
      },
    });
  }

  async function handleImportAccepted(value: any): Promise<void> {
    if (!importBytes) return;
    for (let offset = 0; offset < importBytes.length; offset += 1024 * 1024) {
      await send({
        type: "state_import_chunk",
        value: {
          transfer_id: value.transfer_id,
          offset,
          data: importBytes.slice(offset, offset + 1024 * 1024),
        },
      });
    }
    await send({ type: "state_import_commit", value: { transfer_id: value.transfer_id } });
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
      debugPausePending = false;
      debugPauseWanted = false;
      debugSurfacePauseActive = false;
      debugSurfaceResumePending = false;
      pendingDebugRequests.clear();
      debugEnabled.value = false;
      singleStepEnabled.value = false;
      debugGrant.value = null;
      debugStop.value = null;
    }
  }

  async function handleDebug(message: any, correlationId?: number | bigint): Promise<void> {
    if (message.type === "grant") {
      debugPausePending = false;
      debugGrantRefreshNeeded = false;
      debugGrant.value = message.value;
      debugEnabled.value = true;
      singleStepEnabled.value = false;
      debugStop.value = null;
    } else if (message.type === "revoke") {
      debugPausePending = false;
      debugPauseWanted = false;
      debugSurfacePauseActive = false;
      debugSurfaceResumePending = false;
      debugGrant.value = null;
      debugEnabled.value = false;
      singleStepEnabled.value = false;
      debugStop.value = null;
    } else if (message.type === "stopped") {
      debugPausePending = false;
      debugPauseWanted = false;
      debugStop.value = message.value;
      debugFibers.value = [];
      debugFrames.value = [];
      forgetDebugRequest(correlationId);
      // The stop token is authoritative only after this event. Start refreshing here so
      // dialog visibility cannot race a Vue watcher against the pause response. Pagination
      // must continue asynchronously because its later pages arrive in future pump batches.
      void refreshOpenDebugSurfaces().catch((error) => log("warning", String(error)));
      if (debugSurfaceResumePending && !singleStepEnabled.value) {
        debugSurfaceResumePending = false;
        void continueDebug().catch((error) => log("warning", String(error)));
      }
      if (singleStepEnabled.value && message.value?.reason?.type === "host_wait")
        void continueDebug(true).catch((error) => log("warning", String(error)));
    } else if (message.type === "response") {
      const request = forgetDebugRequest(correlationId);
      const response = message.value;
      debugStop.value = refreshDebugStop(debugStop.value, response.value);
      if (response.type === "variable_page") debugVariables.value = response.value.variables ?? [];
      else if (response.type === "variable_value") {
        debugVariableValues.value[debugVariableKey(response.value)] = formatDebugValue(
          response.value.value,
        );
      } else if (response.type === "fiber_page") {
        debugFibers.value = response.value.fibers ?? [];
        const selected = selectedDebugFiber(debugStop.value);
        const fiber =
          debugFibers.value.find((candidate) => candidate.fiber_id === selected) ??
          debugFibers.value.find((candidate) => candidate.frame_count > 0);
        if (stackOpen.value && fiber)
          await debugCommand({
            type: "read_call_stack",
            stop: debugStopToken(debugStop.value),
            fiber_id: fiber.fiber_id,
          });
      } else if (response.type === "call_stack") debugFrames.value = response.value.frames ?? [];
      else if (response.type === "console") {
        debugOutput.value.push(...(response.value.output ?? []));
        if (response.value.value != null)
          debugOutput.value.push(`=> ${formatDebugValue(response.value.value)}`);
        for (const diagnostic of response.value.diagnostics ?? []) {
          debugOutput.value.push(`[${diagnostic.code}] ${diagnostic.message}`);
        }
        for (const changed of response.value.changed_variables ?? []) {
          debugVariableValues.value[debugVariableKey(changed)] = formatDebugValue(changed.value);
        }
      }
      request?.resolve?.(response);
    } else if (message.type === "error") {
      const request = forgetDebugRequest(correlationId);
      if (request?.commandType === "pause") debugPausePending = false;
      if (debugEnabled.value && isStaleDebugGrantError(message.value)) {
        const currentToken = debugGrant.value?.token;
        if (!currentToken || !request || sameDebugGrant(request.grant, currentToken)) {
          debugGrant.value = null;
          debugStop.value = null;
          debugGrantRefreshNeeded = true;
        }
      } else {
        if (request?.commandType === "pause") {
          debugPauseWanted = false;
          debugSurfacePauseActive = false;
          debugSurfaceResumePending = false;
        }
        log("warning", message.value.message);
      }
      request?.reject?.(new Error(message.value.message ?? "debug request failed"));
    }
  }

  function forgetDebugRequest(correlationId?: number | bigint):
    | {
        grant: any;
        commandType: string | undefined;
        resolve?: (value: any) => void;
        reject?: (error: Error) => void;
      }
    | undefined {
    if (correlationId == null) return undefined;
    const key = String(correlationId);
    const request = pendingDebugRequests.get(key);
    pendingDebugRequests.delete(key);
    return request;
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
    pendingDebugRequests.set(String(messageId), { grant, commandType: command?.type });
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
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingDebugRequests.delete(String(messageId));
        reject(new Error(`debug ${command?.type ?? "request"} 超时`));
      }, timeoutMs);
      pendingDebugRequests.set(String(messageId), {
        grant,
        commandType: command?.type,
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      schedulePump(0);
    });
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
    debugPauseWanted = true;
    await requestPendingDebugPause();
  }

  async function requestPendingDebugPause(): Promise<void> {
    if (
      !debugPauseWanted ||
      !debugGrant.value ||
      debugStopToken(debugStop.value) ||
      debugPausePending ||
      !["running", "waiting_input", "waiting_external"].includes(phase.value)
    )
      return;
    debugPausePending = true;
    try {
      await debugCommand({ type: "pause" });
    } catch (error) {
      debugPausePending = false;
      throw error;
    }
  }

  async function openDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (diagnosisExporting.value) return;
    if (kind === "console") debugConsoleOpen.value = true;
    else if (kind === "variables") {
      variablesOpen.value = true;
      debugVariables.value = [];
      debugVariableValues.value = {};
    } else {
      stackOpen.value = true;
      debugFibers.value = [];
      debugFrames.value = [];
    }
    if (debugStopToken(debugStop.value)) await refreshOpenDebugSurfaces();
    else {
      debugSurfacePauseActive = true;
      debugSurfaceResumePending = false;
      await pauseDebug();
    }
  }

  async function closeDebugDialog(kind: "console" | "variables" | "stack"): Promise<void> {
    if (kind === "console") debugConsoleOpen.value = false;
    else if (kind === "variables") variablesOpen.value = false;
    else stackOpen.value = false;
    if (debugConsoleOpen.value || variablesOpen.value || stackOpen.value) return;
    if (!debugSurfacePauseActive) return;
    debugSurfacePauseActive = false;
    if (singleStepEnabled.value) return;
    if (debugStopToken(debugStop.value)) await continueDebug();
    else debugSurfaceResumePending = true;
  }

  async function refreshOpenDebugSurfaces(): Promise<void> {
    const stop = debugStopToken(debugStop.value);
    if (!stop) return;
    const commands = [debugCommand({ type: "list_fibers", stop, cursor: null, limit: 256 })];
    if (variablesOpen.value) commands.push(refreshDebugVariables(stop));
    await Promise.all(commands);
  }

  async function refreshDebugVariables(stop: any): Promise<void> {
    const refreshId = ++debugVariableRefreshId;
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
        refreshId === debugVariableRefreshId
      );
      if (refreshId === debugVariableRefreshId) debugVariables.value = variables;
    } finally {
      if (refreshId === debugVariableRefreshId) debugVariablesLoading.value = false;
    }
  }

  async function stepDebug(): Promise<void> {
    if (!singleStepEnabled.value || diagnosisExporting.value) return;
    const command = sourceLineStepCommand(debugStop.value);
    if (!command) return;
    const previousStop = debugStop.value;
    debugPauseWanted = false;
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
    debugPauseWanted = false;
    debugSurfacePauseActive = false;
    debugSurfaceResumePending = false;
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

  async function savePreferences(
    value: Preferences,
    changes: ProjectConfigurationChange[] = [],
    restartAfterApply = false,
  ): Promise<void> {
    if (settingsBusy.value) return;
    settingsBusy.value = true;
    settingsError.value = "";
    const statusToken = beginTransientStatus("settings", "正在保存设置…");
    startSettingsElapsedTimer(statusToken);
    let projectApplication: "persistent" | "session" | undefined;
    let preferencesSaved = false;
    try {
      if (changes.length) {
        if (restartAfterApply && configurationSessionOnly.value)
          throw new Error("项目文件的会话设置无法通过重启应用");
        projectApplication = await saveProjectConfiguration(changes, false, statusToken);
      }
      updateTransientStatus("settings", statusToken, "正在保存客户端偏好…");
      preferences.value = await bridge.savePreferences(value);
      preferencesSaved = true;
      previewPreferences.value = null;
      audio.setPreferences(preferences.value);
      if (restartAfterApply) {
        clearTransientStatus("settings", statusToken);
        preferencesOpen.value = false;
        await restart();
      } else {
        finishTransientStatus(
          "settings",
          statusToken,
          projectApplication === "session" ? "会话设置已应用；退出游戏后将丢失" : "设置已应用",
        );
      }
    } catch (error) {
      const message = preferencesSaved
        ? `设置已保存，但重新启动失败：${String(error)}`
        : projectApplication === "session"
          ? `会话设置已应用（退出游戏后将丢失），但客户端偏好保存失败：${String(error)}`
          : projectApplication === "persistent"
            ? `项目设置已应用，但客户端偏好保存失败：${String(error)}`
            : `设置未保存：${String(error)}`;
      updateTransientStatus("settings", statusToken, message);
      log("error", message);
      settingsError.value = message;
    } finally {
      settingsBusy.value = false;
      finishSettingsElapsedTimer();
    }
  }

  function startSettingsElapsedTimer(statusToken: number): void {
    settingsStartedAt = performance.now();
    settingsElapsedTimer = window.setInterval(() => {
      if (settingsStartedAt == null) return;
      const elapsed = Math.floor((performance.now() - settingsStartedAt) / 1000);
      if (elapsed < 1) return;
      const active = transientStatuses.settings;
      if (active?.token !== statusToken) return;
      active.message = `${active.message.replace(/ · 已等待 \d+ 秒$/, "")} · 已等待 ${elapsed} 秒`;
    }, 1000);
  }

  function finishSettingsElapsedTimer(): void {
    settingsStartedAt = undefined;
    if (settingsElapsedTimer != null) {
      window.clearInterval(settingsElapsedTimer);
      settingsElapsedTimer = undefined;
    }
  }

  async function saveProjectConfiguration(
    changes: ProjectConfigurationChange[],
    automatic = false,
    statusToken?: number,
  ): Promise<"persistent" | "session"> {
    const update = await beginProjectConfigurationUpdate(changes, automatic, statusToken);
    await update.completion;
    return update.application;
  }

  async function beginProjectConfigurationUpdate(
    changes: ProjectConfigurationChange[],
    automatic: boolean,
    statusToken?: number,
  ): Promise<{
    completion: Promise<void>;
    application: "persistent" | "session";
  }> {
    const snapshot = projectConfiguration.value;
    if (!snapshot || !configurationProfileValid.value)
      throw new Error(!snapshot ? "项目配置尚未加载" : "当前项目配置不可修改");
    const sessionOnly = !bridge.projectConfigurationWritable();
    if (
      sessionOnly &&
      changes.some((change) => {
        const entry = configurationEntries.value.find((item) => item.code === change.code);
        return !entry || entry.fixed || entry.application !== "hot";
      })
    )
      throw new Error("项目文件仅支持当前会话内即时生效的设置");
    if (pendingConfigurationUpdate) throw new Error("项目配置正在保存，请稍候");
    const prepareMessageId = await send({
      type: "prepare_configuration_update",
      value: prepareConfigurationUpdate(snapshot, changes),
    });
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    pendingConfigurationUpdate = {
      stage: "preparing",
      prepareMessageId,
      snapshot,
      changedCodes: changes.map((change) => change.code),
      sessionOnly,
      automatic,
      statusToken,
      resolve,
      reject,
    };
    if (!automatic) updateTransientStatus("settings", statusToken, "正在验证项目配置…");
    return { completion, application: sessionOnly ? "session" : "persistent" };
  }

  async function beginConfigurationFinalization(
    pending: Extract<PendingConfigurationUpdate, { stage: "preparing" }>,
    outcome: "commit" | "abort",
    writeError?: unknown,
  ): Promise<void> {
    try {
      const finalizeMessageId = await send({
        type: "finalize_configuration_update",
        value: { preparation_message_id: pending.prepareMessageId, outcome },
      });
      if (pendingConfigurationUpdate !== pending) return;
      pendingConfigurationUpdate = {
        ...pending,
        stage: "finalizing",
        finalizeMessageId,
        outcome,
        writeError,
      };
    } catch (error) {
      if (pendingConfigurationUpdate === pending) pendingConfigurationUpdate = undefined;
      pending.reject(new Error(`项目配置事务无法完成：${String(error)}`));
    }
  }

  function rejectPendingConfiguration(
    correlationId: number | bigint | undefined,
    message: string,
  ): void {
    const pending = pendingConfigurationUpdate;
    if (!pending || correlationId == null) return;
    const messageId =
      pending.stage === "preparing" ? pending.prepareMessageId : pending.finalizeMessageId;
    if (String(messageId) !== String(correlationId)) return;
    pendingConfigurationUpdate = undefined;
    const error = new Error(`项目配置未保存：${message}`);
    pending.reject(error);
  }

  function preview(value: Preferences | null): void {
    previewPreferences.value = value;
    audio.setPreferences(value ?? preferences.value);
  }

  async function projectViewport(measurement = currentGameViewportMeasurement()): Promise<void> {
    if (!measurement) return;
    viewportMeasurement.value = measurement;
    if (!runtimePump.ready) return;
    const messageId = await send({
      type: "projection_observation",
      value: {
        environment_revision: nextEnvironmentRevision,
        presentation_revision: presentation.revision,
        client_size: { width: measurement.width, height: measurement.height },
        projection_space_revision: nextEnvironmentRevision++,
        line_columns: measurement.lineColumns,
        text_box: prompt.value,
        transform: {
          x_numerator: 1,
          x_denominator: 1000,
          y_numerator: 1,
          y_denominator: 1000,
          origin_x: 0,
          origin_y: 0,
        },
      },
    });
    if (pendingProjectionMessages.size >= 256) pendingProjectionMessages.clear();
    pendingProjectionMessages.add(String(messageId));
  }

  function viewportChrome(measurement: GameViewportMeasurement | undefined): {
    width: number;
    height: number;
  } {
    return measurement
      ? { width: measurement.chromeWidth, height: measurement.chromeHeight }
      : { width: 0, height: 0 };
  }

  async function settleProjectViewport(): Promise<void> {
    await nextTick();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(finish, 100);
      requestAnimationFrame(finish);
    });
    await projectViewport();
  }

  async function sendClientState(): Promise<void> {
    if (!runtimePump.ready) return;
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
    if (startupStart) telemetry.milestones.startSubmittedMs = startupElapsedMs();
    const messageId = await bridge.submitRuntime(transportValue(message), correlationId);
    if (startupStart) startupStartMessageId = String(messageId);
    schedulePump(0);
    return messageId;
  }

  function inputWaitIdentity(wait: any): string {
    return `${String(wait.wait_id)}:${String(wait.submission_token?.epoch)}:${String(wait.submission_token?.id)}`;
  }

  function interactionTokenIdentity(token: any): string {
    return `${String(token?.epoch)}:${String(token?.id)}`;
  }

  function applyInputUndo(value: any): void {
    const nextIdentity = value?.token ? interactionTokenIdentity(value.token) : undefined;
    if (pendingInputUndo.value?.tokenIdentity !== nextIdentity) pendingInputUndo.value = undefined;
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
    appendLogEntries(
      [{ timestamp: new Date(), level, message, authoritative }],
      notificationPolicy,
    );
  }

  function appendLogEntries(
    entries: LogEntry[],
    notificationPolicy: LogNotificationPolicy = "all",
  ): void {
    const retained =
      entries.length > MAXIMUM_LOG_ENTRIES
        ? entries.slice(entries.length - MAXIMUM_LOG_ENTRIES)
        : entries;
    const overflow = Math.max(0, logs.length + retained.length - MAXIMUM_LOG_ENTRIES);
    if (overflow > 0) logs.splice(0, overflow);
    if (retained.length > 0) logs.push(...retained);
    if (notificationPolicy === "none") return;
    for (const entry of retained) {
      if (entry.level !== "error" && !(entry.level === "warning" && notificationPolicy === "all"))
        continue;
      logNotifications.push({
        id: ++logNotificationId,
        level: entry.level,
        message: entry.message,
      });
    }
    const notificationOverflow = Math.max(0, logNotifications.length - MAXIMUM_LOG_ENTRIES);
    if (notificationOverflow > 0) logNotifications.splice(0, notificationOverflow);
  }

  function dismissLogNotification(id: number): void {
    const index = logNotifications.findIndex((notification) => notification.id === id);
    if (index >= 0) logNotifications.splice(index, 1);
  }

  function beginProjectLoad(message: string): void {
    acceptingProjectProgress = true;
    projectLoading.value = true;
    projectProgress.value = undefined;
    baseStatus.value = message;
    startProjectLoadElapsedTimer();
  }

  function continueProjectBuildProgress(cacheImported = false): void {
    // Runtime can report project success before the host finishes post-submit work
    // (notably project-font registration). Never reopen an attempt that already settled.
    if (!acceptingProjectProgress) return;
    projectLoading.value = true;
    startProjectLoadElapsedTimer();
    if (
      projectProgress.value &&
      projectProgress.value.stage !== "importing" &&
      projectProgress.value.stage !== "scanning"
    )
      return;
    projectProgress.value = undefined;
    baseStatus.value = cacheImported
      ? "项目缓存命中，正在加载缓存…"
      : "项目文件读取完成，正在准备编译与校验…";
  }

  function showProjectLoadTransition(message: string): void {
    projectLoading.value = true;
    projectProgress.value = undefined;
    baseStatus.value = message;
    startProjectLoadElapsedTimer();
  }

  function finishProjectLoad(): void {
    acceptingProjectProgress = false;
    projectLoading.value = false;
    projectProgress.value = undefined;
    projectLoadElapsedSeconds.value = 0;
    projectLoadStartedAt = undefined;
    if (projectLoadElapsedTimer != null) {
      window.clearInterval(projectLoadElapsedTimer);
      projectLoadElapsedTimer = undefined;
    }
  }

  function handleProjectProgress(value: ProjectProgress): void {
    const progress = {
      stage: value.stage,
      completed: Number(value.completed),
      total: Number(value.total),
    } satisfies ProjectProgress;
    if (
      !Number.isSafeInteger(progress.completed) ||
      !Number.isSafeInteger(progress.total) ||
      progress.completed < 0 ||
      progress.total < 0
    )
      return;
    if (projectFileExporting.value) {
      projectFileExportProgress.value = progress;
      baseStatus.value = formatProjectProgress(progress);
      return;
    }
    if (!acceptingProjectProgress) return;
    projectLoading.value = true;
    startProjectLoadElapsedTimer();
    projectProgress.value = progress;
    recordStartupProgress(progress.stage);
    baseStatus.value = formatProjectProgress(progress);
  }

  function beginStartupTelemetry(submittedAtMs: number, selection: "directory" | "file"): void {
    startupProgressStage = undefined;
    startupProgressStageStartedAtMs = undefined;
    startupStartMessageId = undefined;
    startupTelemetry.value = {
      attemptId: ++startupAttemptSequence,
      client: bridge.kind,
      scenario: selection === "file" ? "project_file" : "cold",
      submittedAtMs,
      bridge: {
        quickScanMs: null,
        cacheReadMs: null,
        sourceReadMs: null,
        submitMs: null,
      },
      durations: {
        enumerateMs: null,
        statAndIndexReadMs: null,
        indexWriteMs: null,
        sourceReadDecodeHashMs: null,
        cacheReadMs: null,
        submissionTransferMs: null,
        cacheDecodeMs: null,
        parseMs: null,
        analyzeMs: null,
        compileMs: null,
        validateMs: null,
      },
      observedStages: {},
      milestones: {
        runtimeValidationReportedMs: null,
        frontendReadyToStartMs: null,
        startSubmittedMs: null,
        firstGamePhaseMs: null,
      },
      cacheHit: null,
      outcome: "loading",
      error: null,
    };
  }

  function applyStartupBridgeMetrics(metrics: ProjectOpenMetrics): void {
    const telemetry = startupTelemetry.value;
    if (!telemetry) return;
    telemetry.bridge = {
      quickScanMs: metrics.quickScanMs,
      cacheReadMs: metrics.cacheReadMs,
      sourceReadMs: metrics.sourceReadMs,
      submitMs: metrics.submitMs,
    };
  }

  function startupElapsedMs(): number {
    return performance.now() - (startupTelemetry.value?.submittedAtMs ?? performance.now());
  }

  function completeStartupFrontendReadiness(): void {
    const telemetry = startupTelemetry.value;
    if (!telemetry) return;
    telemetry.cacheHit ??= false;
    if (telemetry.scenario !== "project_file")
      telemetry.scenario = telemetry.cacheHit ? "warm" : "cold";
    telemetry.milestones.frontendReadyToStartMs = startupElapsedMs();
  }

  function failStartupTelemetry(error: unknown): void {
    if (!startupTelemetry.value || startupTelemetry.value.outcome !== "loading") return;
    finishStartupProgressStage();
    startupTelemetry.value.outcome = "failure";
    startupTelemetry.value.error = String(error);
    startupStartMessageId = undefined;
  }

  function recordStartupProgress(stage: ProjectProgressStage): void {
    const telemetry = startupTelemetry.value;
    if (!telemetry) return;
    if (startupProgressStage === stage) return;
    finishStartupProgressStage();
    startupProgressStage = stage;
    startupProgressStageStartedAtMs = startupElapsedMs();
  }

  function finishStartupProgressStage(): void {
    const telemetry = startupTelemetry.value;
    if (!telemetry || !startupProgressStage || startupProgressStageStartedAtMs == null) return;
    telemetry.observedStages[startupProgressStage] =
      (telemetry.observedStages[startupProgressStage] ?? 0) +
      startupElapsedMs() -
      startupProgressStageStartedAtMs;
    startupProgressStage = undefined;
    startupProgressStageStartedAtMs = undefined;
  }

  function startProjectLoadElapsedTimer(): void {
    if (projectLoadStartedAt == null) projectLoadStartedAt = performance.now();
    if (projectLoadElapsedTimer != null) return;
    projectLoadElapsedTimer = window.setInterval(() => {
      if (projectLoadStartedAt == null) return;
      projectLoadElapsedSeconds.value = Math.floor(
        (performance.now() - projectLoadStartedAt) / 1000,
      );
    }, 1000);
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
    presentation,
    preferences,
    configurationEntries,
    configurationReadOnly,
    configurationSessionOnly,
    configurationRestartPending,
    viewportMeasurement,
    useMenu,
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
    status,
    projectOpen,
    projectLoading,
    startupTelemetry,
    projectLoadProgressLabel,
    projectLoadProgressValue,
    openProjectConfirmationOpen,
    gameProgressLossConfirmation,
    prompt,
    inputUndo,
    fault,
    faultMessage,
    faultActionBusy,
    logs,
    preferencesOpen,
    settingsBusy,
    settingsError,
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
    projectFileExporting,
    projectFileExportProgressLabel,
    projectFileExportProgressValue,
    diagnosisNotification,
    logNotifications,
    traditionalSaveDialogMode,
    traditionalSaveSlots,
    traditionalSaveImportName,
    traditionalSaveTransferBusy,
    traditionalSaveTransferError,
    traditionalSaveOverwriteSlot,
    runtimeReady,
    canExportDiagnosis,
    canManageTraditionalSaves,
    gameInteractionsBlocked,
    canOpenProject,
    canStepDebug,
    canInteract,
    promptPlaceholder,
    openPreferencesFromUser,
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
    savePreferences,
    preview,
    shutdown,
    projectViewport,
    configureTestRun,
    restoreState,
    testTransferState,
    testAudioPlaybackState,
  };
});
