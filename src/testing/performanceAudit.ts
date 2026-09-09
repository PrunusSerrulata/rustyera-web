import { nextTick } from "vue";

export type PerformanceAuditPhase =
  | "loading"
  | "transport"
  | "invoke"
  | "decode"
  | "store_batch"
  | "presentation"
  | "dom_mutation"
  | "dom_flush"
  | "canvas_replay"
  | "next_paint";
type Detail = Record<string, number | string | boolean | null>;
export interface TimingSample {
  epoch: number;
  sequence: number;
  phase: PerformanceAuditPhase;
  operation: string;
  elapsedMs: number;
  startedAtMs: number;
  detail?: Detail;
}

export class PerformanceAuditRingBuffer<T> {
  readonly #items: Array<T | undefined>;
  #start = 0;
  #length = 0;
  dropped = 0;
  constructor(capacity: number) {
    this.#items = new Array(capacity);
  }
  push(value: T): void {
    if (this.#length < this.#items.length) {
      this.#items[(this.#start + this.#length) % this.#items.length] = value;
      this.#length += 1;
      return;
    }
    this.#items[this.#start] = value;
    this.#start = (this.#start + 1) % this.#items.length;
    this.dropped += 1;
  }
  clear(): void {
    this.#items.fill(undefined);
    this.#start = 0;
    this.#length = 0;
    this.dropped = 0;
  }
  values(): T[] {
    return Array.from({ length: this.#length }, (_, index) => {
      const value = this.#items[(this.#start + index) % this.#items.length];
      if (value === undefined) throw new Error("performance telemetry ring is corrupt");
      return value;
    });
  }
  take(limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
      throw new Error("performance telemetry chunk limit must be between 1 and 1024");
    const count = Math.min(limit, this.#length);
    const values: T[] = [];
    for (let index = 0; index < count; index += 1) {
      const slot = (this.#start + index) % this.#items.length;
      const value = this.#items[slot];
      if (value === undefined) throw new Error("performance telemetry ring is corrupt");
      values.push(value);
      this.#items[slot] = undefined;
    }
    this.#start = (this.#start + count) % this.#items.length;
    this.#length -= count;
    return values;
  }
  get length(): number {
    return this.#length;
  }
}

const MAXIMUM_SAMPLES = 20_000;
export const PERFORMANCE_AUDIT_ENABLED = import.meta.env.VITE_RUSTYERA_PERF_AUDIT === "1";
const timings = PERFORMANCE_AUDIT_ENABLED
  ? new PerformanceAuditRingBuffer<TimingSample>(MAXIMUM_SAMPLES)
  : undefined;
const longTasks = PERFORMANCE_AUDIT_ENABLED
  ? new PerformanceAuditRingBuffer<{
      epoch: number;
      sequence: number;
      startedAtMs: number;
      elapsedMs: number;
    }>(MAXIMUM_SAMPLES)
  : undefined;
let epoch = 0;
let nextSequence = 0;
let nextLongTaskSequence = 0;
let mutationCallbacks = 0;
let mutatedNodes = 0;
let mutationObserver: MutationObserver | undefined;
let longTaskObserver: PerformanceObserver | undefined;
interface PendingObservation {
  epoch: number;
  done: Promise<boolean>;
  settle: (complete: boolean) => void;
  cancel?: () => void;
}
let paintMeasurementPending: PendingObservation | undefined;
let flushMeasurementPending: PendingObservation | undefined;
let observerFailures = 0;
function pendingObservation(): PendingObservation {
  let settle!: (complete: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { epoch, done, settle };
}
let observedFlushPublication = 0;
let calibrationFramesObserved = 0;
let publishedPresentationRevision: string | null = null;
let publishedPresentationFrames = 0;

export function performanceAuditEnabled(): boolean {
  return PERFORMANCE_AUDIT_ENABLED;
}
export function recordPerformanceTiming(
  phase: PerformanceAuditPhase,
  operation: string,
  startedAtMs: number | undefined,
  detail?: Detail | (() => Detail),
): void {
  if (startedAtMs == null || !performanceAuditEnabled()) return;
  pushTiming({
    phase,
    operation,
    elapsedMs: performance.now() - startedAtMs,
    startedAtMs,
    detail,
  });
}

export function recordPerformanceElapsed(
  phase: PerformanceAuditPhase,
  operation: string,
  elapsedMs: number | null | undefined,
  detail?: Detail | (() => Detail),
): void {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || !performanceAuditEnabled()) return;
  pushTiming({
    phase,
    operation,
    elapsedMs: Math.max(0, elapsedMs),
    startedAtMs: performance.now() - Math.max(0, elapsedMs),
    detail,
  });
}

export function recordPublishedPresentationRevision(revision: unknown): void {
  if (!performanceAuditEnabled()) return;
  publishedPresentationRevision = String(revision);
  publishedPresentationFrames += 1;
}

function pushTiming(sample: {
  phase: PerformanceAuditPhase;
  operation: string;
  elapsedMs: number;
  startedAtMs: number;
  detail?: Detail | (() => Detail);
}): void {
  timings?.push({
    epoch,
    sequence: nextSequence++,
    phase: sample.phase,
    operation: sample.operation,
    elapsedMs: sample.elapsedMs,
    startedAtMs: sample.startedAtMs,
    detail: typeof sample.detail === "function" ? sample.detail() : sample.detail,
  });
}

/** Observe Vue's already scheduled flush without holding up the production pump.
 * Concurrent batches share one observer; this is a coalesced flush, not a per-batch paint. */
export function scheduleDomFlushMeasurement(startedAtMs: number | undefined, events: number): void {
  if (
    startedAtMs == null ||
    !performanceAuditEnabled() ||
    flushMeasurementPending ||
    observedFlushPublication === publishedPresentationFrames
  )
    return;
  const token = pendingObservation();
  flushMeasurementPending = token;
  const reject = () => {
    if (flushMeasurementPending !== token || token.epoch !== epoch) return;
    flushMeasurementPending = undefined;
    observerFailures += 1;
    observedFlushPublication = publishedPresentationFrames;
    recordPerformanceTiming("dom_flush", "observer_rejected", startedAtMs);
    token.settle(false);
  };
  try {
    void nextTick()
      .then(() => {
        if (flushMeasurementPending !== token || token.epoch !== epoch) return;
        observedFlushPublication = publishedPresentationFrames;
        recordPerformanceTiming("dom_flush", "coalesced_vue_next_tick", startedAtMs, { events });
        scheduleNextPaintMeasurement(startedAtMs);
        if (paintMeasurementPending) void paintMeasurementPending.done.then(token.settle);
        else token.settle(true);
        flushMeasurementPending = undefined;
      })
      .catch(reject);
  } catch {
    reject();
  }
}

export function scheduleNextPaintMeasurement(
  startedAtMs: number | undefined,
  timeoutMs = 1_000,
): void {
  if (startedAtMs == null || !performanceAuditEnabled() || paintMeasurementPending) return;
  const token = pendingObservation();
  paintMeasurementPending = token;
  const measurementEpoch = epoch;
  const presentationRevision = publishedPresentationRevision;
  let settled = false;
  let frame: number | undefined;
  const timeout = window.setTimeout(() => finish(true), timeoutMs);
  token.cancel = () => {
    settled = true;
    window.clearTimeout(timeout);
    if (frame !== undefined) cancelAnimationFrame(frame);
    token.settle(false);
  };
  frame = requestAnimationFrame(() => {
    if (!settled) frame = requestAnimationFrame(() => finish(false));
  });
  function finish(timedOut: boolean): void {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (paintMeasurementPending !== token || measurementEpoch !== epoch) return;
    paintMeasurementPending = undefined;
    // A suppressed paint has a terminal timedOut sample, not a missing observer result.
    // Consumers must not interpret that sample as evidence of an actual paint.
    token.settle(true);
    recordPerformanceTiming("next_paint", "presentation", startedAtMs, () => ({
      timedOut,
      epoch: measurementEpoch,
      presentationRevision,
    }));
  }
}

/** Wait only for observers already owned at entry, including a flush's paint child. */
export async function waitForPendingPerformanceObservations(timeoutMs = 30_000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error("invalid performance observation timeout");
  const pending = [flushMeasurementPending, paintMeasurementPending].filter(
    (value): value is PendingObservation => value !== undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const complete = await Promise.race([
      Promise.all(pending.map((value) => value.done)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("incomplete performance observations: timeout")),
          timeoutMs,
        );
      }),
    ]);
    if (observerFailures > 0 || complete.some((value) => !value))
      throw new Error("incomplete performance observations");
  } finally {
    clearTimeout(timer);
  }
}

