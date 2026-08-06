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

export function startCompleteSnapshotMonitor(
  browser: { execute(script: () => unknown): Promise<unknown> },
  options?: CompleteSnapshotMonitorOptions,
): CompleteSnapshotMonitor;
