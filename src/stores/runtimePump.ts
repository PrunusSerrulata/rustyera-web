import { ref } from "vue";

import type { FrontendBridge, PumpBatch, SubmittedPumpBatch } from "@/core/types";
import {
  PERFORMANCE_AUDIT_ENABLED,
  recordPerformanceTiming,
  scheduleDomFlushMeasurement,
} from "@/testing/performanceAudit";

const MAXIMUM_CONTIGUOUS_COMPUTE_PUMPS = 8;

interface RuntimePumpCallbacks {
  handleBatch(batch: PumpBatch): Promise<void>;
  advanceTimedWait(): Promise<void>;
  handleError(error: unknown): void;
}

export class RuntimePumpCoordinator {
  readonly #ready = ref(false);
  readonly #pumping = ref(false);
  readonly #transitioning = ref(false);
  #timer: number | undefined;
  #handlingBatch = false;
  #backgroundWorkRevision = 0;
  readonly #idleWaiters = new Set<() => void>();

  constructor(
    private readonly bridge: Pick<FrontendBridge, "pump">,
    private readonly callbacks: RuntimePumpCallbacks,
  ) {}

  get ready(): boolean {
    return this.#ready.value;
  }

  get pumping(): boolean {
    return this.#pumping.value;
  }

  get transitioning(): boolean {
    return this.#transitioning.value;
  }

  /** Advances only when the runtime completes one cooperative background slice. Idle polling must
   * not manufacture watchdog progress. */
  get backgroundWorkRevision(): number {
    return this.#backgroundWorkRevision;
  }

  setReady(ready: boolean): void {
    this.#ready.value = ready;
  }

  setTransitioning(transitioning: boolean): void {
    this.#transitioning.value = transitioning;
  }

  clearTimer(): void {
    if (this.#timer == null) return;
    window.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  schedule(delay = 16): void {
    if (!this.ready || this.transitioning) return;
    if (this.#timer != null) {
      if (delay !== 0) return;
      window.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      void this.#pumpOnce();
    }, delay);
  }

  async waitUntilIdle(): Promise<void> {
    while (this.pumping || this.#handlingBatch)
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  /** Service handlers are detached from batch projection, so they may safely wait for the current
   * batch to finish and then submit their response through the native fused drive path. */
  async submitResponseAndHandle(
    operation: () => Promise<SubmittedPumpBatch>,
    current: () => boolean,
  ): Promise<SubmittedPumpBatch> {
    for (;;) {
      await this.waitUntilIdle();
      if (!current()) throw new RuntimePumpResponseCancelled();
      const batch = await this.submitAndHandle(() => {
        if (!current()) throw new RuntimePumpResponseCancelled();
        return operation();
      });
      if (batch) return batch;
      if (!this.ready || this.transitioning) throw new RuntimePumpResponseCancelled();
    }
  }

  async submitAndHandle(
    operation: () => Promise<SubmittedPumpBatch>,
  ): Promise<SubmittedPumpBatch | undefined> {
    // Batch handling may synchronously discover another message-skip wait. Falling back to the
    // ordered submit path avoids waiting on the coordinator operation that is awaiting this batch.
    if (this.#handlingBatch) return undefined;
    this.clearTimer();
    for (;;) {
      await this.waitUntilIdle();
      this.clearTimer();
      if (!this.ready || this.transitioning || this.#handlingBatch) return undefined;
      if (this.pumping) continue;
      this.#pumping.value = true;
      break;
    }
    try {
      const batch = await operation();
      this.#observeBackgroundWork(batch);
      this.#handlingBatch = true;
      const batchStartedAt = PERFORMANCE_AUDIT_ENABLED ? performance.now() : undefined;
      try {
        await this.callbacks.handleBatch(batch);
      } finally {
        if (PERFORMANCE_AUDIT_ENABLED) {
          recordPerformanceTiming("store_batch", "handle_batch", batchStartedAt, () => ({
            events: batch.events.length,
          }));
          scheduleDomFlushMeasurement(batchStartedAt, batch.events.length);
        }
        this.#handlingBatch = false;
      }
      this.schedule(hasPendingWork(batch) ? 0 : 16);
      return batch;
    } catch (error) {
      this.callbacks.handleError(error);
      throw new RuntimePumpSubmissionError(error);
    } finally {
      this.#pumping.value = false;
      this.#notifyIdle();
    }
  }

  async #pumpOnce(): Promise<void> {
    if (this.pumping || this.transitioning) return;
    this.#pumping.value = true;
    try {
      let batch: PumpBatch;
      let pumps = 0;
      do {
        // Sample timers at every drive boundary. Input already submitted for the visible wait is
        // therefore ordered first, and input submitted while a bridge request is in flight is
        // present for the runtime's timer/input arbitration in the next pump.
        await this.callbacks.advanceTimedWait();
        batch = await this.bridge.pump();
        this.#observeBackgroundWork(batch);
        this.#handlingBatch = true;
        const batchStartedAt = PERFORMANCE_AUDIT_ENABLED ? performance.now() : undefined;
        try {
          await this.callbacks.handleBatch(batch);
        } finally {
          if (PERFORMANCE_AUDIT_ENABLED) {
            recordPerformanceTiming("store_batch", "handle_batch", batchStartedAt, () => ({
              events: batch.events.length,
            }));
            scheduleDomFlushMeasurement(batchStartedAt, batch.events.length);
          }
          this.#handlingBatch = false;
        }
        pumps += 1;
        // VM and cooperative slices can both leave the actor idle while work remains. Avoid an
        // idle delay for every exported file, while retaining the same hard fairness boundary.
      } while (
        (batch.state === "more_work" ||
          (batch.state === "idle" && batch.cooperativeBackgroundWork)) &&
        pumps < MAXIMUM_CONTIGUOUS_COMPUTE_PUMPS &&
        this.ready &&
        !this.transitioning
      );
      this.schedule(hasPendingWork(batch) ? 0 : 16);
    } catch (error) {
      this.callbacks.handleError(error);
    } finally {
      this.#pumping.value = false;
      this.#notifyIdle();
    }
  }

  #notifyIdle(): void {
    if (this.pumping || this.#handlingBatch) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #observeBackgroundWork(batch: PumpBatch): void {
    if (batch.cooperativeBackgroundWork)
      this.#backgroundWorkRevision = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#backgroundWorkRevision + 1,
      );
  }
}

function hasPendingWork(batch: PumpBatch): boolean {
  return Boolean(
    batch.cooperativeBackgroundWork ||
    batch.state === "more_work" ||
    (batch.state === "output_ready" && (batch.immediateWork ?? true)),
  );
}

export class RuntimePumpSubmissionError extends Error {
  readonly inputMayHaveBeenAccepted = true;

  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "RuntimePumpSubmissionError";
  }
}

export class RuntimePumpResponseCancelled extends Error {
  constructor() {
    super("runtime service response was retired before submission");
    this.name = "RuntimePumpResponseCancelled";
  }
}

export function inputMayHaveBeenAccepted(error: unknown): boolean {
  return error instanceof RuntimePumpSubmissionError;
}

export function responseSubmissionCancelled(error: unknown): boolean {
  return error instanceof RuntimePumpResponseCancelled;
}