export function installPerformanceAuditObservers(): void {
  if (!performanceAuditEnabled() || mutationObserver) return;
  mutationObserver = new MutationObserver((records) => {
    const startedAtMs = performance.now();
    mutationCallbacks += 1;
    mutatedNodes += records.reduce(
      (total, record) => total + record.addedNodes.length + record.removedNodes.length + 1,
      0,
    );
    recordPerformanceTiming("dom_mutation", "observer_callback", startedAtMs, () => ({
      records: records.length,
      presentationRevision: publishedPresentationRevision,
    }));
  });
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks?.push({
          epoch,
          sequence: nextLongTaskSequence++,
          startedAtMs: entry.startTime,
          elapsedMs: entry.duration,
        });
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    longTaskObserver = undefined;
  }
}

export function resetPerformanceAudit(): number {
  flushMeasurementPending?.settle(false);
  paintMeasurementPending?.cancel?.();
  flushMeasurementPending = undefined;
  paintMeasurementPending = undefined;
  observerFailures = 0;
  epoch += 1;
  nextSequence = 0;
  nextLongTaskSequence = 0;
  timings?.clear();
  longTasks?.clear();
  mutationCallbacks = 0;
  mutatedNodes = 0;
  calibrationFramesObserved = 0;
  publishedPresentationRevision = null;
  publishedPresentationFrames = 0;
  observedFlushPublication = 0;
  return epoch;
}
export function performanceAuditProgress(): Record<string, number> {
  return {
    epoch,
    calibrationFramesObserved,
    publishedPresentationFrames,
    timingSamples: timings?.length ?? 0,
    timingSamplesDropped: timings?.dropped ?? 0,
    mutationCallbacks,
    mutatedNodes,
    longTasks: longTasks?.length ?? 0,
    longTasksDropped: longTasks?.dropped ?? 0,
    longTaskObserverInstalled: longTaskObserver ? 1 : 0,
  };
}
export function performanceAuditSnapshot(): Record<string, unknown> {
  const samples = timings?.values() ?? [];
  return performanceAuditState(samples, longTasks?.values() ?? []);
}

