export interface StartupSample {
  peakRssBytes: number;
  telemetry: Record<string, unknown>;
  [key: string]: unknown;
}

export function validateStartupSample(sample: StartupSample, scenarioName: string): StartupSample;

export function summarizeStartupSamples(samples: StartupSample[]): {
  samples: StartupSample[];
  metrics: Record<string, { p50: number; p95: number }>;
};

export function percentile(values: number[], fraction: number): number;
