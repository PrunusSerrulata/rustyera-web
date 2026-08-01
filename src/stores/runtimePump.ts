import { ref } from "vue";

import type { FrontendBridge, PumpBatch } from "@/core/types";

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
    if (!this.ready || this.transitioning || this.#timer != null) return;
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
      const batch = await this.bridge.pump();
      await this.callbacks.handleBatch(batch);
      await this.callbacks.advanceTimedWait();
      this.schedule(batch.state === "more_work" || batch.state === "output_ready" ? 0 : 16);
    } catch (error) {
      this.callbacks.handleError(error);
    } finally {
      this.#pumping.value = false;
    }
  }
}
