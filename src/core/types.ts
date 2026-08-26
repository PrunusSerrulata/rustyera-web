export type RuntimeMessage = { type: string; value?: any };
export type DebugMessage = { type: string; value?: any };

export interface WebEvent {
  channel: "runtime" | "debug";
  sequence: number | bigint;
  messageId: number | bigint;
  correlationId?: number | bigint;
  epoch?: number | bigint;
  message: RuntimeMessage | DebugMessage;
  dataBytes?: Uint8Array;
}

export interface PumpBatch {
  state: "idle" | "more_work" | "output_ready" | "stopped" | "faulted";
  vmInstructions: number | bigint;
  runtimeTransitions: number;
  cooperativeBackgroundWork?: boolean;
  /** Current WASM linear-memory allocation; absent for native hosts. */
  memoryBytes?: number;
  events: WebEvent[];
}

export interface SubmittedPumpBatch extends PumpBatch {
  submittedMessageId: number | bigint;
}

export type InteractionAssistMode = "off" | "on" | "auto";

export interface Preferences {
  schemaVersion: 7;
  settings: Record<string, string>;
  fontFamilyOverride: string | null;
  fontSizeOverridePx: number | null;
  imageScale: number;
  masterVolume: number;
  trustProjectFileMetadata: boolean;
  interactionAssistMode: InteractionAssistMode;
}

export const defaultPreferences = (): Preferences => ({
  schemaVersion: 7,
  settings: {},
  fontFamilyOverride: null,
  fontSizeOverridePx: null,
  imageScale: 1,
  masterVolume: 1,
  trustProjectFileMetadata: false,
  interactionAssistMode: "auto",
});

export interface ProjectPreferences {
  settings: Record<string, string>;
  imageScale?: number;
  masterVolume?: number;
  trustProjectFileMetadata?: boolean;
  interactionAssistMode?: InteractionAssistMode;
}

export const defaultProjectPreferences = (): ProjectPreferences => ({ settings: {} });

export interface SessionOptions {
  clientName: string;
  availableFonts: string[];
  preferredLocales: string[];
  audioAvailable: boolean;
  debugScopeMask: number;
  maximumEnvelopeBytes: number;
  configurationProfile: "browser" | "tauri";
}

export interface ProjectOpenMetrics {
  /** Frontend monotonic timestamp captured immediately after the user submitted a selection. */
  submittedAtMs: number;
  quickScanMs: number;
  cacheReadMs: number;
  sourceReadMs: number;
  submitMs: number;
  cacheImported: boolean;
  sourceIndexTrusted?: boolean;
  sourceIndexReusedFiles?: number;
  sourceIndexHashedFiles?: number;
  sourceIndexPresent?: boolean;
  enumerateMs?: number;
  indexReadMs?: number;
  indexWriteMs?: number;
  statMs?: number;
  sourceReadDecodeHashMs?: number;
  submissionTransferMs?: number;
  wasmMode?: "single";
  memoryConstrained?: boolean;
  projectFonts: ProjectFontLoadResult;
}

export interface ProjectGameInformation {
  title?: string;
  author?: string;
  version?: string;
  year?: string;
  information?: string;
}

export type ProjectSubmittedListener = (submittedAtMs: number) => void;
export type ProjectSelectionPreparation = () => Promise<void>;

export type ProjectProgressStage =
  | "importing"
  | "loading_cache"
  | "submitting"
  | "scanning"
  | "normalizing"
  | "loading_data"
  | "parsing"
  | "analyzing"
  | "compiling"
  | "validating"
  | "finalizing"
  | "preparing"
  | "packaging"
  | "cache_parsing"
  | "cache_decoding"
  | "cache_validating"
  | "initializing_memory"
  | "indexing_program";

export interface ProjectProgress {
  stage: ProjectProgressStage;
  completed: number;
  total: number;
  /** Core monotonic time used to report precise startup phase durations. */
  elapsedMs?: number;
  /** Current WASM linear-memory high-water allocation, when reported by the browser host. */
  memoryBytes?: number;
}

export type DiagnosisProgressStage =
  | "waiting"
  | "input_replay"
  | "vm_snapshot"
  | "project_scanning"
  | "project_preparing"
  | "project_packaging"
  | "project_transfer"
  | "archive";

export interface DiagnosisProgress {
  stage: DiagnosisProgressStage;
  completed: number;
  total: number;
}

export interface TraditionalSaveSlot {
  slot: number;
  occupied: boolean;
}

export interface TraditionalSaveInspection {
  description: string;
}

export interface TraditionalSaveAccess {
  listSlots(): Promise<TraditionalSaveSlot[]>;
  exportSlot(slot: number): Promise<void>;
  pickImport(): Promise<{ name: string; bytes: Uint8Array } | undefined>;
  inspect(bytes: Uint8Array): Promise<TraditionalSaveInspection>;
  writeSlot(slot: number, bytes: Uint8Array): Promise<void>;
}

