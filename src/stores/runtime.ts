import { blake3 } from "@noble/hashes/blake3.js";
import { defineStore } from "pinia";
import { computed, reactive, ref, shallowReactive, toRaw } from "vue";

import { AudioEngine } from "@/core/audio";
import { diagnosisArchiveName } from "@/core/diagnosis";
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
import { applyDelta, applySnapshot, emptyPresentation, plainLine } from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  defaultPreferences,
  type InteractionToken,
  type Preferences,
  type PumpBatch,
  type RuntimeMessage,
  type SessionOptions,
} from "@/core/types";
import { platformBridge } from "@/platform";

interface LogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  authoritative: boolean;
}

interface ExportState {
  name: string;
  kind: "download" | "compiled_cache" | "diagnosis_snapshot" | "diagnosis_artifact";
  chunks: Uint8Array[];
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

export const useRuntimeStore = defineStore("runtime", () => {
  const bridge = platformBridge();
  const presentation = reactive(emptyPresentation());
  const preferences = ref<Preferences>(defaultPreferences());
  const previewPreferences = ref<Preferences | null>(null);
  const fonts = ref<string[]>(["system-ui", "sans-serif", "serif", "monospace"]);
  const phase = ref("negotiating");
  const runtimeEpoch = ref<number | bigint>(0);
  const status = ref("请选择 Era 项目文件夹");
  const projectOpen = ref(false);
  const sessionReady = ref(false);
  const pumping = ref(false);
  const prompt = ref("");
  const inputUndo = ref<any>(null);
  const fault = ref<any>(null);
  const faultActionBusy = ref(false);
  const logs = shallowReactive<LogEntry[]>([]);
  const preferencesOpen = ref(false);
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
  const heldKeys = new Set<number>();
  const audio = new AudioEngine(bridge, preferences.value);
  let pumpTimer: number | undefined;
  let compiledCacheTimer: number | undefined;
  let exportState: ExportState | undefined;
  let diagnosisState: DiagnosisState | undefined;
  let diagnosisNotificationTimer: number | undefined;
  let importBytes: Uint8Array | undefined;
  let importKind: Exclude<RuntimeStartKind, "new_game"> | undefined;
  let pendingStart: RuntimeTestConfiguration["start"] = { type: "new_game" };
  let testClock: Date | undefined;
  let testEntropyState: bigint | undefined;
  let testMonotonicNs: number | undefined;
  let nextEnvironmentRevision = 1;
  let projectRuntimeStartedAt: number | undefined;
  let projectUsedCompiledCache = false;
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
  let sessionTransitioning = false;
  const messageSkip = new MessageSkipController();

  const effectivePreferences = computed(() => previewPreferences.value ?? preferences.value);
  const gameTextStyle = computed(() =>
    resolveGameTextStyle(effectivePreferences.value, presentation.lines),
  );
  const canInteract = computed(
    () =>
      presentation.inputWait != null &&
      phase.value !== "debug_paused" &&
      !fault.value &&
      !diagnosisExporting.value,
  );
  const runtimeReady = computed(
    () =>
      sessionReady.value &&
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
    () => runtimeReady.value && !diagnosisExporting.value && !sessionTransitioning,
  );
  const gameInteractionsBlocked = computed(() => diagnosisExporting.value);
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
    preferences.value = await bridge.loadPreferences();
    audio.setPreferences(preferences.value);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", sendClientState);
    window.addEventListener("focus", sendClientState);
    window.addEventListener("blur", sendClientState);
    window.addEventListener("resize", projectViewport);
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
    testMonotonicNs = configuration.monotonicStartNs ?? 1_000_000;
  }

  async function ensureSession(): Promise<void> {
    if (sessionReady.value) return;
    try {
      fonts.value = await bridge.listFonts();
    } catch (error) {
      log("warning", `无法读取系统字体：${String(error)}`);
    }
    const batch = await bridge.createSession(sessionOptions());
    sessionReady.value = true;
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
    };
  }

  async function openProject(): Promise<void> {
    try {
      await audio.unlock();
      await ensureSession();
      status.value = "正在读取项目…";
      const metrics = await bridge.openProject();
      if (!metrics) {
        status.value = "已取消打开项目";
        return;
      }
      projectOpen.value = true;
      projectUsedCompiledCache = metrics.cacheImported;
      projectRuntimeStartedAt = performance.now();
      log(
        "info",
        `项目读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入编译缓存）" : "（冷编译）"}`,
      );
      status.value = "正在编译项目…";
      schedulePump(0);
    } catch (error) {
      status.value = String(error);
      log("error", status.value);
    }
  }

  function schedulePump(delay = 16): void {
    if (!sessionReady.value || sessionTransitioning || pumpTimer != null) return;
    pumpTimer = window.setTimeout(() => {
      pumpTimer = undefined;
      void pumpOnce();
    }, delay);
  }

