export interface PerformanceSampleSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  minimum: number | null;
  maximum: number | null;
  coefficientOfVariation: number;
}

export function readPerformanceTrace(path: string | URL): Promise<Record<string, unknown>>;
export function freezePerformanceTrace(
  candidatePath: string,
  outputPath: string,
  coreOutputPath?: string,
): Promise<{ trace: Record<string, unknown>; coreTrace: Record<string, unknown> }>;
export function coreTraceFromPerformanceTrace(
  trace: Record<string, unknown>,
): Record<string, unknown>;
export function summarizeSamples(samples: number[]): PerformanceSampleSummary;
export function summarizeRuns(runs: Array<Record<string, unknown>>): {
  runs: number;
  byPath: Record<string, PerformanceSampleSummary>;
};
