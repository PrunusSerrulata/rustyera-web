import {
  RuntimeServiceError,
  sameServiceInteger,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";

export interface RuntimeServiceLease {
  readonly signal: AbortSignal;
  readonly duplicate: boolean;
  active(): boolean;
  assertActive(): void;
  finish(): void;
}

/** Request IDs are meaningful only within the current frontend lifecycle and runtime epoch. */
export class RuntimeServiceRequests {
  private epoch: ServiceInteger | undefined;
  private readonly pending = new Map<string, AbortController>();
  private generation = 0;

  enterEpoch(epoch: ServiceInteger): void {
    serviceInteger(epoch, "runtime epoch");
    if (this.epoch != null && sameServiceInteger(this.epoch, epoch)) return;
    this.reset();
    this.epoch = epoch;
  }

  begin(requestId: ServiceInteger, epoch: ServiceInteger): RuntimeServiceLease {
    serviceInteger(requestId, "service request ID");
    if (!sameServiceInteger(epoch, this.epoch))
      throw new RuntimeServiceError("stale_projection", "service epoch is obsolete");
    const key = String(requestId);
    const duplicate = this.pending.has(key);
    this.cancel(requestId);
    if (this.pending.size >= 32)
      throw new RuntimeServiceError("resource_limit", "too many active frontend services");
    const controller = new AbortController();
    const generation = this.generation;
    this.pending.set(key, controller);
    const active = () =>
      generation === this.generation &&
      !controller.signal.aborted &&
      this.pending.get(key) === controller;
    return {
      signal: controller.signal,
      duplicate,
      active,
      assertActive() {
        if (!active())
          throw new RuntimeServiceError("stale_projection", "frontend service was cancelled");
      },
      finish: () => {
        if (this.pending.get(key) === controller) this.pending.delete(key);
      },
    };
  }

  cancel(requestId: ServiceInteger): void {
    const key = String(serviceInteger(requestId, "service request ID"));
    this.pending.get(key)?.abort();
    this.pending.delete(key);
  }

  reset(): void {
    this.generation += 1;
    for (const request of this.pending.values()) request.abort();
    this.pending.clear();
    this.epoch = undefined;
  }
}
