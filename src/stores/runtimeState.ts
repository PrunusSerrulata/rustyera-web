import type { MessageWaitIntent } from "@/core/messageSkip";
import type { DiagnosisLogEntry } from "@/core/runtimeSupport";
import type {
  DiagnosisProgressStage,
  InteractionToken,
  ProjectConfigurationSnapshot,
  ProjectProgressStage,
} from "@/core/types";

export type LogEntry = DiagnosisLogEntry & { authoritative: boolean };
export type LogNotificationPolicy = "all" | "errors_only" | "none";

export type RuntimeInputIntent =
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

export const sessionFontFallback = ["system-ui", "sans-serif", "serif", "monospace"];

export interface ExportState {
  name: string;
  runtimeKind?: "vm_snapshot" | "input_replay" | "traditional_save";
  kind:
    | "download"
    | "input_replay_download"
    | "project_file"
    | "compiled_cache"
    | "diagnosis_replay"
    | "diagnosis_snapshot"
    | "diagnosis_project";
  chunks: Uint8Array[];
  buffer?: Uint8Array;
  received: number;
  descriptor?: any;
  requestMessageId?: string;
  hostWrite?: Promise<void>;
  hostWriteFailure?: { error: unknown };
  digestHasher?: {
    update(bytes: Uint8Array): unknown;
    digest(): Uint8Array;
  };
  statusToken?: number;
}

export type DiagnosisStateExportKind = "diagnosis_replay" | "diagnosis_snapshot";

export const diagnosisStateExportRequest = {
  diagnosis_replay: { kind: "input_replay", snapshot_purpose: "normal" },
  diagnosis_snapshot: { kind: "vm_snapshot", snapshot_purpose: "diagnosis" },
} as const;

export function runtimeExportKind(state: ExportState): string {
  if (state.runtimeKind) return state.runtimeKind;
  switch (state.kind) {
    case "diagnosis_replay":
    case "input_replay_download":
      return "input_replay";
    case "download":
    case "diagnosis_snapshot":
      return "vm_snapshot";
    case "compiled_cache":
      return "compiled_project_cache";
    case "project_file":
    case "diagnosis_project":
      return "full_project_file";
  }
}

export function diagnosisProgressStage(kind: ExportState["kind"]): DiagnosisProgressStage {
  switch (kind) {
    case "diagnosis_replay":
      return "input_replay";
    case "diagnosis_snapshot":
      return "vm_snapshot";
    case "diagnosis_project":
      return "project_transfer";
    default:
      throw new Error(`export kind ${kind} is not a diagnosis export`);
  }
}

export interface PendingProjectReload {
  messageId: string;
}

export type FullProjectExportState = ExportState & {
  kind: "project_file" | "diagnosis_project";
  runtimeRequestMayBeActive?: boolean;
  requestSubmission?: FullProjectRequestSubmission;
};

export interface FullProjectRequestSubmission {
  earlyPreparationRejections: Array<{ correlation: string; value: any }>;
}

export interface FullManifestImportTransaction {
  activeExport: FullProjectExportState;
  totalBytes: number;
  purpose: "project_file" | "diagnosis_project";
  beginMessageId?: string;
  transferId?: number;
  commitMessageId?: string;
  commandMessageIds: Set<string>;
  cancelled: boolean;
  cancelSent: boolean;
  commitStarted: boolean;
  runtimeSubmission: Promise<void>;
  hostRelease?: Promise<void>;
}

export function isFullProjectExport(
  state: ExportState | undefined,
): state is FullProjectExportState {
  return state?.kind === "project_file" || state?.kind === "diagnosis_project";
}

export function isFullProjectPreparationRejection(message: string): boolean {
  return (
    message.includes("full project preparation started") ||
    message.includes("full project is still being prepared")
  );
}

export interface DiagnosisState {
  name: string;
  projectName: string;
  logs: string;
  exportedAt: Date;
  inputReplay?: Uint8Array;
  snapshot?: Uint8Array;
}

export interface PendingGameInput {
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
  previousRetiredInteractionSequence: number;
}

export interface PendingInputUndo {
  tokenIdentity: string;
  messageId?: string;
}

export interface PendingConfigurationBase {
  snapshot: ProjectConfigurationSnapshot;
  changedCodes: string[];
  sessionOnly: boolean;
  automatic: boolean;
  statusToken?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export type PendingConfigurationUpdate =
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
    seed?: number | string | bigint;
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
    indexReadMs: number | null;
    indexWriteMs: number | null;
    statMs: number | null;
    sourceReadDecodeHashMs: number | null;
    cacheReadMs: number | null;
    submissionTransferMs: number | null;
    normalizeMs: number | null;
    csvMs: number | null;
    cacheParseMs: number | null;
    cacheDecodeMs: number | null;
    cacheValidateMs: number | null;
    parseMs: number | null;
    analyzeMs: number | null;
    compileMs: number | null;
    finalizeMs: number | null;
    validateMs: number | null;
    prepareMs: number | null;
  };
  sourceIndex: {
    present: boolean | null;
    trusted: boolean | null;
    reusedFiles: number | null;
    hashedFiles: number | null;
  };
  wasmMode: "single" | null;
  wasmMemory: {
    constrained: boolean | null;
    peakBytes: number | null;
    stages: Partial<Record<ProjectProgressStage, number>>;
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

export const STARTUP_DURATION_BY_STAGE: Partial<
  Record<ProjectProgressStage, keyof StartupTelemetry["durations"]>
> = {
  normalizing: "normalizeMs",
  loading_data: "csvMs",
  parsing: "parseMs",
  analyzing: "analyzeMs",
  compiling: "compileMs",
  finalizing: "finalizeMs",
  validating: "validateMs",
  preparing: "prepareMs",
  cache_parsing: "cacheParseMs",
  cache_decoding: "cacheDecodeMs",
  cache_validating: "cacheValidateMs",
};

export const DEBUG_VARIABLE_PAGE_LIMIT = 256;
export const DEBUG_VARIABLE_MAX_PAGES = 16;
export const TIME_ADVANCE_INTERVAL_NS = 16_000_000;
export const MAXIMUM_LOG_ENTRIES = 10_000;
export const MAXIMUM_LOG_ENTRY_BYTES = 64 * 1024;
export const MAXIMUM_LOG_TOTAL_BYTES = 4 * 1024 * 1024;
// Bound memory while amortizing runtime and native-host round trips for large exports.
export const STATE_EXPORT_CHUNK_BYTES = 16 * 1024 * 1024;
export const TAURI_STATE_EXPORT_CHUNK_BYTES = 1024 * 1024;
export const PROJECT_STARTING_STATUS = "项目加载完成，正在启动游戏…";
export const GAME_RUNNING_STATUS = "游戏运行中";
