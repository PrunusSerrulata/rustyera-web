export interface IsolatedProject {
  root: string;
  project: string;
  close(): Promise<void>;
}

export function assertAtomicPresentationTransition(
  samples: Array<{ revision: unknown; historyRevision: unknown; canInteract: boolean }>,
  completedPresentation: { revision: unknown; historyRevision: unknown },
): {
  startRevision: string;
  endRevision: string;
  startHistoryRevision: string;
  endHistoryRevision: string;
  paintedRevisions: string[];
  paintedHistoryRevisions: string[];
  samples: Array<{ revision: unknown; historyRevision: unknown; canInteract: boolean }>;
};

export function measureAnimationPerformance(audit: {
  timingSamplesDropped: number;
  timings: Array<{
    phase: string;
    operation: string;
    startedAtMs: number;
    elapsedMs: number;
    detail?: Record<string, unknown>;
  }>;
}): {
  frames: number;
  averageIntervalMs: number | null;
  medianIntervalMs: number | null;
  maximumIntervalMs: number | null;
  revisionStep: string | null;
  revisionStepConstant: boolean;
  domSynchronizedFrames: number;
  paintCheckpoints: number;
  timedOutPaintCheckpoints: number;
  maximumPaintMs: number | null;
};

export function runAction(
  page: Pick<import("@playwright/test").Page, "evaluate">,
  action: { type: "assert_interop"; expect: unknown; evidence_path?: string },
): Promise<{ query: { interop: unknown } }>;
export function runAction(
  page: Pick<import("@playwright/test").Page, "waitForEvent" | "locator">,
  action: { type: "save_download"; path: string; name_suffix: string; selector: string },
): Promise<{ query: { download: { name: string; path: string; bytes: number } } }>;
export function runAction(
  page: Pick<import("@playwright/test").Page, "evaluate" | "locator" | "waitForFunction">,
  action: {
    type: "advance_enter_waits_until";
    maximum?: number;
    auto_enter?: boolean;
    until: { output_tail_contains: string; tail_lines?: number };
  },
): Promise<{ semanticInput: string; attempts: number }>;

export function isolatedProject(
  source: string,
  options?: {
    cleanSaves?: boolean;
    compiledCache?: boolean;
    compiledCacheInput?: string;
    sourceIndexInput?: string;
    runtimeStorageInput?: string;
  },
): Promise<IsolatedProject>;

export function projectRuntimeStorageRoot(project: string): Promise<string>;

export function publishCrossHostArtifacts(options: {
  source: string;
  isolated: string;
  cacheInput?: string;
  cacheOutput?: string;
  sourceIndexInput?: string;
  sourceIndexOutput?: string;
  projectOutput?: string;
  runtimeStorageInput?: string;
  runtimeStorageOutput?: string;
  succeeded: boolean;
  cacheSaved: boolean;
}): Promise<void>;

export function installRemoteFileSystem(
  page: {
    exposeBinding(
      name: string,
      callback: (source: unknown, request: unknown) => unknown,
    ): Promise<void>;
    addInitScript(script: () => void): Promise<void>;
  },
  root: string,
): Promise<void>;
