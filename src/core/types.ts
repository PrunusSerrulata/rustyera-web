export type RuntimeMessage = { type: string; value?: any };
export type DebugMessage = { type: string; value?: any };

export interface WebEvent {
  channel: "runtime" | "debug";
  sequence: number | bigint;
  messageId: number | bigint;
  correlationId?: number | bigint;
  epoch?: number | bigint;
  message: RuntimeMessage | DebugMessage;
}

export interface PumpBatch {
  state: "idle" | "more_work" | "output_ready" | "stopped" | "faulted";
  vmInstructions: number | bigint;
  runtimeTransitions: number;
  events: WebEvent[];
}

export interface Preferences {
  schemaVersion: 1;
  fontFamilyOverride: string | null;
  fontSizeOverridePx: number | null;
  imageScale: number;
  masterVolume: number;
}

export const defaultPreferences = (): Preferences => ({
  schemaVersion: 1,
  fontFamilyOverride: null,
  fontSizeOverridePx: 12,
  imageScale: 1,
  masterVolume: 1,
});

export interface SessionOptions {
  clientName: string;
  availableFonts: string[];
  preferredLocales: string[];
  audioAvailable: boolean;
  debugScopeMask: number;
  maximumEnvelopeBytes: number;
}

export interface ProjectOpenMetrics {
  quickScanMs: number;
  cacheReadMs: number;
  sourceReadMs: number;
  submitMs: number;
  cacheImported: boolean;
}

export interface FrontendBridge {
  readonly kind: "tauri" | "browser";
  createSession(options: SessionOptions): Promise<PumpBatch>;
  submitRuntime(message: RuntimeMessage, correlationId?: number): Promise<number | bigint>;
  submitDebug(message: DebugMessage, correlationId?: number): Promise<number | bigint>;
  pump(): Promise<PumpBatch>;
  openProject(): Promise<ProjectOpenMetrics | undefined>;
  submitProjectSource(): Promise<void>;
  reloadProject(): Promise<void>;
  readResource(relativePath: string): Promise<Uint8Array>;
  readImageMetadata(relativePath: string): Promise<{
    width: number;
    height: number;
    format: string;
    animated: boolean;
  }>;
  handleStorage(request: any): Promise<any>;
  listFonts(): Promise<string[]>;
  loadPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<Preferences>;
  openUpload(): Promise<Uint8Array | undefined>;
  saveDownload(name: string, bytes: Uint8Array): Promise<void>;
  writeCompiledCacheChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void>;
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
  font_millipoints: number;
}

export type DisplayRun =
  | { type: "text"; text: string; style: TextStyle }
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
  | { type: "shape"; shape: any }
  | { type: "column_cell"; content: DisplayRun[]; alignment: string; preferred_columns: number }
  | { type: "separator"; pattern: string; role: string }
  | { type: "space"; width: any };

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