  async function pumpOnce(): Promise<void> {
    if (pumping.value || sessionTransitioning) return;
    pumping.value = true;
    try {
      const batch = await bridge.pump();
      await handleBatch(batch);
      schedulePump(batch.state === "more_work" || batch.state === "output_ready" ? 0 : 16);
    } catch (error) {
      fault.value = { code: "frontend", message: String(error) };
      log("error", String(error));
    } finally {
      pumping.value = false;
    }
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
        if (value.success) {
          status.value = "项目编译完成";
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
                log("warning", `编译缓存生成失败：${String(error)}`);
              });
            }, 1000);
        } else if (value.payload_required) {
          status.value = "编译缓存未命中，正在读取项目源码…";
          projectUsedCompiledCache = false;
          projectRuntimeStartedAt = performance.now();
          await bridge.submitProjectSource();
          schedulePump(0);
        } else {
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
        batchMediaDirty = true;
        break;
      case "presentation_delta":
        try {
          applyDelta(presentation, value);
        } catch (error) {
          log("warning", String(error));
          await send({ type: "resynchronize", value: { after_sequence: null } });
        }
        batchMediaDirty = true;
        break;
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
          (exportState?.kind === "compiled_cache" || exportState?.kind === "diagnosis_artifact") &&
          !exportState.descriptor
        )
          await (exportState.kind === "diagnosis_artifact"
            ? requestDiagnosisArtifact()
            : requestCompiledCacheExport());
        break;
      case "log":
        if (!isRecoverableStaleDebugLog(value.message))
          log(value.level ?? "info", value.message, true);
        break;
      case "command_rejected":
        log("warning", value.message ?? "Runtime 拒绝了命令", true);
        if (
          exportState?.requestMessageId === String(correlationId) &&
          !String(value.message ?? "").includes("compiled project cache preparation started") &&
          !String(value.message ?? "").includes("compiled project cache is still being prepared")
        ) {
          const message = `状态导出被 Runtime 拒绝：${value.message ?? "未知原因"}`;
          if (exportState.kind.startsWith("diagnosis_")) finishDiagnosis(false, message);
          else {
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
        await bridge.close();
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
          response = mapOf([0, at(query, 0)], [1, text ? escapeHtml(plainLine(text)) : ""]);
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
        monotonic_time_ns:
          testMonotonicNs == null
            ? Math.round(performance.now() * 1_000_000)
            : (testMonotonicNs += 1_000_000),
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

  function resetMessageSkip(): void {
    messageSkip.cancel();
  }

  async function undo(): Promise<void> {
    if (!diagnosisExporting.value && inputUndo.value?.token)
      await send({ type: "input_undo_request", value: { token: inputUndo.value.token } });
  }

  async function restart(): Promise<void> {
    if (!projectOpen.value || sessionTransitioning || diagnosisExporting.value) return;
    sessionTransitioning = true;
    if (pumpTimer != null) {
      window.clearTimeout(pumpTimer);
      pumpTimer = undefined;
    }
    if (compiledCacheTimer != null) {
      window.clearTimeout(compiledCacheTimer);
      compiledCacheTimer = undefined;
    }
    while (pumping.value)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    status.value = "正在创建新的 Runtime session…";
    resetMessageSkip();
    await audio
      .synchronize([])
      .catch((error) => log("warning", `重新开始时停止音频失败：${String(error)}`));
    resetSessionState();
    try {
      const batch = await bridge.createSession(sessionOptions());
      sessionReady.value = true;
      await handleBatch(batch);
      projectRuntimeStartedAt = performance.now();
      const metrics = await bridge.restartProject();
      projectUsedCompiledCache = metrics.cacheImported;
      log(
        "info",
        `项目重新读取：快速扫描 ${metrics.quickScanMs.toFixed(0)} ms，缓存读取 ${metrics.cacheReadMs.toFixed(0)} ms，源码读取 ${metrics.sourceReadMs.toFixed(0)} ms，提交 ${metrics.submitMs.toFixed(0)} ms${metrics.cacheImported ? "（已导入编译缓存）" : "（冷编译）"}`,
      );
      status.value = "正在编译项目…";
    } catch (error) {
      const message = `重新开始失败：${String(error)}`;
      status.value = message;
      log("error", message);
    } finally {
      sessionTransitioning = false;
      schedulePump(0);
    }
  }

  async function returnToTitle(): Promise<void> {
    if (diagnosisExporting.value) return;
    resetMessageSkip();
    await send({ type: "return_to_title", value: {} });
  }

  function resetSessionState(): void {
    Object.assign(presentation, emptyPresentation());
    sessionReady.value = false;
    phase.value = "negotiating";
    runtimeEpoch.value = 0;
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
    diagnosisExporting.value = false;
    importBytes = undefined;
    importKind = undefined;
    nextEnvironmentRevision = 1;
  }

  async function reloadProject(): Promise<void> {
    if (diagnosisExporting.value) return;
    status.value = "正在重新加载项目…";
    await bridge.reloadProject();
    schedulePump(0);
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
    const projectName = bridge.projectName() || "project";
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
      name: `runtime-${timestamp()}.snapshot`,
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

  async function beginCompiledCacheExport(): Promise<void> {
    if (exportState) return;
    exportState = {
      name: "compiled-project-v8.bin.zst",
      kind: "compiled_cache",
      chunks: [],
      received: 0,
    };
    status.value = "正在后台生成编译缓存…";
    await requestCompiledCacheExport();
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
      log("warning", message);
      if (exportState.kind.startsWith("diagnosis_")) finishDiagnosis(false, message);
      exportState = undefined;
      return;
    }
    exportState.descriptor = ready.result.transfer;
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
    if (exportState.kind === "compiled_cache") {
      await bridge.writeCompiledCacheChunk(bytes, reset, chunk.complete);
    } else {
      exportState.chunks.push(bytes);
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
        : concatenateChunks(completed.chunks, completed.received);
    try {
      if (completed.kind === "download") {
        const saved = await bridge.saveDownload(completed.name, result);
        status.value = saved ? `已导出 ${completed.name}` : "已取消导出 VM 快照";
        exportState = undefined;
        if (diagnosisExporting.value) await startDiagnosisSnapshot();
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
        const archive = await bridge.createDiagnosisArchive({
          projectName: diagnosisState.projectName,
          snapshot: diagnosisState.snapshot,
          logs: diagnosisState.logs,
          compiledArtifact: result,
          exportedAt: diagnosisState.exportedAt,
        });
        const saved = await bridge.saveDownload(diagnosisState.name, archive);
        finishDiagnosis(
          true,
          saved ? `诊断信息已导出：${diagnosisState.name}` : "已取消导出诊断信息",
        );
      }
    } catch (error) {
      if (completed.kind.startsWith("diagnosis_"))
        finishDiagnosis(false, `诊断信息导出失败：${String(error)}`);
      else {
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

  async function savePreferences(value: Preferences): Promise<void> {
    preferences.value = await bridge.savePreferences(value);
    previewPreferences.value = null;
    audio.setPreferences(preferences.value);
  }

  function preview(value: Preferences | null): void {
    previewPreferences.value = value;
    audio.setPreferences(value ?? preferences.value);
  }

  async function projectViewport(): Promise<void> {
    if (!sessionReady.value) return;
    const viewport = document.querySelector(".game-viewport");
    if (!(viewport instanceof HTMLElement)) return;
    await send({
      type: "projection_observation",
      value: {
        environment_revision: nextEnvironmentRevision,
        presentation_revision: presentation.revision,
        client_size: { width: viewport.clientWidth, height: viewport.clientHeight },
        projection_space_revision: nextEnvironmentRevision++,
        line_columns: Math.max(1, Math.floor(viewport.clientWidth / 8)),
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

  async function sendClientState(): Promise<void> {
    if (!sessionReady.value) return;
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
    if (!sessionReady.value) return bridge.close();
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

  function onKeyDown(event: KeyboardEvent): void {
    heldKeys.add(event.keyCode);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void undo();
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
    effectivePreferences,
    gameTextStyle,
    fonts,
    phase,
    runtimeEpoch,
    status,
    projectOpen,
    prompt,
    inputUndo,
    fault,
    faultActionBusy,
    logs,
    preferencesOpen,
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
    runtimeReady,
    canExportDiagnosis,
    gameInteractionsBlocked,
    canStepDebug,
    canInteract,
    promptPlaceholder,
    initialize,
    openProject,
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
    restoreSnapshot,
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

function at(value: any, key: number): any {
  return value instanceof Map ? value.get(key) : value?.[key];
}

function isRecoverableStaleDebugLog(message: unknown): boolean {
  const text = String(message ?? "");
  return (
    text.includes("debug request failed") &&
    text.includes("debug grant is stale or belongs to another session generation")
  );
}

function mapOf(...entries: [number, unknown][]): Map<number, unknown> {
  return new Map(entries);
}

function safeNumber(value: number | bigint | undefined): number | undefined {
  return value == null ? undefined : Number(value);
}

function concatenateChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function formatDiagnosisLogs(entries: LogEntry[]): string {
  if (!entries.length) return "";
  const level = { debug: "DEBUG", info: "INFO ", warning: "WARN ", error: "ERROR" } as const;
  const time = (value: Date) =>
    [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  return `${entries
    .map((entry) => `[${time(entry.timestamp)}] ${level[entry.level]} ${entry.message}`)
    .join("\n")}\n`;
}

function transportValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  const raw = toRaw(value as object);
  if (raw instanceof Uint8Array) return new Uint8Array(raw) as T;
  if (raw instanceof Date) return new Date(raw) as T;
  if (raw instanceof Map)
    return new Map(
      [...raw.entries()].map(([key, child]) => [transportValue(key), transportValue(child)]),
    ) as T;
  if (Array.isArray(raw)) return raw.map(transportValue) as T;
  return Object.fromEntries(
    Object.entries(raw).map(([key, child]) => [key, transportValue(child)]),
  ) as T;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatDiagnostic(value: any): string {
  const source = value.source;
  return source
    ? `${source.relative_path}:${Number(source.line ?? 0) + 1}:${Number(source.byte_column ?? 0) + 1}: [${value.code}] ${value.message}`
    : `[${value.code}] ${value.message}`;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
}
