import { blake3 } from "@noble/hashes/blake3.js";
import { defineStore } from "pinia";
import { computed, reactive, ref, shallowReactive } from "vue";

import { AudioEngine } from "@/core/audio";
import {
  debugStopToken,
  debugVariableKey,
  formatDebugValue,
  isStaleDebugGrantError,
  refreshDebugStop,
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
  kind: "download" | "compiled_cache";
  chunks: Uint8Array[];
  received: number;
  descriptor?: any;
}

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
  const debugGrant = ref<any>(null);
  const debugStop = ref<any>(null);
  const debugOutput = ref<string[]>([]);
  const debugVariables = ref<any[]>([]);
  const debugFibers = ref<any[]>([]);
  const debugFrames = ref<any[]>([]);
  const debugVariableValues = ref<Record<string, string>>({});
  const heldKeys = new Set<number>();
  const audio = new AudioEngine(bridge, preferences.value);
  let pumpTimer: number | undefined;
  let compiledCacheTimer: number | undefined;
  let exportState: ExportState | undefined;
  let importBytes: Uint8Array | undefined;
  let nextEnvironmentRevision = 1;
  let projectRuntimeStartedAt: number | undefined;
  let projectUsedCompiledCache = false;
  let batchMediaDirty = false;
  let debugPausePending = false;
  let debugGrantRefreshNeeded = false;
  let sessionTransitioning = false;
  const messageSkip = new MessageSkipController();

  const effectivePreferences = computed(() => previewPreferences.value ?? preferences.value);
  const gameTextStyle = computed(() =>
    resolveGameTextStyle(effectivePreferences.value, presentation.lines),
  );
  const canInteract = computed(
    () => presentation.inputWait != null && phase.value !== "debug_paused" && !fault.value,
  );
  const canStepDebug = computed(
    () => debugStopToken(debugStop.value) != null && selectedDebugFiber(debugStop.value) != null,
  );

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
      availableFonts: fonts.value,
      preferredLocales: preferredRuntimeLocales(navigator.languages),
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
      else handleDebug(event.message as any);
      index += 1;
    }
    if (batchMediaDirty) await synchronizeMedia();
    if (debugGrantRefreshNeeded) {
      debugGrantRefreshNeeded = false;
      await requestDebugGrant();
    } else if (debugEnabled.value && projectOpen.value) {
      await pauseDebug();
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
          await send({ type: "start", value: { mode: { type: "new_game", seed: null } } });
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
        await send({
          type: "start",
          value: { mode: { type: "vm_snapshot", transfer_id: value.transfer_id } },
        });
        importBytes = undefined;
        break;
      case "fault":
        fault.value = value;
        log("error", value.message ?? "Runtime fault", true);
        break;
      case "diagnostic":
        log(value.level ?? "info", `[${value.code}] ${value.message}`, true);
        if (
          value.code === "runtime.compiled_cache_ready" &&
          exportState?.kind === "compiled_cache" &&
          !exportState.descriptor
        )
          await requestCompiledCacheExport();
        break;
      case "log":
        log(value.level ?? "info", value.message, true);
        break;
      case "command_rejected":
        log("warning", value.message ?? "Runtime 拒绝了命令", true);
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
      const query = decodeServicePayload(new Uint8Array(request.payload));
      let response: Map<number, unknown>;
      switch (`${request.kind}/${request.operation}`) {
        case "entropy/random_seed": {
          const bytes = crypto.getRandomValues(new Uint32Array(2));
          response = mapOf([0, (BigInt(bytes[0]) << 32n) | BigInt(bytes[1])]);
          break;
        }
        case "clock/local_date_time": {
          const now = new Date();
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
            result: { type: "ready", payload: encodeServicePayload(response) },
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
              error: { code: "frontend.unsupported_service", message: String(error) },
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
    const wait = presentation.inputWait;
    if (!wait) return;
    if (!messageSkip) resetMessageSkip();
    await send({
      type: "input",
      value: {
        wait_id: wait.wait_id,
        token: wait.submission_token,
        monotonic_time_ns: Math.round(performance.now() * 1_000_000),
        intent,
        message_skip: messageSkip,
      },
    });
  }

  async function continueMessageSkip(): Promise<void> {
    const wait = presentation.inputWait;
    if (messageSkip.continue(wait)) await submitIntent({ type: "enter" }, true);
  }

  function resetMessageSkip(): void {
    messageSkip.cancel();
  }

  async function undo(): Promise<void> {
    if (inputUndo.value?.token)
      await send({ type: "input_undo_request", value: { token: inputUndo.value.token } });
  }

  async function restart(): Promise<void> {
    if (!projectOpen.value || sessionTransitioning) return;
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
    debugGrantRefreshNeeded = false;
    debugEnabled.value = false;
    debugGrant.value = null;
    debugStop.value = null;
    debugOutput.value = [];
    debugVariables.value = [];
    debugFibers.value = [];
    debugFrames.value = [];
    debugVariableValues.value = {};
    prompt.value = "";
    exportState = undefined;
    importBytes = undefined;
    nextEnvironmentRevision = 1;
  }

  async function reloadProject(): Promise<void> {
    status.value = "正在重新加载项目…";
    await bridge.reloadProject();
    schedulePump(0);
  }

  function dismissFault(): void {
    fault.value = null;
  }

  async function recoverFromFault(action: "title" | "reload"): Promise<void> {
    if (faultActionBusy.value) return;
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
    try {
      await exportSnapshot("diagnosis");
    } catch (error) {
      const message = `无法导出诊断快照：${String(error)}`;
      status.value = message;
      log("error", message);
    }
  }

  async function exportSnapshot(
    purpose: "normal" | "debug" | "diagnosis" = "normal",
  ): Promise<void> {
    if (exportState) {
      status.value = "另一项状态导出仍在进行，请稍后重试";
      return;
    }
    exportState = {
      name:
        purpose === "diagnosis" ? "runtime-diagnosis.snapshot" : `runtime-${timestamp()}.snapshot`,
      kind: "download",
      chunks: [],
      received: 0,
    };
    await send({
      type: "state_export_request",
      value: { kind: "vm_snapshot", snapshot_purpose: purpose },
    });
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
    await send({
      type: "state_export_request",
      value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
    });
  }

  async function handleExportReady(ready: any): Promise<void> {
    if (!exportState) return;
    if (ready.result.type !== "ready") {
      log("warning", `当前状态不能导出快照：${(ready.result.reasons ?? []).join(", ")}`);
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
    if (!exportState?.descriptor || chunk.offset !== exportState.received) return;
    const bytes = new Uint8Array(chunk.data);
    const reset = exportState.received === 0;
    exportState.received += bytes.length;
    if (exportState.kind === "compiled_cache") {
      await bridge.writeCompiledCacheChunk(bytes, reset, chunk.complete);
    } else {
      exportState.chunks.push(bytes);
    }
    if (!chunk.complete) await requestExportChunk();
    else {
      if (exportState.kind === "download") {
        const result = new Uint8Array(exportState.received);
        let offset = 0;
        for (const part of exportState.chunks) {
          result.set(part, offset);
          offset += part.length;
        }
        await bridge.saveDownload(exportState.name, result);
      }
      status.value = `已导出 ${exportState.name}`;
      exportState = undefined;
    }
  }

  async function restoreSnapshot(): Promise<void> {
    const bytes = await bridge.openUpload();
    if (!bytes) return;
    importBytes = bytes;
    await send({
      type: "state_import_begin",
      value: {
        kind: "vm_snapshot",
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
    await ensureSession();
    if (!debugEnabled.value) {
      await requestDebugGrant();
    } else if (debugGrant.value) {
      await bridge.submitDebug({
        type: "revoke",
        value: { grant_id: debugGrant.value.token.grant_id, reason: "disabled by user" },
      });
      debugPausePending = false;
      debugEnabled.value = false;
      debugGrant.value = null;
      debugStop.value = null;
    }
  }

  function handleDebug(message: any): void {
    if (message.type === "grant") {
      debugPausePending = false;
      debugGrantRefreshNeeded = false;
      debugGrant.value = message.value;
      debugEnabled.value = true;
      debugStop.value = null;
    } else if (message.type === "revoke") {
      debugPausePending = false;
      debugGrant.value = null;
      debugEnabled.value = false;
      debugStop.value = null;
    } else if (message.type === "stopped") {
      debugPausePending = false;
      debugStop.value = message.value;
    } else if (message.type === "response") {
      const response = message.value;
      debugStop.value = refreshDebugStop(debugStop.value, response.value);
      if (response.type === "variable_page") debugVariables.value = response.value.variables ?? [];
      else if (response.type === "variable_value") {
        debugVariableValues.value[debugVariableKey(response.value)] = formatDebugValue(
          response.value.value,
        );
      } else if (response.type === "fiber_page") debugFibers.value = response.value.fibers ?? [];
      else if (response.type === "call_stack") debugFrames.value = response.value.frames ?? [];
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
    } else if (message.type === "error") {
      debugPausePending = false;
      log("warning", message.value.message);
      if (debugEnabled.value && isStaleDebugGrantError(message.value)) {
        debugGrant.value = null;
        debugStop.value = null;
        debugGrantRefreshNeeded = true;
      }
    }
  }

  async function requestDebugGrant(): Promise<void> {
    await bridge.submitDebug({
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
    });
    schedulePump(0);
  }

  async function debugCommand(command: any): Promise<void> {
    if (!debugGrant.value) return;
    await bridge.submitDebug({
      type: "request",
      value: { grant: debugGrant.value.token, command },
    });
  }

  async function pauseDebug(): Promise<void> {
    if (
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
    if (kind === "console") debugConsoleOpen.value = true;
    else if (kind === "variables") variablesOpen.value = true;
    else stackOpen.value = true;
    await pauseDebug();
  }

  async function stepDebug(): Promise<void> {
    const command = sourceLineStepCommand(debugStop.value);
    if (!command) return;
    const previousStop = debugStop.value;
    debugStop.value = null;
    try {
      await debugCommand(command);
    } catch (error) {
      debugStop.value = previousStop;
      throw error;
    }
  }

  async function continueDebug(): Promise<void> {
    const stop = debugStopToken(debugStop.value);
    if (!stop) return;
    const previousStop = debugStop.value;
    debugStop.value = null;
    try {
      await debugCommand({ type: "continue", stop });
    } catch (error) {
      debugStop.value = previousStop;
      throw error;
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
    if (!sessionReady.value) return bridge.close();
    await send({ type: "shutdown_request", value: { graceful: true } });
  }

  async function send(message: RuntimeMessage, correlationId?: number): Promise<void> {
    await bridge.submitRuntime(message, correlationId);
    schedulePump(0);
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
    } else if (event.key === "F10" && debugEnabled.value) {
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
    debugStop,
    debugOutput,
    debugVariables,
    debugFibers,
    debugFrames,
    debugVariableValues,
    canStepDebug,
    canInteract,
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
    openDebugDialog,
    stepDebug,
    continueDebug,
    savePreferences,
    preview,
    shutdown,
    projectViewport,
  };
});

function at(value: any, key: number): any {
  return value instanceof Map ? value.get(key) : value?.[key];
}

function mapOf(...entries: [number, unknown][]): Map<number, unknown> {
  return new Map(entries);
}

function safeNumber(value: number | bigint | undefined): number | undefined {
  return value == null ? undefined : Number(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatDiagnostic(value: any): string {
  const source = value.source;
  return source
    ? `${source.relative_path}:${(source.line ?? 0) + 1}:${(source.byte_column ?? 0) + 1}: [${value.code}] ${value.message}`
    : `[${value.code}] ${value.message}`;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
}
