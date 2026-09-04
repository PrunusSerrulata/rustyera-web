export interface PerformanceAuditOptions {
  enabled: boolean;
  background: boolean;
  windowMode: "visible" | "minimized" | "offscreen" | undefined;
}

export const DEFAULT_PERFORMANCE_WINDOW_MODE: "visible";
export const PERFORMANCE_WINDOW_MODES: ReadonlySet<"visible" | "minimized" | "offscreen">;
export function performanceWindowMode(
  arguments_: string[],
): "visible" | "minimized" | "offscreen";
export function performanceWindowArguments(
  mode: "visible" | "minimized" | "offscreen",
): string[];

export function performanceAuditOptions(
  arguments_: string[],
  specName: string | undefined,
  paths?: {
    repository?: string;
    requestedSpec?: string;
    resolve?(...paths: string[]): string;
  },
): PerformanceAuditOptions;

export function classifyWindowCalibration(
  minimized: Record<string, unknown>,
  offscreen: Record<string, unknown>,
): {
  selectedMode: "minimized" | "offscreen";
  minimizedToOffscreenMedianRatio: number | null;
  minimizedToOffscreenPaintRatio: number | null;
  minimizedThrottled: boolean;
  offscreenUsable: boolean;
};

export function validatePerformanceAuditProject(
  sourceProject: string,
  copiedProject?: string,
): Promise<{ source: string; copy: string | undefined }>;
export function performanceProjectDigest(root: string): Promise<string>;

export function resolvePerformanceRootPid(binary: string, platform?: NodeJS.Platform): Promise<number>;