export type SystemFontQueryResult =
  | { kind: "ready"; fonts: string[] }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

export type FontAccessStatus = "idle" | "loading" | "ready" | "unsupported" | "denied" | "error";

export interface ProjectFontLoadResult {
  fonts: string[];
  errors: string[];
}

/** Platform-neutral live counters for memory retained by the active frontend session. */
export interface RuntimeHostMemoryCounters {
  /** Dedicated runtime generation, or null when the host does not use a Worker. */
  workerGeneration: number | null;
  /** Current WASM linear-memory size, or null for native hosts and before the first pump. */
  wasmLinearMemoryBytes: number | null;
  /** Native-process resident set, when the host can obtain it. */
  residentBytes: number | null;
  /** Platform-specific physical footprint, currently exposed by macOS. */
  physicalFootprintBytes: number | null;
  /** Process virtual address-space size, when available. */
  virtualBytes: number | null;
  /** Private process bytes, when available. */
  privateBytes: number | null;
  /** Committed process bytes, when available. */
  committedBytes: number | null;
  /** Anonymous resident bytes, when available. */
  anonymousBytes: number | null;
}

export interface LiveMemoryCounters extends RuntimeHostMemoryCounters {
  blobUrls: { count: number; bytes: number };
  audioBuffers: { count: number; estimatedBytes: number };
  imagePixelSurfaces: { count: number; pixels: number; estimatedBytes: number; inflight: number };
}

export type ProjectReloadScope =
  { type: "all" } | { type: "folder"; path: string } | { type: "script"; path: string };

export interface ProjectReloadTargets {
  folders: string[];
  scripts: string[];
}

export interface ProjectReloadSubmission extends ProjectFontLoadResult {
  messageId: number | bigint;
}

