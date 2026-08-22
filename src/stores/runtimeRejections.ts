import {
  isFullProjectExport,
  isFullProjectPreparationRejection,
  type ExportState,
  type PendingGameInput,
} from "@/stores/runtimeState";

export interface RuntimeRejectionClassification {
  activeExport: ExportState | undefined;
  compiledCachePreparing: boolean;
  fullProjectPreparing: boolean;
  earlyFullProjectPreparation: boolean;
  staleProjection: boolean;
  rejectedInput: PendingGameInput | undefined;
  willRetryInput: boolean;
  suppressInputWarningNotification: boolean;
}

const NON_NOTIFIED_INPUT_WARNINGS = new Set([
  "input wait identity is stale",
  "input value does not match the active wait",
]);

export function isNonNotifiedInputWarning(message: unknown): boolean {
  return NON_NOTIFIED_INPUT_WARNINGS.has(String(message ?? ""));
}

export function classifyRuntimeRejection(
  value: any,
  correlation: string,
  activeExport: ExportState | undefined,
  pendingProjectionMessages: Set<string>,
  pendingInput: PendingGameInput | undefined,
): RuntimeRejectionClassification {
  const message = String(value.message ?? "");
  const suppressInputWarningNotification = isNonNotifiedInputWarning(message);
  const compiledCachePreparing =
    activeExport?.kind === "compiled_cache" &&
    activeExport.requestMessageId === correlation &&
    (message.includes("compiled project cache preparation started") ||
      message.includes("compiled project cache is still being prepared"));
  const fullProjectPreparing =
    isFullProjectExport(activeExport) &&
    activeExport.requestMessageId === correlation &&
    isFullProjectPreparationRejection(message);
  let earlyFullProjectPreparation = false;
  if (
    isFullProjectExport(activeExport) &&
    activeExport.requestSubmission &&
    isFullProjectPreparationRejection(message)
  ) {
    earlyFullProjectPreparation = true;
    activeExport.requestSubmission.earlyPreparationRejections.push({ correlation, value });
  }
  const staleProjection =
    pendingProjectionMessages.delete(correlation) &&
    [
      "projection environment revision is not newer",
      "projection observation does not match the canonical presentation",
    ].includes(message);
  const rejectedInput = pendingInput?.messageId === correlation ? pendingInput : undefined;
  const staleInput =
    rejectedInput != null &&
    ["input wait identity is stale", "no input is pending"].includes(message);
  const willRetryInput =
    staleInput &&
    rejectedInput != null &&
    (rejectedInput.messageSkip || rejectedInput.staleRetries === 0);
  if (willRetryInput) {
    rejectedInput.messageId = undefined;
    rejectedInput.retryPending = true;
    rejectedInput.waitClosed = false;
    rejectedInput.retryError = String(value.message ?? "Runtime 拒绝了输入");
  }
  return {
    activeExport,
    compiledCachePreparing,
    fullProjectPreparing,
    earlyFullProjectPreparation,
    staleProjection,
    rejectedInput,
    willRetryInput,
    suppressInputWarningNotification,
  };
}
