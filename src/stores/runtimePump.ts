import { ref } from "vue";

import type { FrontendBridge, PumpBatch, SubmittedPumpBatch } from "@/core/types";

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
    while (this.pumping)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
      try {
        await this.callbacks.handleBatch(batch);
      } finally {
        this.#handlingBatch = false;
      }
      if (import.meta.env.VITE_RUSTYERA_TEST === "1")
        performance.mark("rustyera:settlement-batch-handled");
      this.schedule(batch.state === "more_work" || batch.state === "output_ready" ? 0 : 16);
      return batch;
    } catch (error) {
      this.callbacks.handleError(error);
      throw new RuntimePumpSubmissionError(error);
    } finally {
      this.#pumping.value = false;
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
        try {
          await this.callbacks.handleBatch(batch);
        } finally {
          this.#handlingBatch = false;
        }
        pumps += 1;
        // Compute-only slices have no frame for the browser to present. Continue them without a
        // zero-delay timer (and its nested-timer clamp), but retain a hard fairness boundary.
      } while (
        batch.state === "more_work" &&
        pumps < MAXIMUM_CONTIGUOUS_COMPUTE_PUMPS &&
        this.ready &&
        !this.transitioning
      );
      this.schedule(batch.state === "more_work" || batch.state === "output_ready" ? 0 : 16);
    } catch (error) {
      this.callbacks.handleError(error);
    } finally {
      this.#pumping.value = false;
    }
  }

  #observeBackgroundWork(batch: PumpBatch): void {
    if (batch.cooperativeBackgroundWork)
      this.#backgroundWorkRevision = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#backgroundWorkRevision + 1,
      );
  }
}

export class RuntimePumpSubmissionError extends Error {
  readonly inputMayHaveBeenAccepted = true;

  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "RuntimePumpSubmissionError";
  }
}

export function inputMayHaveBeenAccepted(error: unknown): boolean {
  return error instanceof RuntimePumpSubmissionError;
}