export interface FrontendBridge {
  readonly kind: "tauri" | "browser";
  /** Whether a browser host can open a project directory without importing it first. */
  readonly directProjectDirectoryAccess?: boolean;
  /** Whether the host selected the constrained-memory browser strategy. */
  readonly memoryConstrained?: boolean;
  /** Whether snapshot import replaces the whole host session or mutates it in place. */
  readonly snapshotRestoreMode: "in_place" | "fresh_session";
  /** Release the previous host runtime before creating any replacement session. */
  prepareSessionReplacement(): Promise<void>;
  /** Return counters using the same schema on browser/WASM and native hosts. */
  runtimeMemoryCounters(): RuntimeHostMemoryCounters;
  /** Whether this host benefits from preparing its Runtime before the first project selection. */
  readonly prewarmRuntimeOnInitialize?: boolean;
  /** Whether this host can safely build and persist a speculative compiled cache. */
  readonly automaticCompiledCacheExport: boolean;
  readonly traditionalSaves?: TraditionalSaveAccess;
  createSession(options: SessionOptions): Promise<PumpBatch>;
  submitRuntime(message: RuntimeMessage, correlationId?: number | bigint): Promise<number | bigint>;
  /** Native fast path that submits an input and drives bounded work in the same host call. */
  submitRuntimeAndPump?(
    message: RuntimeMessage,
    correlationId?: number | bigint,
  ): Promise<SubmittedPumpBatch>;
  submitDebug(message: DebugMessage, correlationId?: number | bigint): Promise<number | bigint>;
  pump(): Promise<PumpBatch>;
  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void;
  openProject(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined>;
  openProjectFile(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined>;
  restartProject(onSubmitted?: ProjectSubmittedListener): Promise<ProjectOpenMetrics>;
  submitProjectSource(): Promise<void>;
  prepareProjectReloadBaseline(): Promise<void>;
  projectReloadTargets(): Promise<ProjectReloadTargets>;
  reloadProject(scope: ProjectReloadScope): Promise<ProjectReloadSubmission>;
  finalizeProjectReload(success: boolean): Promise<ProjectFontLoadResult>;
  readResource(relativePath: string): Promise<Uint8Array>;
  readImageMetadata(relativePath: string): Promise<{
    width: number;
    height: number;
    format: string;
    animated: boolean;
  }>;
  handleStorage(request: any): Promise<any>;
  listFonts(): Promise<SystemFontQueryResult>;
  loadPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<Preferences>;
  currentProjectPreferences(): ProjectPreferences | undefined;
  saveProjectPreferences(preferences: ProjectPreferences): Promise<ProjectPreferences>;
  projectPreferencesWritable(): boolean;
  projectConfigurationWritable(): boolean;
  writeProjectConfiguration(expectedDigest: Uint8Array, contents: string): Promise<void>;
  applyProjectConfiguration(
    entries: ProjectConfigurationEntry[],
    viewportChrome: { width: number; height: number },
    changedCodes?: string[],
  ): Promise<void>;
  projectName(): string | undefined;
  openUpload(): Promise<Uint8Array | undefined>;
  saveDownload(name: string, bytes: Uint8Array): Promise<boolean>;
  beginStateExport(name: string, totalBytes: number): Promise<boolean>;
  writeStateExportChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
  cancelStateExport(): Promise<void>;
  fullProjectExportSupported(): boolean;
  stageFullProjectManifest(): Promise<{ totalBytes: number } | undefined>;
  readFullProjectManifestChunk(offset: number, maximumBytes: number): Promise<Uint8Array>;
  releaseFullProjectManifest(): Promise<void>;
  beginProjectFileExport(name: string): Promise<boolean>;
  writeProjectFileChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
  cancelProjectFileExport(): Promise<void>;
  saveDiagnosis(
    name: string,
    input: import("@/core/diagnosis").DiagnosisArchiveInput,
    reportProgress?: (progress: import("@/core/diagnosis").DiagnosisArchiveProgress) => void,
  ): Promise<boolean>;
  writeCompiledCacheChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
  cancelCompiledCacheExport(): Promise<void>;
  /** Release host resources without requesting that the containing window be closed. */
  dispose(): Promise<void>;
  close(): Promise<void>;
}

export interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface TextStyle {
  foreground: Color;
  background?: Color;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  font_family?: string;
  font_millipixels: number;
}

export type ProjectConfigurationValueKind =
  | "boolean"
  | "integer"
  | "string"
  | "enum"
  | "color"
  | "character"
  | "integer_list"
  | "string_list";

export interface ProjectConfigurationEntry {
  code: string;
  japanese: string;
  english: string;
  value: string;
  kind: ProjectConfigurationValueKind;
  allowed: string[];
  fixed: boolean;
  applicability: number;
  default_value: string;
  effective_value: string;
  application: "hot" | "restart";
  preference_eligible: boolean;
  client_effective_value: string;
}

export interface ProjectConfigurationSnapshot {
  project_revision: number | bigint;
  source_digest: Uint8Array;
  entries: ProjectConfigurationEntry[];
  restart_pending: boolean;
  generated_source: string | null;
}

export interface ProjectConfigurationChange {
  code: string;
  value: string;
}

export interface PreparedProjectConfiguration {
  project_revision: number | bigint;
  expected_source_digest: Uint8Array;
  contents: string;
  restart_required: boolean;
  prepared_source_digest: Uint8Array;
}

export type TooltipFormatFlag =
  | "horizontal_center"
  | "right"
  | "vertical_center"
  | "bottom"
  | "word_break"
  | "single_line"
  | "expand_tabs"
  | "no_clipping"
  | "external_leading"
  | "no_prefix"
  | "internal"
  | "text_box_control"
  | "path_ellipsis"
  | "end_ellipsis"
  | "modify_string"
  | "right_to_left"
  | "word_ellipsis"
  | "no_full_width_character_break"
  | "hide_prefix"
  | "prefix_only"
  | "preserve_graphics_clipping"
  | "preserve_graphics_translate_transform"
  | "no_padding"
  | "left_and_right_padding";

export interface TooltipSettings {
  foreground: Color;
  background: Color;
  delay_ms: number;
  duration_ms: number;
  font_family?: string;
  font_millipoints: number;
  custom: boolean;
  format: number;
  images: boolean;
  normalized_format: {
    flags: TooltipFormatFlag[];
    unknown_bits: number | bigint;
  };
}

export type DisplayRun =
  | { type: "text"; text: string; style: TextStyle }
  | { type: "text_layout"; text: string; style: TextStyle; columns: number }
  | {
      type: "button";
      runs: DisplayRun[];
      token: InteractionToken;
      title?: string;
      hover_style?: TextStyle;
      enabled: boolean;
      generation: number;
    }
  | { type: "html_document"; document: any }
  | { type: "image"; placement: MediaPlacement; alt_text?: string }
  | {
      type: "shape";
      shape: {
        kind: string;
        parameters: PresentationLength[];
        foreground?: Color;
        background?: Color;
      };
    }
  | { type: "column_cell"; content: DisplayRun[]; alignment: string; preferred_columns: number }
  | { type: "separator"; pattern: string; role: string; style: TextStyle }
  | { type: "space"; width: PresentationLength };

export interface InteractionToken {
  epoch: number;
  id: number;
}

export interface DisplayLine {
  line_id: number;
  temporary: boolean;
  logical_line_start: boolean;
  line_end: boolean;
  alignment: "left" | "center" | "right";
  runs: DisplayRun[];
}

export interface MediaPlacement {
  resource_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  opacity: { numerator: number; denominator: number };
  revision: number;
  hover_resource_id?: string;
  mask_resource_id?: string;
  requested_width?: PresentationLength;
  requested_height?: PresentationLength;
  requested_y?: PresentationLength;
}

export type PresentationLength =
  | { unit: "logical"; value: number }
  | { unit: "font_height_hundredths"; value: number }
  | { unit: "pixels"; value: number };
