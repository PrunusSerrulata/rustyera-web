export interface BrowserGameOutcome {
  exitCode: number;
  result: Record<string, unknown>;
}

export interface BrowserGameTrace {
  emit(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

export function finalizeBrowserGameRun(options: {
  outcome?: BrowserGameOutcome;
  runError?: unknown;
  monitor?: { stop(): Promise<void> };
  monitorError: () => unknown;
  cleanups: Array<() => unknown | Promise<unknown>>;
  trace: BrowserGameTrace;
  classifyError: (error: unknown) => BrowserGameOutcome;
}): Promise<number>;
