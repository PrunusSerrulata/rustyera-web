import { resourceUrlRegistry } from "@/core/resources";
import { formatProjectProgress } from "@/core/runtimeSupport";
import { type LiveMemoryCounters, type ProjectProgress, type RuntimeMessage } from "@/core/types";
import {
  RuntimeServiceError,
  sameServiceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import { normalizeProjectProgress } from "@/stores/runtimeProjectLoad";
import { transportValue } from "@/stores/runtimeTransport";
import type { LogEntry, LogNotificationPolicy } from "@/stores/runtimeState";

export function createRuntimeStoreActions6(context: any) {
  async function sendClientState(): Promise<void> {
    if (!context.runtimePump.ready || context.diagnosisExporting.value) return;
    await send({
      type: "client_state_changed",
      value: {
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        audio_available: context.audio.providerAvailable(),
        reduce_motion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        high_contrast: matchMedia("(prefers-contrast: more)").matches,
        screen_reader: false,
      },
    });
  }

  function resetDeviceInputState(clearPhysicalState: boolean): void {
    context.deviceGeneration += 1;
    context.deviceEventSequence = 0;
    context.devicePumpTimeAdvancePending = false;
    context.deviceSubmissionFailure = undefined;
    context.deviceSynchronizationPending = true;
    if (!clearPhysicalState) return;
    context.heldKeys.clear();
    context.heldMouseButtons.clear();
    context.heldMousePositions.clear();
    context.keyToggleStates.clear();
  }

  function queueDeviceState(
    device: "keyboard" | "mouse",
    code: number,
    pressed: boolean,
    toggle: boolean,
    repeat: boolean,
    x = 0,
    y = 0,
  ): Promise<void> {
    if (!context.runtimePump.ready || !Number.isInteger(code) || code < 0 || code > 255)
      return Promise.resolve();
    const generation = context.deviceGeneration;
    const eventSequence = ++context.deviceEventSequence;
    const message: RuntimeMessage = {
      type: "device_state_changed",
      value: {
        event_sequence: eventSequence,
        toggle,
        repeat,
        device,
        code,
        pressed,
        x: Math.max(-2147483648, Math.min(2147483647, Math.trunc(x))),
        y: Math.max(-2147483648, Math.min(2147483647, Math.trunc(y))),
        monotonic_time_ns: context.testEnvironment.sampleMonotonic(),
      },
    };
    const submission = context.deviceSubmissionTail.then(async () => {
      if (generation !== context.deviceGeneration || !context.runtimePump.ready) return;
      if (context.deviceSubmissionFailure?.generation === generation)
        throw context.deviceSubmissionFailure.error;
      await send(message);
    });
    context.deviceSubmissionTail = submission.catch((error: unknown) => {
      if (generation !== context.deviceGeneration) return;
      if (!context.deviceSubmissionFailure) {
        context.deviceSubmissionFailure = { generation, error };
        log("warning", `设备状态提交失败：${String(error)}`, true, "none");
      }
    });
    return context.deviceSubmissionTail;
  }

  function synchronizeHeldDeviceState(): Promise<void> {
    if (
      !context.deviceSynchronizationPending ||
      !context.runtimePump.ready ||
      BigInt(context.runtimeEpoch.value) === 0n
    )
      return context.deviceSubmissionTail;
    context.deviceSynchronizationPending = false;
    for (const code of [...context.heldKeys].sort((left, right) => left - right))
      void queueDeviceState(
        "keyboard",
        code,
        true,
        context.keyToggleStates.get(code) ?? false,
        false,
      );
    for (const code of [...context.heldMouseButtons].sort((left, right) => left - right)) {
      const [x, y] = context.heldMousePositions.get(code) ?? [0, 0];
      void queueDeviceState("mouse", code, true, false, false, x, y);
    }
    return context.deviceSubmissionTail;
  }

  async function awaitDeviceSubmissions(): Promise<void> {
    await synchronizeHeldDeviceState();
    await context.deviceSubmissionTail;
    if (context.deviceSubmissionFailure?.generation === context.deviceGeneration)
      throw context.deviceSubmissionFailure.error;
  }

  function observePhysicalDeviceState(
    device: "keyboard" | "mouse",
    code: number,
    pressed: boolean,
    toggle: boolean,
    repeat: boolean,
    x = 0,
    y = 0,
  ): Promise<void> {
    if (!Number.isInteger(code) || code < 0 || code > 255) return Promise.resolve();
    // Synchronize the state before this edge. Events observed while no session
    // was ready remain represented by the held sets and are replayed first.
    void synchronizeHeldDeviceState();
    if (device === "keyboard") {
      context.keyToggleStates.set(code, toggle);
      if (pressed) context.heldKeys.add(code);
      else context.heldKeys.delete(code);
    } else if (pressed) {
      context.heldMouseButtons.add(code);
      context.heldMousePositions.set(code, [x, y]);
    } else {
      context.heldMouseButtons.delete(code);
      context.heldMousePositions.delete(code);
    }
    return queueDeviceState(device, code, pressed, toggle, repeat, x, y);
  }

  async function pumpDevices(
    epoch: ServiceInteger,
    afterEventSequence: ServiceInteger,
  ): Promise<ServiceInteger> {
    const generation = context.deviceGeneration;
    // A zero-delay task yields to keyboard, mouse, blur and visibility callbacks
    // already queued for this browser/WebView pump. It is an event boundary, not
    // a timing approximation.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await awaitDeviceSubmissions();
    if (
      generation !== context.deviceGeneration ||
      !sameServiceInteger(epoch, context.runtimeEpoch.value)
    )
      throw new RuntimeServiceError("stale_projection", "device pump epoch changed");
    if (BigInt(afterEventSequence) > BigInt(context.deviceEventSequence))
      throw new RuntimeServiceError(
        "invalid_request",
        "device pump watermark exceeds submitted events",
      );
    // A positive snake AWAIT starts only after this acknowledgement. Its duration is retained by
    // core rather than exposed in the device-pump ABI, so keep sampling frontend time until core
    // leaves waiting_external. AWAIT 0 may receive one harmless sample before its phase update.
    context.devicePumpTimeAdvancePending = true;
    return context.deviceEventSequence;
  }

  async function signalMessageSkip(): Promise<void> {
    if (context.heldMouseButtons.has(2)) return;
    // Touch and accessibility secondary actions have no MouseEvent. Submit a
    // balanced compatibility pair so they do not leave a fabricated held button.
    void synchronizeHeldDeviceState();
    void queueDeviceState("mouse", 2, true, false, false);
    void queueDeviceState("mouse", 2, false, false, false);
    await awaitDeviceSubmissions();
  }

  function onClientStateBoundary(): void {
    if (!document.hasFocus() || document.visibilityState !== "visible") {
      for (const code of [...context.heldKeys])
        void observePhysicalDeviceState(
          "keyboard",
          code,
          false,
          context.keyToggleStates.get(code) ?? false,
          false,
        );
      for (const code of [...context.heldMouseButtons]) {
        const [x, y] = context.heldMousePositions.get(code) ?? [0, 0];
        void observePhysicalDeviceState("mouse", code, false, false, false, x, y);
      }
    }
    void sendClientState();
  }

  async function shutdown(): Promise<void> {
    if (context.diagnosisExporting.value) return;
    if (context.fullManifestImport) await context.cleanupFullManifestImport(true);
    if (context.bridge.kind === "browser") {
      requestBrowserTabClose();
      return;
    }
    if (!context.runtimePump.ready) return context.bridge.close();
    await send({ type: "shutdown_request", value: { graceful: true } });
  }

  async function send(
    message: RuntimeMessage,
    correlationId?: ServiceInteger,
  ): Promise<number | bigint> {
    if (message.type === "input" || message.type === "client_state_changed")
      await awaitDeviceSubmissions();
    const observedEpoch = context.runtimeEpoch.value;
    const observedSessionGeneration = context.runtimeSessionObservationGeneration;
    const telemetry = context.startupTelemetry.value;
    const startupStart =
      message.type === "start" &&
      telemetry?.outcome === "loading" &&
      telemetry.milestones.startSubmittedMs == null;
    if (startupStart)
      telemetry.milestones.startSubmittedMs = context.startupTelemetryState.elapsedMs();
    const transported = transportValue(message);
    const observedMessage = context.testEvidence.prepareMessage(transported);
    if (
      context.bridge.kind === "tauri" &&
      message.type === "input" &&
      message.value?.message_skip === true &&
      context.bridge.submitRuntimeAndPump
    ) {
      const batch = await context.runtimePump.submitAndHandle(() =>
        context.bridge.submitRuntimeAndPump!(transported, correlationId),
      );
      if (batch) {
        context.testEvidence.sent(
          "runtime",
          observedMessage,
          batch.submittedMessageId,
          observedEpoch,
          correlationId,
          observedSessionGeneration,
        );
        return batch.submittedMessageId;
      }
    }
    const submission = context.bridge.submitRuntime(transported, correlationId);
    // WorkerClient posts both requests to one Worker port, so queue the drive immediately:
    // FIFO delivery still guarantees that the runtime accepts this command before pumping it.
    // Native IPC does not expose that ordering guarantee and keeps the acknowledgement barrier.
    if (context.bridge.kind === "browser") context.schedulePump(0);
    const messageId = await submission;
    context.testEvidence.sent(
      "runtime",
      observedMessage,
      messageId,
      observedEpoch,
      correlationId,
      observedSessionGeneration,
    );
    if (startupStart) context.startupTelemetryState.startMessageId = String(messageId);
    if (context.bridge.kind !== "browser") context.schedulePump(0);
    return messageId;
  }

  function applyInputUndo(value: any): void {
    context.runtimeInput.applyUndo(value);
    context.inputUndo.value = value;
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
    context.runtimeLogs.record(level, message, authoritative, notificationPolicy);
  }

  function appendLogEntries(
    entries: LogEntry[],
    notificationPolicy: LogNotificationPolicy | readonly LogNotificationPolicy[] = "all",
  ): void {
    context.runtimeLogs.append(entries, notificationPolicy);
  }

  function dismissLogNotification(id: number): void {
    context.runtimeLogs.dismiss(id);
  }

  function beginProjectLoad(message: string): void {
    context.projectLoad.begin();
    context.baseStatus.value = message;
  }

  function continueProjectBuildProgress(cacheImported = false): void {
    if (!context.projectLoad.continueBuild()) return;
    context.baseStatus.value = cacheImported
      ? "项目缓存命中，正在加载缓存…"
      : "项目文件读取完成，正在准备编译与校验…";
  }

  function showProjectLoadTransition(message: string): void {
    context.projectLoad.transition();
    context.baseStatus.value = message;
  }

  function finishProjectLoad(): void {
    context.projectLoad.finish();
  }

  function handleProjectProgress(value: ProjectProgress): void {
    const progress = normalizeProjectProgress(value);
    if (!progress) return;
    if (context.diagnosisExporting.value && context.exportState?.kind === "diagnosis_project") {
      context.runtimeDiagnosis.setProgress(
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
    if (context.projectFileExporting.value) {
      context.projectFileExportState.setProgress(progress);
      context.baseStatus.value = formatProjectProgress(progress);
      return;
    }
    if (!context.projectLoad.record(progress)) return;
    context.startupTelemetryState.recordProgress(progress);
    context.baseStatus.value = formatProjectProgress(progress);
  }

  function requestBrowserTabClose(): void {
    window.close();
    window.setTimeout(() => {
      if (window.closed) return;
      const message = "浏览器阻止了关闭当前标签页，请手动关闭此标签页。";
      context.baseStatus.value = message;
      log("warning", message);
    }, 0);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const code = keyboardDeviceCode(event);
    if (code != null)
      void observePhysicalDeviceState(
        "keyboard",
        code,
        true,
        keyboardToggle(event, code),
        event.repeat,
      );
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void context.undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      context.openPreferencesFromUser();
    } else if (
      event.key === "F10" &&
      context.debugEnabled.value &&
      context.singleStepEnabled.value &&
      !context.diagnosisExporting.value
    ) {
      event.preventDefault();
      void context.stepDebug();
    } else if (
      !event.defaultPrevented &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !isModifierKey(event.key) &&
      context.canInteract.value &&
      context.currentPresentation().inputWait?.kind === "any_key"
    ) {
      event.preventDefault();
      void context.submitIntent({ type: "any_key", value: event.key || "\n" }, false);
    }
  }

  function isModifierKey(key: string): boolean {
    return ["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(key);
  }

  function onKeyUp(event: KeyboardEvent): void {
    const code = keyboardDeviceCode(event);
    if (code != null)
      void observePhysicalDeviceState("keyboard", code, false, keyboardToggle(event, code), false);
  }

  function keyboardDeviceCode(event: KeyboardEvent): number | undefined {
    const physical = event.code;
    const letter = /^Key([A-Z])$/.exec(physical)?.[1];
    if (letter) return letter.charCodeAt(0);
    const digit = /^Digit([0-9])$/.exec(physical)?.[1];
    if (digit) return digit.charCodeAt(0);
    const numpad = /^Numpad([0-9])$/.exec(physical)?.[1];
    if (numpad) return 96 + Number(numpad);
    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(physical)?.[1];
    if (functionKey) return 111 + Number(functionKey);
    const standardized = context.KEYBOARD_DEVICE_CODES[physical];
    if (standardized != null) return standardized;
    return Number.isInteger(event.keyCode) && event.keyCode > 0 && event.keyCode <= 255
      ? event.keyCode
      : undefined;
  }

  function keyboardToggle(event: KeyboardEvent, code: number): boolean {
    if (code === 20) return event.getModifierState("CapsLock");
    if (code === 144) return event.getModifierState("NumLock");
    if (code === 145) return event.getModifierState("ScrollLock");
    return false;
  }

  function mouseCode(button: number): number | undefined {
    return button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : undefined;
  }

  function onMouseDown(event: MouseEvent): void {
    const code = mouseCode(event.button);
    if (code == null) return;
    void observePhysicalDeviceState(
      "mouse",
      code,
      true,
      false,
      false,
      event.clientX,
      event.clientY,
    );
  }

  function onMouseUp(event: MouseEvent): void {
    const code = mouseCode(event.button);
    if (code == null) return;
    void observePhysicalDeviceState(
      "mouse",
      code,
      false,
      false,
      false,
      event.clientX,
      event.clientY,
    );
  }

  function liveMemoryCounters(): LiveMemoryCounters {
    return {
      ...context.bridge.runtimeMemoryCounters(),
      blobUrls: resourceUrlRegistry.memoryCounters(),
      audioBuffers: context.audio.memoryCounters(),
      imagePixelSurfaces: context.imagePixels.memoryCounters(),
    };
  }

  return {
    sendClientState,
    resetDeviceInputState,
    queueDeviceState,
    synchronizeHeldDeviceState,
    awaitDeviceSubmissions,
    observePhysicalDeviceState,
    pumpDevices,
    signalMessageSkip,
    onClientStateBoundary,
    shutdown,
    send,
    applyInputUndo,
    waitUntil,
    log,
    appendLogEntries,
    dismissLogNotification,
    beginProjectLoad,
    continueProjectBuildProgress,
    showProjectLoadTransition,
    finishProjectLoad,
    handleProjectProgress,
    requestBrowserTabClose,
    onKeyDown,
    isModifierKey,
    onKeyUp,
    keyboardDeviceCode,
    keyboardToggle,
    mouseCode,
    onMouseDown,
    onMouseUp,
    liveMemoryCounters,
  };
}
