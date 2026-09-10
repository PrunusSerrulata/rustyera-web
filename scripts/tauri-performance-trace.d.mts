export interface PerformanceSampleSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  minimum: number | null;
  maximum: number | null;
  coefficientOfVariation: number;
}

export const PERFORMANCE_TRACE_SCHEMA_VERSION: 3;
export const MAXIMUM_PERFORMANCE_TRACE_BYTES: number;
export function assertCpuWindowCapture(env: Record<string, string | undefined>): void;
export function coreTraceAction(action: Record<string, unknown>): Record<string, unknown>;
export function performanceCheckpointBehaviorHash(value: Record<string, unknown>): string;

export function readPerformanceTrace(path: string | URL): Promise<Record<string, unknown>>;
export function freezePerformanceTrace(
  candidatePath: string,
  outputPath: string,
  coreOutputPath?: string,
): Promise<{ trace: Record<string, unknown>; coreTrace: Record<string, unknown> }>;
export function coreTraceFromPerformanceTrace(
  trace: Record<string, unknown>,
): Record<string, unknown>;
export function validatePerformanceTraceAction(
  action: Record<string, unknown>,
  pathClass?: string,
): void;
export function assertSecondaryClickProtocolActions(
  action: Record<string, unknown>,
  protocolActions: Array<Record<string, unknown>>,
  pathClass?: string,
): void;
export function summarizeSamples(samples: number[]): PerformanceSampleSummary;
export function summarizeRuns(runs: Array<Record<string, unknown>>): {
  runs: number;
  responseTimingBasis: string | null;
  byPath: Record<string, PerformanceSampleSummary>;
  harnessByPath: Record<string, PerformanceSampleSummary>;
};
