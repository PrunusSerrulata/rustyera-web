export interface StartupSample {
  peakRssBytes: number;
  telemetry: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StartupSummary {
  samples: StartupSample[];
  metrics: Record<string, { p50: number; p95: number }>;
}

export const CONSTRAINED_MOBILE_USER_AGENT: string;

export function browserBenchmarkCommandArgs(options: {
  scenario: string;
  project: string;
  projectFile?: string;
  trace: string;
  constrained?: boolean;
}): string[];

export function compareDirectoryAndProjectFile(
  directory: StartupSummary,
  projectFile: StartupSummary,
): {
  sampleCount: number;
  wasmMemoryPeakBytes: {
    p50: { directory: number; projectFile: number; delta: number; ratio: number | null };
    p95: { directory: number; projectFile: number; delta: number; ratio: number | null };
  };
  peakRssBytes: {
    p50: { directory: number; projectFile: number; delta: number; ratio: number | null };
    p95: { directory: number; projectFile: number; delta: number; ratio: number | null };
  };
};

export function latestSuccessfulStartupTelemetry(
  events: Array<Record<string, unknown>>,
): Record<string, unknown>;

export function validateStartupSample(sample: StartupSample, scenarioName: string): StartupSample;

export function summarizeStartupSamples(samples: StartupSample[]): StartupSummary;

export function percentile(values: number[], fraction: number): number;
