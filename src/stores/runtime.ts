import { blake3 } from "@noble/hashes/blake3.js";
import { defineStore } from "pinia";
import { computed, nextTick, reactive, ref, shallowReactive } from "vue";

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
import { MessageSkipController } from "@/core/messageSkip";
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
  plainLine,
  printedHtmlLine,
} from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  defaultPreferences,
  type InteractionToken,
  type Preferences,
  type ProjectConfigurationChange,
  type ProjectConfigurationSnapshot,
  type ProjectProgress,
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
import { transportValue } from "@/stores/runtimeTransport";

type LogEntry = DiagnosisLogEntry & { authoritative: boolean };

interface ExportState {
  name: string;
  kind:
    "download" | "project_file" | "compiled_cache" | "diagnosis_snapshot" | "diagnosis_artifact";
  chunks: Uint8Array[];
  buffer?: Uint8Array;
  received: number;
  descriptor?: any;
  requestMessageId?: string;
}

interface DiagnosisState {
  name: string;
  projectName: string;
  logs: string;
  exportedAt: Date;
  snapshot?: Uint8Array;
}

interface PendingConfigurationBase {
  snapshot: ProjectConfigurationSnapshot;
  changedCodes: string[];
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

const DEBUG_VARIABLE_PAGE_LIMIT = 256;
const DEBUG_VARIABLE_MAX_PAGES = 16;
const TIME_ADVANCE_INTERVAL_NS = 16_000_000;

export const useRuntimeStore = defineStore("runtime", () => {
  const bridge = platformBridge();
  const presentation = reactive(emptyPresentation());
  const preferences = ref<Preferences>(defaultPreferences());
  const projectConfiguration = ref<ProjectConfigurationSnapshot | null>(null);
  let pendingConfigurationUpdate: PendingConfigurationUpdate | undefined;
  const configurationProfileValid = ref(true);
  const viewportMeasurement = ref<GameViewportMeasurement>();
  const previewPreferences = ref<Preferences | null>(null);
  const fonts = ref<string[]>(["system-ui", "sans-serif", "serif", "monospace"]);
  const phase = ref("negotiating");
  const runtimeEpoch = ref<number | bigint>(0);
  const status = ref("请选择 Era 项目文件夹");
  const projectOpen = ref(false);
  const projectLoading = ref(false);
  const projectSelecting = ref(false);
  const projectProgress = ref<ProjectProgress>();
  const projectLoadElapsedSeconds = ref(0);
  const openProjectConfirmationOpen = ref(false);
  let pendingProjectSelection: "directory" | "file" = "directory";
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
  const traditionalSaveDialogMode = ref<"export" | "import" | null>(null);
  const traditionalSaveSlots = ref<TraditionalSaveSlot[]>([]);
  const traditionalSaveImportName = ref("");
  const traditionalSaveTransferBusy = ref(false);
  const traditionalSaveTransferError = ref("");
  const traditionalSaveOverwriteSlot = ref<number | null>(null);
  const heldKeys = new Set<number>();
  const audio = new AudioEngine(bridge, preferences.value);
  bridge.setProjectProgressListener(handleProjectProgress);
  let compiledCacheTimer: number | undefined;
  let exportState: ExportState | undefined;
  let diagnosisState: DiagnosisState | undefined;
  let projectTitleCaptured = false;
  let diagnosisNotificationTimer: number | undefined;
  let importBytes: Uint8Array | undefined;
  let importKind: Exclude<RuntimeStartKind, "new_game"> | undefined;
  let traditionalSaveImportBytes: Uint8Array | undefined;
  let pendingStart: RuntimeTestConfiguration["start"] = { type: "new_game" };
  let testClock: Date | undefined;
  let testEntropyState: bigint | undefined;
  let testMonotonicOrigin: { frontendMs: number; runtimeNs: number } | undefined;
  let lastTimeAdvanceNs: number | undefined;
  let nextEnvironmentRevision = 1;
  let projectRuntimeStartedAt: number | undefined;
  let projectLoadStartedAt: number | undefined;
  let projectLoadElapsedTimer: number | undefined;
  let projectUsedCompiledCache = false;
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
  const messageSkip = new MessageSkipController();
  const runtimePump = new RuntimePumpCoordinator(bridge, {
    handleBatch,
    advanceTimedWait,
    handleError(error) {
      finishProjectLoad();
      fault.value = { code: "frontend", message: String(error) };
      log("error", String(error));
    },
  });

  const effectivePreferences = computed(() => previewPreferences.value ?? preferences.value);
  const configurationEntries = computed(() =>
    clientConfigurationEntries(projectConfiguration.value, bridge.kind),
  );
  const configurationReadOnly = computed(
    () =>
      projectConfiguration.value != null &&
      (!bridge.projectConfigurationWritable() || !configurationProfileValid.value),
  );
  const configurationRestartPending = computed(
    () => projectConfiguration.value?.restart_pending ?? false,
  );
  const useMenu = computed(() => configurationBoolean("UseMenu", true));
  const useMouse = computed(() => configurationBoolean("UseMouse", true));
  const scrollHeight = computed(() => {
    const value = Number(configurationValue("ScrollHeight") ?? 1);
    return Number.isSafeInteger(value) ? Math.max(1, value) : 1;
  });
  const gameTextStyle = computed(() =>
    resolveGameTextStyle(effectivePreferences.value, presentation.lines),
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
      presentation.inputWait != null &&
      phase.value !== "debug_paused" &&
      !fault.value &&
      !diagnosisExporting.value &&
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
    () => diagnosisExporting.value || traditionalSaveDialogMode.value != null,
  );
  const canOpenProject = computed(
    () => !projectSelecting.value && !projectLoading.value && !diagnosisExporting.value,
  );
  const projectLoadProgressLabel = computed(() => {
    if (!projectLoading.value) return "";
    const label = projectProgress.value
      ? formatProjectProgress(projectProgress.value)
      : status.value;
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
    try {
      fonts.value = await bridge.listFonts();
    } catch (error) {
      log("warning", `无法读取系统字体：${String(error)}`);
    }
    const batch = await bridge.createSession(sessionOptions());
    runtimePump.setReady(true);
    await handleBatch(batch);
    schedulePump(0);
  }

  function sessionOptions(): SessionOptions {
    return {
      clientName: bridge.kind === "tauri" ? "rustyera-vue-tauri" : "rustyera-vue-wasm",
      // Vue wraps assigned arrays in proxies, which cannot cross the browser Worker boundary.
      availableFonts: [...fonts.value],
      preferredLocales: [...preferredRuntimeLocales(navigator.languages)],
      audioAvailable: true,
      debugScopeMask: 1023,
      maximumEnvelopeBytes: 512 * 1024 * 1024,
      configurationProfile: bridge.kind,
    };
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
    try {
      if (replaceCurrent) await recreateSessionForProjectSelection();
      else {
        await audio.unlock();
        await ensureSession();
      }
      status.value = "正在读取项目…";
      const metrics = await (selection === "file"
        ? bridge.openProjectFile()
        : bridge.openProject());
      if (!metrics) {
        if (replaceCurrent) projectOpen.value = false;
        finishProjectLoad();
        status.value = "已取消打开项目";
        return;
      }
      projectOpen.value = true;
      projectUsedCompiledCache = metrics.cacheImported;
      projectRuntimeStartedAt = performance.now();
      log(
        "info",
        `项目读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress();
      schedulePump(0);
    } catch (error) {
      if (replaceCurrent) projectOpen.value = false;
      finishProjectLoad();
      status.value = String(error);
      log("error", status.value);
    } finally {
      projectSelecting.value = false;
      if (replaceCurrent) {
        runtimePump.setTransitioning(false);
        schedulePump(0);
      }
    }
  }

  async function recreateSessionForProjectSelection(): Promise<void> {
    runtimePump.setTransitioning(true);
    clearSessionTimers();
    resetMessageSkip();
    resetSessionState();
    status.value = "正在创建新的 Runtime session…";
    await audio.unlock();
    await audio
      .synchronize([])
      .catch((error) => log("warning", `更换项目时停止音频失败：${String(error)}`));
    await runtimePump.waitUntilIdle();
    // A pump already in flight may have projected stale events after the immediate clear.
    resetSessionState();
    const batch = await bridge.createSession(sessionOptions());
    runtimePump.setReady(true);
    await handleBatch(batch);
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
        await handleRuntime(event.message as RuntimeMessage, event.correlationId);
      else await handleDebug(event.message as any, event.correlationId);
      index += 1;
    }
    if (batchMediaDirty) await synchronizeMedia();
    if (debugGrantRefreshNeeded) {
      debugGrantRefreshNeeded = false;
      await requestDebugGrant();
    } else if (debugPauseWanted) {
      await requestPendingDebugPause();
    }
    await continueMessageSkip();
  }

  async function handleRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
  ): Promise<void> {
    const value = message.value;
    switch (message.type) {
      case "server_hello":
        configurationProfileValid.value = value.configuration_profile === bridge.kind;
        if (!configurationProfileValid.value)
          log("error", "Runtime 返回的设置宿主类别与当前客户端不一致，项目设置已停用");
        status.value = "Runtime 已就绪";
        break;
      case "project_load_report":
        if (projectRuntimeStartedAt != null) {
          log(
            "info",
            `Runtime 加载阶段 ${(performance.now() - projectRuntimeStartedAt).toFixed(0)} ms`,
          );
          projectRuntimeStartedAt = undefined;
        }
        for (const diagnostic of value.diagnostics ?? []) {
          log(diagnostic.level ?? "info", formatDiagnostic(diagnostic), true);
        }
        updateProjectConfiguration(value.configuration);
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
          status.value = "项目编译完成";
          finishProjectLoad();
          if (pendingStart.type === "new_game") {
            await send({
              type: "start",
              value: { mode: { type: "new_game", seed: pendingStart.seed ?? null } },
            });
          } else {
            await restoreState(pendingStart.type, pendingStart.bytes!);
          }
          if (!projectUsedCompiledCache)
            compiledCacheTimer = window.setTimeout(() => {
              compiledCacheTimer = undefined;
              void beginCompiledCacheExport().catch((error) => {
                exportState = undefined;
                log("warning", `项目文件生成失败：${String(error)}`);
              });
            }, 1000);
        } else if (value.payload_required) {
          showProjectLoadTransition("项目文件缓存未命中，正在读取项目源码…");
          projectUsedCompiledCache = false;
          projectRuntimeStartedAt = performance.now();
          await bridge.submitProjectSource();
          continueProjectBuildProgress();
          schedulePump(0);
        } else {
          finishProjectLoad();
          status.value = "项目加载失败，请查看日志";
        }
        break;
      case "state_changed":
        phase.value = value.phase;
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        if (value.phase !== "debug_paused") debugStop.value = null;
        break;
      case "presentation_snapshot":
        applySnapshot(presentation, value);
        captureProjectTitle();
        batchMediaDirty = true;
        break;
      case "presentation_delta":
        try {
          applyDelta(presentation, value);
          captureProjectTitle();
        } catch (error) {
          log("warning", String(error));
          await send({ type: "resynchronize", value: { after_sequence: null } });
        }
        batchMediaDirty = true;
        break;
      case "runtime_resynchronized":
        phase.value = value.phase;
        runtimeEpoch.value = value.epoch ?? runtimeEpoch.value;
        applySnapshot(presentation, value.presentation);
        inputUndo.value = value.input_undo ?? null;
        updateProjectConfiguration(value.configuration);
        captureProjectTitle();
        batchMediaDirty = true;
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
        if (writeError == null && pendingConfigurationUpdate?.stage === "finalizing")
          status.value = "正在应用项目配置…";
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
          status.value = error.message;
          log("error", error.message);
          pending.reject(error);
          break;
        }
        try {
          await bridge.applyProjectConfiguration(
            configurationEntries.value,
            viewportChrome(viewportMeasurement.value),
            pending.changedCodes,
          );
        } catch (error) {
          log("warning", `客户端项目配置应用失败：${String(error)}`);
        }
        status.value = "项目配置已应用";
        pending.resolve();
        break;
      }
      case "wait_changed":
        if (value.type === "opened" || value.type === "updated")
          presentation.inputWait = value.value;
        else if (value.type === "closed") presentation.inputWait = null;
        break;
      case "input_undo_state_changed":
        inputUndo.value = value;
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
      case "fault":
        fault.value = value;
        log("error", value.message ?? "Runtime fault", true);
        break;
      case "diagnostic":
        log(value.level ?? "info", `[${value.code}] ${value.message}`, true);
        if (
          value.code === "runtime.compiled_cache_ready" &&
          (exportState?.kind === "compiled_cache" ||
            exportState?.kind === "project_file" ||
            exportState?.kind === "diagnosis_artifact") &&
          !exportState.descriptor
        )
          await (exportState.kind === "diagnosis_artifact"
            ? requestDiagnosisArtifact()
            : exportState.kind === "project_file"
              ? requestProjectFileExport()
              : requestCompiledCacheExport());
        break;
      case "log":
        if (!isRecoverableStaleDebugLog(value.message))
          log(value.level ?? "info", value.message, true);
        break;
      case "command_rejected":
        log("warning", value.message ?? "Runtime 拒绝了命令", true);
        rejectPendingConfiguration(correlationId, value.message ?? "Runtime 拒绝了命令");
        if (
          exportState?.requestMessageId === String(correlationId) &&
          !String(value.message ?? "").includes("compiled project cache preparation started") &&
          !String(value.message ?? "").includes("compiled project cache is still being prepared")
        ) {
          const message = `状态导出被 Runtime 拒绝：${value.message ?? "未知原因"}`;
          if (exportState.kind.startsWith("diagnosis_")) finishDiagnosis(false, message);
          else {
            if (exportState.kind === "project_file") await bridge.cancelProjectFileExport();
            exportState = undefined;
            status.value = message;
            if (diagnosisExporting.value) void startDiagnosisSnapshot();
          }
        }
        break;
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

  function updateProjectConfiguration(value: unknown): void {
    if (value == null) {
      projectConfiguration.value = null;
      return;
    }
    try {
      projectConfiguration.value = parseProjectConfiguration(value);
    } catch (error) {
      projectConfiguration.value = null;
      log("error", `项目配置响应无效：${String(error)}`);
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
        else if (kind.type === "open_configuration") preferencesOpen.value = true;
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
        case "presentation_query/get_display_line": {
          const index = Number(at(query, 1));
          response = mapOf(
            [0, at(query, 0)],
            [1, presentation.lines[index] ? plainLine(presentation.lines[index]) : ""],
          );
          break;
        }
        case "presentation_query/html_get_printed_str": {
          const index = Number(at(query, 1));
          const text = presentation.lines.at(-(index + 1));
          response = mapOf(
            [0, at(query, 0)],
            [1, text ? printedHtmlLine(text, Number(presentation.settings.line_height ?? 0)) : ""],
          );
          break;
        }
        case "presentation_query/serialize_physical_history": {
          const body = presentation.lines.map(plainLine).join("\n");
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
    const wait = presentation.inputWait;
    if (!wait || !canInteract.value) return;
    let intent: any;
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
    if (!canInteract.value) return;
    await submitIntent({ type: "activate", value: token }, false);
  }

  async function skip(): Promise<void> {
    const wait = presentation.inputWait;
    if (canInteract.value && messageSkip.start(wait)) {
      await submitIntent({ type: "enter" }, true);
    }
  }

  async function continueFromViewport(): Promise<void> {
    if (canInteract.value && presentation.inputWait?.kind === "enter_key") {
      await submitIntent({ type: "enter" }, false);
    }
  }

  async function submitIntent(intent: any, messageSkip: boolean): Promise<void> {
    if (diagnosisExporting.value) return;
    const wait = presentation.inputWait;
    if (!wait) return;
    if (!messageSkip) resetMessageSkip();
    await send({
      type: "input",
      value: {
        wait_id: wait.wait_id,
        token: wait.submission_token,
        monotonic_time_ns: sampleMonotonicTime(),
        intent,
        message_skip: messageSkip,
      },
    });
    if (singleStepEnabled.value && !debugStopToken(debugStop.value)) await pauseDebug();
  }

  async function continueMessageSkip(): Promise<void> {
    const wait = presentation.inputWait;
    if (messageSkip.continue(wait)) await submitIntent({ type: "enter" }, true);
  }

  async function advanceTimedWait(): Promise<void> {
    if (presentation.inputWait?.deadline_ns == null) return;
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

  function resetMessageSkip(): void {
    messageSkip.cancel();
  }

  async function undo(): Promise<void> {
    if (!diagnosisExporting.value && inputUndo.value?.token)
      await send({ type: "input_undo_request", value: { token: inputUndo.value.token } });
  }

  async function restart(): Promise<void> {
    if (
      !projectOpen.value ||
      projectLoading.value ||
      runtimePump.transitioning ||
      diagnosisExporting.value
    )
      return;
    beginProjectLoad("正在创建新的 Runtime session…");
    runtimePump.setTransitioning(true);
    clearSessionTimers();
    await runtimePump.waitUntilIdle();
    resetMessageSkip();
    await audio
      .synchronize([])
      .catch((error) => log("warning", `重新开始时停止音频失败：${String(error)}`));
    resetSessionState();
    try {
      const batch = await bridge.createSession(sessionOptions());
      runtimePump.setReady(true);
      await handleBatch(batch);
      projectRuntimeStartedAt = performance.now();
      const metrics = await bridge.restartProject();
      projectUsedCompiledCache = metrics.cacheImported;
      log(
        "info",
        `项目重新读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入项目文件）" : "（冷编译）"}`,
      );
      continueProjectBuildProgress();
    } catch (error) {
      finishProjectLoad();
      const message = `重新开始失败：${String(error)}`;
      status.value = message;
      log("error", message);
    } finally {
      runtimePump.setTransitioning(false);
      schedulePump(0);
    }
  }

  async function returnToTitle(): Promise<void> {
    if (diagnosisExporting.value) return;
    resetMessageSkip();
    await send({ type: "return_to_title", value: {} });
  }

  function resetSessionState(): void {
    if (exportState?.kind === "project_file")
      void bridge
        .cancelProjectFileExport()
        .catch((error) => log("warning", `清理项目文件导出失败：${String(error)}`));
    Object.assign(presentation, emptyPresentation());
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
    exportState = undefined;
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
    try {
      await bridge.reloadProject();
      continueProjectBuildProgress();
      schedulePump(0);
    } catch (error) {
      finishProjectLoad();
      const message = `重新加载项目失败：${String(error)}`;
      status.value = message;
      log("error", message);
    }
  }

  function dismissFault(): void {
    fault.value = null;
  }

  async function recoverFromFault(action: "title" | "reload"): Promise<void> {
    if (faultActionBusy.value || diagnosisExporting.value) return;
    faultActionBusy.value = true;
    fault.value = null;
    status.value = action === "title" ? "正在返回主菜单…" : "正在重启并重新编译…";
    try {
      if (action === "title") await returnToTitle();
      else await reloadProject();
    } catch (error) {
      const message = `错误恢复失败：${String(error)}`;
      fault.value = { code: "frontend.recovery_failed", message };
      status.value = message;
      log("error", message);
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
      finishDiagnosis(false, `诊断信息导出失败：${String(error)}`);
    }
  }

  async function exportSnapshot(purpose: "normal" | "debug" = "normal"): Promise<void> {
    if (diagnosisExporting.value) return;
    if (exportState) {
      status.value = "另一项状态导出仍在进行，请稍后重试";
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
        status.value = `已导出 ${saveSlotFileName(slot)}`;
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
    status.value = `已导入 ${saveSlotFileName(slot)}`;
    traditionalSaveTransferBusy.value = false;
    closeTraditionalSaveDialog();
  }

  async function beginCompiledCacheExport(): Promise<void> {
    if (exportState) return;
    exportState = {
      name: "compiled-project.reraproj",
      kind: "compiled_cache",
      chunks: [],
      received: 0,
    };
    status.value = "正在后台生成项目文件…";
    await requestCompiledCacheExport();
  }

  async function exportProjectFile(): Promise<void> {
    if (exportState || !runtimeReady.value || gameInteractionsBlocked.value) return;
    const title = diagnosisProjectName(
      presentation.title.trim() || bridge.projectName() || "RustyEra项目",
    );
    const name = `${title}.reraproj`;
    if (!(await bridge.beginProjectFileExport(name))) {
      status.value = "已取消导出项目文件";
      return;
    }
    exportState = {
      name,
      kind: "project_file",
      chunks: [],
      received: 0,
    };
    status.value = "正在生成项目文件…";
    try {
      await requestProjectFileExport();
    } catch (error) {
      await bridge.cancelProjectFileExport();
      exportState = undefined;
      throw error;
    }
  }

  async function requestProjectFileExport(): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (exportState?.kind === "project_file") exportState.requestMessageId = String(messageId);
  }

  async function requestCompiledCacheExport(): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (exportState?.kind === "compiled_cache") exportState.requestMessageId = String(messageId);
  }

  async function handleExportReady(ready: any): Promise<void> {
    if (!exportState) return;
    if (ready.result.type !== "ready") {
      const message = `当前状态不能导出快照：${(ready.result.reasons ?? []).join(", ")}`;
      const failedKind = exportState.kind;
      log("warning", message);
      if (failedKind.startsWith("diagnosis_")) finishDiagnosis(false, message);
      if (failedKind === "project_file") await bridge.cancelProjectFileExport();
      exportState = undefined;
      return;
    }
    exportState.descriptor = ready.result.transfer;
    const totalBytes = Number(ready.result.transfer.total_bytes);
    if (
      exportState.kind !== "compiled_cache" &&
      exportState.kind !== "project_file" &&
      Number.isSafeInteger(totalBytes) &&
      totalBytes >= 0
    )
      exportState.buffer = new Uint8Array(totalBytes);
    await requestExportChunk();
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
    if (!exportState?.descriptor || Number(chunk.offset) !== exportState.received) return;
    const bytes = Uint8Array.from(chunk.data, (value: number | bigint) => Number(value));
    const reset = exportState.received === 0;
    exportState.received += bytes.length;
    try {
      if (exportState.kind === "compiled_cache") {
        await bridge.writeCompiledCacheChunk(bytes, reset, chunk.complete);
      } else if (exportState.kind === "project_file") {
        await bridge.writeProjectFileChunk(bytes, reset, chunk.complete);
      } else if (exportState.buffer) {
        exportState.buffer.set(bytes, Number(chunk.offset));
      } else {
        exportState.chunks.push(bytes);
      }
    } catch (error) {
      if (exportState.kind === "project_file") await bridge.cancelProjectFileExport();
      exportState = undefined;
      throw error;
    }
    if (!chunk.complete) await requestExportChunk();
    else await finishExportTransfer();
  }

  async function finishExportTransfer(): Promise<void> {
    if (!exportState) return;
    const completed = exportState;
    const result =
      completed.kind === "compiled_cache"
        ? new Uint8Array()
        : (completed.buffer ?? concatenateChunks(completed.chunks, completed.received));
    completed.buffer = undefined;
    completed.chunks.length = 0;
    try {
      if (completed.kind === "download") {
        const saved = await bridge.saveDownload(completed.name, result);
        status.value = saved ? `已导出 ${completed.name}` : "已取消导出 VM 快照";
        exportState = undefined;
        if (diagnosisExporting.value) await startDiagnosisSnapshot();
      } else if (completed.kind === "project_file") {
        status.value = `已导出 ${completed.name}`;
        exportState = undefined;
      } else if (completed.kind === "compiled_cache") {
        status.value = `已导出 ${completed.name}`;
        exportState = undefined;
        if (diagnosisExporting.value) await startDiagnosisSnapshot();
      } else if (completed.kind === "diagnosis_snapshot") {
        if (!diagnosisState) throw new Error("诊断导出状态缺失");
        diagnosisState.snapshot = result;
        exportState = {
          name: diagnosisState.name,
          kind: "diagnosis_artifact",
          chunks: [],
          received: 0,
        };
        await requestDiagnosisArtifact();
      } else {
        if (!diagnosisState?.snapshot) throw new Error("诊断快照缺失");
        const saved = await bridge.saveDiagnosis(diagnosisState.name, {
          projectName: diagnosisState.projectName,
          snapshot: diagnosisState.snapshot,
          logs: diagnosisState.logs,
          compiledArtifact: result,
          exportedAt: diagnosisState.exportedAt,
        });
        finishDiagnosis(
          true,
          saved ? `诊断信息已导出：${diagnosisState.name}` : "已取消导出诊断信息",
        );
      }
    } catch (error) {
      if (completed.kind.startsWith("diagnosis_"))
        finishDiagnosis(false, `诊断信息导出失败：${String(error)}`);
      else {
        if (completed.kind === "project_file") await bridge.cancelProjectFileExport();
        exportState = undefined;
        const message = `状态导出失败：${String(error)}`;
        status.value = message;
        log("error", message);
      }
    }
  }

  async function requestDiagnosisArtifact(): Promise<void> {
    const messageId = await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
    if (exportState?.kind === "diagnosis_artifact")
      exportState.requestMessageId = String(messageId);
  }

  function finishDiagnosis(success: boolean, message: string): void {
    exportState = undefined;
    diagnosisState = undefined;
    diagnosisExporting.value = false;
    status.value = message;
    showDiagnosisNotification(message, false);
    log(success ? "info" : "error", message);
  }

  function captureProjectTitle(): void {
    if (projectTitleCaptured || !projectOpen.value) return;
    const title = presentation.title.trim();
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
    startSettingsElapsedTimer();
    let projectApplied = false;
    let preferencesSaved = false;
    try {
      if (changes.length) {
        await saveProjectConfiguration(changes);
        projectApplied = true;
      }
      preferences.value = await bridge.savePreferences(value);
      preferencesSaved = true;
      previewPreferences.value = null;
      audio.setPreferences(preferences.value);
      status.value = restartAfterApply ? "设置已保存，正在重新启动…" : "设置已应用";
      if (restartAfterApply) {
        preferencesOpen.value = false;
        await restart();
      }
    } catch (error) {
      const message = preferencesSaved
        ? `设置已保存，但重新启动失败：${String(error)}`
        : projectApplied
          ? `项目设置已应用，但客户端偏好保存失败：${String(error)}`
          : `设置未保存：${String(error)}`;
      status.value = message;
      log("error", message);
      settingsError.value = message;
    } finally {
      settingsBusy.value = false;
      finishSettingsElapsedTimer();
    }
  }

  function startSettingsElapsedTimer(): void {
    settingsStartedAt = performance.now();
    settingsElapsedTimer = window.setInterval(() => {
      if (settingsStartedAt == null) return;
      const elapsed = Math.floor((performance.now() - settingsStartedAt) / 1000);
      if (elapsed < 1) return;
      status.value = `${status.value.replace(/ · 已等待 \d+ 秒$/, "")} · 已等待 ${elapsed} 秒`;
    }, 1000);
  }

  function finishSettingsElapsedTimer(): void {
    settingsStartedAt = undefined;
    if (settingsElapsedTimer != null) {
      window.clearInterval(settingsElapsedTimer);
      settingsElapsedTimer = undefined;
    }
  }

  async function saveProjectConfiguration(changes: ProjectConfigurationChange[]): Promise<void> {
    const snapshot = projectConfiguration.value;
    if (!snapshot || !bridge.projectConfigurationWritable() || !configurationProfileValid.value)
      throw new Error(!snapshot ? "项目配置尚未加载" : "当前项目配置为只读");
    if (pendingConfigurationUpdate) throw new Error("项目配置正在保存，请稍候");
    await new Promise<void>((resolve, reject) => {
      void send({
        type: "prepare_configuration_update",
        value: prepareConfigurationUpdate(snapshot, changes),
      })
        .then((messageId) => {
          pendingConfigurationUpdate = {
            stage: "preparing",
            prepareMessageId: messageId,
            snapshot,
            changedCodes: changes.map((change) => change.code),
            resolve,
            reject,
          };
          status.value = "正在验证项目配置…";
        })
        .catch(reject);
    });
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
    status.value = error.message;
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
    await send({
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
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
    const messageId = await bridge.submitRuntime(transportValue(message), correlationId);
    schedulePump(0);
    return messageId;
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

  function log(level: LogEntry["level"], message: string, authoritative = false): void {
    logs.push({ timestamp: new Date(), level, message, authoritative });
    if (logs.length > 10_000) logs.splice(0, logs.length - 10_000);
  }

  function beginProjectLoad(message: string): void {
    acceptingProjectProgress = true;
    projectLoading.value = true;
    projectProgress.value = undefined;
    status.value = message;
    startProjectLoadElapsedTimer();
  }

  function continueProjectBuildProgress(): void {
    projectLoading.value = true;
    startProjectLoadElapsedTimer();
    if (
      projectProgress.value &&
      projectProgress.value.stage !== "importing" &&
      projectProgress.value.stage !== "scanning"
    )
      return;
    projectProgress.value = undefined;
    status.value = "项目文件读取完成，正在准备编译与校验…";
  }

  function showProjectLoadTransition(message: string): void {
    projectLoading.value = true;
    projectProgress.value = undefined;
    status.value = message;
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
    if (!acceptingProjectProgress) return;
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
    projectLoading.value = true;
    startProjectLoadElapsedTimer();
    projectProgress.value = progress;
    status.value = formatProjectProgress(progress);
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
      status.value = message;
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
      preferencesOpen.value = true;
    } else if (
      event.key === "F10" &&
      debugEnabled.value &&
      singleStepEnabled.value &&
      !diagnosisExporting.value
    ) {
      event.preventDefault();
      void stepDebug();
    }
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
    configurationRestartPending,
    viewportMeasurement,
    useMenu,
    useMouse,
    scrollHeight,
    effectivePreferences,
    gameTextStyle,
    gameLineHeightPx,
    fonts,
    phase,
    runtimeEpoch,
    status,
    projectOpen,
    projectLoading,
    projectLoadProgressLabel,
    projectLoadProgressValue,
    openProjectConfirmationOpen,
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
    diagnosisNotification,
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
    reloadProject,
    dismissFault,
    recoverFromFault,
    exportDiagnosis,
    exportSnapshot,
    exportProjectFile,
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
  };
});
