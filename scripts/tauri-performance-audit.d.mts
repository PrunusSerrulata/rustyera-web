export interface PerformanceAuditOptions {
  enabled: boolean;
  background: boolean;
  windowMode: "visible" | "minimized" | undefined;
}

export const DEFAULT_PERFORMANCE_WINDOW_MODE: "visible";
export const PERFORMANCE_WINDOW_MODES: ReadonlySet<"visible" | "minimized">;
export function performanceCommandTimeoutMs(performanceEnabled: boolean): number;
export function performanceSnapshotMode(
  performanceEnabled: boolean,
  heavyDiagnostics?: boolean,
): "complete" | "performance-diagnostic" | "performance-progress";
export function performanceWindowMode(arguments_: string[]): "visible" | "minimized";
export function performanceWindowArguments(mode: "visible" | "minimized"): string[];
export function performanceCaptureChildArguments(
  project: string,
  mode: "visible" | "minimized",
): string[];
export function refreshPerformanceSession(
  browser: {
    refresh(): Promise<unknown>;
    execute<T, A extends unknown[]>(script: (...args: A) => T, ...args: A): Promise<T>;
    waitUntil(
      condition: () => Promise<boolean>,
      options: { timeout: number; interval: number; timeoutMsg: string },
    ): Promise<unknown>;
  },
  projectCopy: string,
  waitForControl: () => Promise<unknown>,
): Promise<void>;
export function instrumentedPerformanceWindowMode(
  options: PerformanceAuditOptions,
  instrumentPerformance: boolean,
): "visible" | "minimized" | undefined;

export function performanceAuditOptions(
  arguments_: string[],
  specName: string | undefined,
  paths?: {
    repository?: string;
    requestedSpec?: string;
    resolve?(...paths: string[]): string;
  },
): PerformanceAuditOptions;

export function minimizePerformanceWindow(browser: {
  minimizeWindow(): Promise<unknown>;
}): Promise<void>;
export function waitForPerformanceWindowSafety<T>(
  browser: {
    waitUntil(
      condition: () => Promise<unknown>,
      options: { timeout: number; interval: number; timeoutMsg: string },
    ): Promise<unknown>;
  },
  inspectWindow: () => Promise<T>,
): Promise<T>;
export function readPerformanceWindowState(browser: {
  execute(
    script: (...arguments_: unknown[]) => unknown,
    ...arguments_: unknown[]
  ): Promise<unknown>;
}): Promise<Record<string, unknown>>;
export function capturePerformanceWindowSafety(
  browser: {
    execute(
      script: (...arguments_: unknown[]) => unknown,
      ...arguments_: unknown[]
    ): Promise<unknown>;
  },
  foregroundBaseline: unknown,
  rootPid: number,
  dependencies?: {
    observeForegroundApplication?(): Promise<{ pid?: number } | null>;
    capturePerformanceProcessTree?(rootPid: number): Promise<Array<{ pid: number }>>;
  },
): Promise<Record<string, unknown>>;

export function validatePerformanceAuditProject(
  sourceProject: string,
  copiedProject?: string,
): Promise<{ source: string; copy: string | undefined }>;
export function ensurePerformanceProjectCopy(
  sourceProject: string,
  copiedProject: string,
): Promise<{ source: string; copy: string; projectDigest: string; created: boolean }>;
export function validateExistingPerformanceProjectCopy(
  sourceProject: string,
  copiedProject: string,
  expectedDigest?: string,
): Promise<string>;
export function validatePerformanceProjectCopyMarker(
  sourceProject: string,
  copiedProject: string,
  expectedDigest?: string,
): Promise<{ source: string; copy: string; sourceDigest: string }>;
export function performanceProjectDigest(root: string): Promise<string>;

export function resolvePerformanceRootPid(
  binary: string,
  platform?: NodeJS.Platform,
): Promise<number>;
export function performanceTelemetryCompleteness(telemetry: {
  frontend: { timingSamplesDropped: number; longTasksDropped: number };
  native: { dropped: number };
}): {
  complete: boolean;
  timingSamplesDropped: number;
  longTasksDropped: number;
  nativeDropped: number;
};