/** Move only new bounded records to the capture client; epoch/sequence/drop counters
 * are never reset. A failed transfer is a failed capture, not permission to retry silently. */
export function takePerformanceAudit(limit = 512): Record<string, unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
    throw new Error("performance telemetry chunk limit must be between 1 and 1024");
  return performanceAuditState(timings?.take(limit) ?? [], longTasks?.take(limit) ?? []);
}

function performanceAuditState(
  samples: TimingSample[],
  taskSamples: unknown[],
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    observedAtMs: performance.now(),
    epoch,
    nextSequence,
    nextLongTaskSequence,
    longTaskObserverInstalled: longTaskObserver ? 1 : 0,
    remainingSamples: timings?.length ?? 0,
    remainingLongTasks: longTasks?.length ?? 0,
    timings: samples,
    timingSamplesDropped: timings?.dropped ?? 0,
    mutationCallbacks,
    mutatedNodes,
    longTasks: taskSamples,
    longTasksDropped: longTasks?.dropped ?? 0,
    segments: {
      loading: { timingSamples: samples.filter((sample) => sample.phase === "loading").length },
      runtime: { timingSamples: samples.filter((sample) => sample.phase !== "loading").length },
    },
  };
}

export async function calibratePerformanceFrames(
  frameCount = 100,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(frameCount) || frameCount < 2 || frameCount > 1_000)
    throw new Error("performance frame count must be an integer between 2 and 1000");
  const deadline = performance.now() + timeoutMs;
  const frameTimes: number[] = [];
  const paintCheckpointDelays: number[] = [];
  let previous = performance.now();
  while (frameTimes.length < frameCount && performance.now() < deadline) {
    const requestedAt = performance.now();
    const current = await nextFrameBefore(deadline);
    if (current == null) break;
    frameTimes.push(current - previous);
    paintCheckpointDelays.push(current - requestedAt);
    calibrationFramesObserved = frameTimes.length;
    previous = current;
  }
  await nextTick();
  const ordered = [...frameTimes].sort((left, right) => left - right);
  const orderedPaintDelays = [...paintCheckpointDelays].sort((left, right) => left - right);
  return {
    requestedFrames: frameCount,
    observedFrames: frameTimes.length,
    intervalsMs: frameTimes,
    paintCheckpointDelaysMs: paintCheckpointDelays,
    medianIntervalMs: percentile(ordered, 0.5),
    p95IntervalMs: percentile(ordered, 0.95),
    maximumIntervalMs: ordered.at(-1) ?? null,
    medianPaintCheckpointMs: percentile(orderedPaintDelays, 0.5),
    p95PaintCheckpointMs: percentile(orderedPaintDelays, 0.95),
    nonBusinessStallsOver100Ms: frameTimes.filter((value) => value > 100).length,
    timedOut: frameTimes.length !== frameCount,
    visibilityState: document.visibilityState,
    focused: document.hasFocus(),
  };
}
async function nextFrameBefore(deadline: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(
      () => finish(undefined),
      Math.max(0, deadline - performance.now()),
    );
    requestAnimationFrame((timestamp) => finish(timestamp));
    function finish(value: number | undefined): void {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(value);
    }
  });
}
function percentile(ordered: readonly number[], quantile: number): number | null {
  if (ordered.length === 0) return null;
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))];
}
