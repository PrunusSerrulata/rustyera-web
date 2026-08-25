import { ref } from "vue";

import type { FrontendBridge, PumpBatch } from "@/core/types";

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
        await this.callbacks.handleBatch(batch);
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
}
