import {
  CanvasReplayBudget,
  createCanvasReplayRenderer,
  type CanvasReplayResources,
} from "@/components/canvasReplayRenderer";
import {
  RuntimeServiceError,
  serviceInteger,
  type CanvasPixelQuery,
} from "@/core/runtimeServiceProtocol";
import type { RuntimeServiceLease } from "@/stores/runtimeServiceRequests";
import { replayIntegerKey, resolveCanvasReplay } from "@/core/replayResources";

/** Logical samples serialize; obsolete decoders retain their shared physical resource quota. */
export class RuntimeCanvasPixelSampler {
  private readonly pool = new CanvasReplayBudget();
  private readonly cancellations = new Set<() => void>();
  private tail = Promise.resolve();
  private queued = 0;
  private generation = 0;

  clear(): void {
    this.generation += 1;
    for (const cancel of this.cancellations) cancel();
  }

  async sample(
    query: CanvasPixelQuery,
    resources: CanvasReplayResources,
    resourceGeneration: number,
    lease: RuntimeServiceLease,
    current: () => boolean,
  ): Promise<number> {
    if (this.queued >= 8)
      throw new RuntimeServiceError("resource_limit", "too many queued canvas samples");
    const generation = this.generation;
    const renderer = createCanvasReplayRenderer();
    const budget = this.pool.fork();
    const controller = new AbortController();
    let stopped = false;
    let surface: HTMLCanvasElement | undefined;
    let releaseSurface: (() => void) | undefined;
    const active = () => !stopped && generation === this.generation && lease.active() && current();
    const dispose = () => {
      stopped = true;
      controller.abort();
      renderer.clear();
      if (surface) {
        surface.width = 0;
        surface.height = 0;
        surface = undefined;
      }
      releaseSurface?.();
      releaseSurface = undefined;
    };
    let rejectCancellation!: (error: RuntimeServiceError) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      dispose();
      rejectCancellation(new RuntimeServiceError("stale_projection", "canvas sample is obsolete"));
    };
    this.cancellations.add(cancel);
    lease.signal.addEventListener("abort", cancel, { once: true });
    // Bound the logical wait without pretending the browser can abort its bitmap/image decoder.
    const timeout = setTimeout(() => {
      const category = active() ? "backend_failure" : "stale_projection";
      dispose();
      rejectCancellation(
        new RuntimeServiceError(
          category,
          "canvas replay did not settle within the sampling deadline",
        ),
      );
    }, 10_000);
    this.queued += 1;
    const work = this.tail.then(async () => {
      if (!active()) throw new RuntimeServiceError("stale_projection", "canvas sample is obsolete");
      const replay = resolveCanvasReplay(resources.canvases, query.canvasId, query.canvasRevision);
      if (!replay)
        throw new RuntimeServiceError(
          "stale_projection",
          "requested canvas revision is unavailable",
        );
      // Canvas sizes are canonical u32 values; never coerce arbitrary strings or fractions.
      const width = Number(serviceInteger(replay.size.width, "canvas width"));
      const height = Number(serviceInteger(replay.size.height, "canvas height"));
      if (query.x < 0 || query.y < 0 || query.x >= width || query.y >= height)
        throw new RuntimeServiceError(
          "invalid_request",
          "canvas sample point is outside the surface",
        );
      releaseSurface = budget.reserve(width, height);
      surface = document.createElement("canvas");
      surface.width = width;
      surface.height = height;
      const context = surface.getContext("2d", { willReadFrequently: true });
      if (!context)
        throw new RuntimeServiceError("backend_failure", "canvas 2D context is unavailable");
      await renderer.replay(
        context,
        replay,
        new Set([replayIntegerKey(query.canvasId)]),
        resources,
        resourceGeneration,
        { budget, active, strict: true, signal: controller.signal },
      );
      if (!active())
        throw new RuntimeServiceError("stale_projection", "canvas revision changed during replay");
      const pixel = context.getImageData(query.x, query.y, 1, 1).data;
      return ((pixel[3] << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]) >>> 0;
    });
    // The physical work is observed by the race even after cancellation wins. Its own renderer
    // retains pending decoders and releases them on settlement, never touching a later sample.
    const result = Promise.race([work, cancelled]);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    if (!active()) cancel();
    try {
      return await result;
    } finally {
      clearTimeout(timeout);
      lease.signal.removeEventListener("abort", cancel);
      this.cancellations.delete(cancel);
      dispose();
      this.queued -= 1;
    }
  }
}
