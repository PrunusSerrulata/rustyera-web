export interface CompleteSnapshotMonitor {
  failure: Promise<never>;
  stop(): Promise<void>;
}

export interface CompleteSnapshotMonitorOptions {
  deadline?: number;
  describeDeadline?: () => string;
  eventType?: string;
  interval?: number;
  label?: string;
  output?: (event: string) => void;
  snapshotContext?: () => unknown;
}

export function snapshotProgressSignature(snapshot: unknown): string;

export function snapshotCaptureTimeout(previousSnapshot: unknown, interval?: number): number;

export function assertSnapshotProgress(
  previousSnapshot: unknown,
  currentSnapshot: unknown,
  label?: string,
  identicalIntervals?: number,
  signatures?: { previous?: string; current?: string },
): void;

export function resolveTauriBinary(
  targetDirectory: string,
  release: boolean,
  platform?: NodeJS.Platform,
): string;

export function startCompleteSnapshotMonitor(
  browser: { execute(script: () => unknown): Promise<unknown> },
  options?: CompleteSnapshotMonitorOptions,
): CompleteSnapshotMonitor;
