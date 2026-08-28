import type { InjectionKey } from "vue";

import { CanvasReplayBudget, type CanvasReplayResources } from "@/components/canvasReplayRenderer";
import { HTML_MEASUREMENT_LIMITS, type HtmlQueryStyle } from "@/core/htmlMeasurement";
import { acquireResourceUrl, type ResourceUrlLease } from "@/core/resources";
import {
  RuntimeServiceError,
  type ProjectionQueryContext,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { FrontendBridge, Preferences } from "@/core/types";

export interface HtmlMeasurementGuard {
  readonly signal: AbortSignal;
  /** The caller checks request/epoch plus all three projection revisions and resource generation. */
  assertCurrent(): void;
}
export interface HtmlMeasurementResources extends CanvasReplayResources {
  sprites?: (NonNullable<CanvasReplayResources["sprites"]>[number] & {
    size?: readonly ServiceInteger[];
  })[];
}
export interface HtmlMeasurementBinding {
  viewport: HTMLElement;
  context: ProjectionQueryContext;
  resources: HtmlMeasurementResources;
  resourceGeneration: number;
  preferences: Pick<Preferences, "fontFamilyOverride" | "fontSizeOverridePx" | "imageScale">;
  replaceFullWidthSpaces: boolean;
  resourceBridge: FrontendBridge;
}
export interface HtmlRenderState {
  presentation: { settings: HtmlQueryStyle["settings"]; resources: HtmlMeasurementResources };
  effectivePreferences: HtmlMeasurementBinding["preferences"];
  projectResourceGeneration: number;
  gameTextStyle: { fontSizePx: number };
  gameLineHeightPx: number;
  replaceFullWidthSpaces: boolean;
  canInteract: false;
  interactionEnabled(interaction: unknown): false;
  activate(token: unknown): Promise<void>;
}
type HtmlMeasurementPhase =
  | "vue-flush"
  | "media-settle"
  | "media-work"
  | "font-load"
  | "font-ready"
  | "image-metadata"
  | "image-url"
  | "image-decode";
export interface HtmlMeasurementProjection {
  readonly state: HtmlRenderState;
  readonly resourceBridge: FrontendBridge;
  readonly signal: AbortSignal;
  readonly budget: CanvasReplayBudget;
  assertCurrent(): void;
  active(): boolean;
  wait<T>(promise: Promise<T>, phase?: HtmlMeasurementPhase): Promise<T>;
  track(promise: Promise<unknown>): void;
  acquireImage(
    resourceId: string,
    revision: number,
  ): { ready: Promise<{ url: string; width: number; height: number }>; release(): void };
}
export const htmlMeasurementProjectionKey: InjectionKey<HtmlMeasurementProjection> = Symbol(
  "html-measurement-projection",
);

/** All transient renderer work belongs to one measured tree, never to the visible runtime store. */
export class HtmlMeasurementScope implements HtmlMeasurementProjection {
  readonly budget: CanvasReplayBudget;
  readonly state: HtmlRenderState;
  readonly resourceBridge: FrontendBridge;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly waitPhases = new Map<symbol, HtmlMeasurementPhase>();
  private readonly releases = new Set<() => void>();
  private failure?: RuntimeServiceError;
  private imageCount = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly styleIdentity: string;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly relayAbort: () => void;

  constructor(
    readonly binding: HtmlMeasurementBinding,
    style: HtmlQueryStyle,
    private readonly guard: HtmlMeasurementGuard,
    budget = new CanvasReplayBudget(),
  ) {
    this.budget = budget;
    this.width = binding.viewport.clientWidth;
    this.height = binding.viewport.clientHeight;
    this.styleIdentity = measurementViewportIdentity(binding.viewport);
    const fontSize =
      binding.preferences.fontSizeOverridePx ?? Number(style.base.font_millipixels) / 1000;
    this.state = {
      presentation: { settings: structuredClone(style.settings), resources: binding.resources },
      effectivePreferences: { ...binding.preferences },
      projectResourceGeneration: binding.resourceGeneration,
      gameTextStyle: { fontSizePx: fontSize },
      gameLineHeightPx:
        binding.preferences.fontSizeOverridePx == null
          ? Number(style.settings.line_height) / 1000
          : fontSize + 1,
      replaceFullWidthSpaces: binding.replaceFullWidthSpaces,
      canInteract: false,
      interactionEnabled: () => false,
      activate: async () => {
        throw new RuntimeServiceError(
          "invalid_request",
          "a measurement projection cannot activate interactions",
        );
      },
    };
    this.resourceBridge = binding.resourceBridge;
    this.relayAbort = () => this.controller.abort();
    guard.signal.addEventListener("abort", this.relayAbort, { once: true });
    this.timeout = setTimeout(() => {
      const owner = binding.viewport.ownerDocument;
      const phase = [...new Set(this.waitPhases.values())].sort().join(",") || "render";
      this.failure ??= new RuntimeServiceError(
        "backend_failure",
        "HTML fonts or media did not settle within the measurement deadline; " +
          `phase=${phase}; visibilityState=${owner.visibilityState}; ` +
          `hasFocus=${owner.hasFocus()}; fonts.status=${owner.fonts?.status ?? "unavailable"}`,
      );
      this.controller.abort();
    }, 10_000);
  }

  assertCurrent(): void {
    if (this.failure) throw this.failure;
    if (this.signal.aborted || this.guard.signal.aborted)
      throw new RuntimeServiceError("stale_projection", "HTML measurement was cancelled");
    this.guard.assertCurrent();
    const viewport = this.binding.viewport;
    if (
      !viewport.isConnected ||
      viewport.ownerDocument !== document ||
      viewport.clientWidth !== this.width ||
      viewport.clientHeight !== this.height ||
      measurementViewportIdentity(viewport) !== this.styleIdentity
    )
      throw new RuntimeServiceError(
        "stale_projection",
        "HTML viewport geometry or style is obsolete",
      );
  }

  active(): boolean {
    try {
      this.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  async wait<T>(promise: Promise<T>, phase: HtmlMeasurementPhase = "media-work"): Promise<T> {
    this.assertCurrent();
    // Media may wait concurrently with the renderer. Keep only still-pending phases rather
    // than letting one completed child overwrite the phase of another unfinished operation.
    const token = Symbol();
    this.waitPhases.set(token, phase);
    let abort: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          this.failure ??
            new RuntimeServiceError("stale_projection", "HTML measurement was cancelled"),
        );
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([promise, cancellation]);
      this.assertCurrent();
      return value;
    } finally {
      this.waitPhases.delete(token);
      if (abort) this.signal.removeEventListener("abort", abort);
    }
  }

  track(promise: Promise<unknown>): void {
    const tracked = promise
      .catch((error: unknown) => {
        this.failure ??=
          error instanceof RuntimeServiceError
            ? error
            : new RuntimeServiceError(
                "backend_failure",
                error instanceof Error ? error.message : "HTML renderer resource failed",
              );
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async settle(): Promise<void> {
    this.assertCurrent();
    while (this.pending.size) await this.wait(Promise.all([...this.pending]), "media-settle");
    this.assertCurrent();
  }

  acquireImage(
    resourceId: string,
    revision: number,
  ): { ready: Promise<{ url: string; width: number; height: number }>; release(): void } {
    let lease: ResourceUrlLease | undefined;
    let decoded: HTMLImageElement | undefined;
    let releasePixels: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease?.release();
      if (decoded) decoded.src = "";
      releasePixels?.();
      this.releases.delete(release);
    };
    this.releases.add(release);
    const ready = (async () => {
      this.assertCurrent();
      if (++this.imageCount > HTML_MEASUREMENT_LIMITS.media)
        throw new RuntimeServiceError(
          "resource_limit",
          "HTML image count exceeds the measurement budget",
        );
      const metadata = await this.wait(
        this.resourceBridge.readImageMetadata(resourceId),
        "image-metadata",
      );
      if (
        !Number.isSafeInteger(metadata.width) ||
        !Number.isSafeInteger(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0
      )
        throw new RuntimeServiceError(
          "backend_failure",
          "HTML image metadata has invalid dimensions",
        );
      releasePixels = this.budget.reserve(metadata.width, metadata.height);
      if (released) throw new RuntimeServiceError("stale_projection", "HTML image was retired");
      lease = acquireResourceUrl(
        this.resourceBridge,
        resourceId,
        revision,
        this.binding.resourceGeneration,
      );
      const url = await this.wait(lease.url, "image-url");
      if (released) throw new RuntimeServiceError("stale_projection", "HTML image was retired");
      decoded = new Image();
      decoded.src = url;
      await this.wait(decoded.decode(), "image-decode");
      if (released) throw new RuntimeServiceError("stale_projection", "HTML image was retired");
      if (
        decoded.naturalWidth !== metadata.width ||
        decoded.naturalHeight !== metadata.height ||
        metadata.width <= 0 ||
        metadata.height <= 0
      )
        throw new RuntimeServiceError(
          "backend_failure",
          "HTML image dimensions changed or failed to decode",
        );
      return { url, width: metadata.width, height: metadata.height };
    })().catch((error: unknown) => {
      release();
      throw error;
    });
    return { ready, release };
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.guard.signal.removeEventListener("abort", this.relayAbort);
    this.controller.abort();
    for (const release of [...this.releases]) release();
  }
}

export function measurementViewportIdentity(viewport: HTMLElement): string {
  const style = getComputedStyle(viewport);
  return [
    viewport.isConnected,
    viewport.clientWidth,
    viewport.clientHeight,
    style.fontFamily,
    style.fontSize,
    style.lineHeight,
    style.fontWeight,
    style.fontStyle,
    style.letterSpacing,
    style.fontFeatureSettings,
    style.fontVariationSettings,
    style.writingMode,
    style.direction,
  ].join("\0");
}
