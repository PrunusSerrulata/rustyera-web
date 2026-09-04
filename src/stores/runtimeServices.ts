import {
  resolveHtmlRuntimeService,
  type RuntimeHtmlServiceProvider,
} from "@/stores/runtimeHtmlServices";
import { decodeImageMetadata } from "@/core/imageMetadata";
import { plainLine, printedHtmlLine, type PresentationState } from "@/core/presentation";
import { at, mapOf } from "@/core/runtimeSupport";
import { encodeProjectionServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  RuntimeServiceError,
  isHtmlQueryService,
  isStrictProjectionService,
  canvasPixelQuery,
  devicePumpQuery,
  lineGeometryQuery,
  projectionMap,
  projectionQuery,
  validateServiceRequest,
  type CanvasPixelQuery,
  type LineGeometryQuery,
  type ProjectionQueryContext,
  type RuntimeServiceRequest,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { RuntimeServiceLease } from "@/stores/runtimeServiceRequests";
import type { PointerObservation } from "@/platform/pointerObservation";
import type { FrontendBridge, RuntimeMessage } from "@/core/types";
import type { SqlProvider } from "@/platform/sqlProvider";

export interface RuntimeProjectionServiceProvider {
  prepare(context: ProjectionQueryContext, lease: RuntimeServiceLease): Promise<PresentationState>;
  prepareEnvironment(
    context: ProjectionQueryContext,
    lease: RuntimeServiceLease,
  ): Promise<PresentationState>;
  matches(context: ProjectionQueryContext): boolean;
  matchesEnvironment(context: ProjectionQueryContext): boolean;
  pointer(): PointerObservation;
  canvas(
    query: CanvasPixelQuery,
    presentation: PresentationState,
    lease: RuntimeServiceLease,
  ): Promise<number>;
  lineGeometry(
    query: LineGeometryQuery,
    lease: RuntimeServiceLease,
  ): Promise<{
    top: number;
    height: number;
    viewportHeight: number;
  }>;
}

export interface RuntimeAudioServiceProvider {
  observe(query: unknown): Map<number, unknown>;
}

export interface RuntimeServiceContext {
  lease: RuntimeServiceLease;
  projection?: RuntimeProjectionServiceProvider;
  html?: RuntimeHtmlServiceProvider;
  bridge: Pick<FrontendBridge, "readImageMetadata" | "readResource">;
  currentPresentation(): PresentationState;
  heldKeys: ReadonlySet<number>;
  pumpDevices(epoch: ServiceInteger, afterEventSequence: ServiceInteger): Promise<ServiceInteger>;
  clock(): Date | undefined;
  nextEntropy(): bigint | undefined;
  send(message: RuntimeMessage, correlationId?: ServiceInteger): Promise<unknown>;
  resourceGeneration: number;
  imagePixels: RuntimeImagePixelCache;
  audio?: RuntimeAudioServiceProvider;
  sql?: SqlProvider;
}

interface DecodedPixelSurface {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
  pixels: number;
}

interface PixelSurfaceEntry {
  promise: Promise<DecodedPixelSurface>;
  surface?: DecodedPixelSurface;
  users: number;
  pixels: number;
  lastUsed: number;
  retired: boolean;
}

const DEFAULT_IMAGE_PIXEL_CACHE_PIXELS = 16 * 1024 * 1024;

/** Coalesce service image decoding and bound retained RGBA surfaces for one project generation. */
export class RuntimeImagePixelCache {
  private readonly entries = new Map<string, PixelSurfaceEntry>();
  private generation = -1;
  private retainedPixels = 0;
  private clock = 0;
  private loadTail = Promise.resolve();

  constructor(private readonly maximumPixels = DEFAULT_IMAGE_PIXEL_CACHE_PIXELS) {}

  async pixel(
    bridge: Pick<FrontendBridge, "readImageMetadata" | "readResource">,
    resourceId: string,
    x: number,
    y: number,
    generation: number,
  ): Promise<number> {
    this.ensureGeneration(generation);
    const key = `${generation}\0${resourceId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.createEntry(bridge, resourceId, key);
      this.entries.set(key, entry);
    }
    entry.users += 1;
    entry.lastUsed = ++this.clock;
    try {
      const surface = await entry.promise;
      const pixel = surface.context.getImageData(x, y, 1, 1).data;
      return ((pixel[3] << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]) >>> 0;
    } finally {
      entry.users -= 1;
      if ((entry.retired || entry.pixels > this.maximumPixels) && entry.users === 0)
        this.releaseEntry(key, entry);
      else this.evictBudget();
    }
  }

  clear(): void {
    for (const [key, entry] of this.entries) {
      entry.retired = true;
      if (entry.users === 0) this.releaseEntry(key, entry);
    }
    this.generation = -1;
    this.clock = 0;
  }

  memoryCounters(): {
    count: number;
    pixels: number;
    estimatedBytes: number;
    inflight: number;
  } {
    return {
      count: [...this.entries.values()].filter((entry) => entry.surface != null).length,
      pixels: this.retainedPixels,
      estimatedBytes: this.retainedPixels * 4,
      inflight: [...this.entries.values()].filter((entry) => entry.surface == null).length,
    };
  }

  private ensureGeneration(generation: number): void {
    if (this.generation === generation) return;
    this.clear();
    this.generation = generation;
  }

  private createEntry(
    bridge: Pick<FrontendBridge, "readImageMetadata" | "readResource">,
    resourceId: string,
    key: string,
  ): PixelSurfaceEntry {
    const entry: PixelSurfaceEntry = {
      promise: undefined as unknown as Promise<DecodedPixelSurface>,
      users: 0,
      pixels: 0,
      lastUsed: ++this.clock,
      retired: false,
    };
    const load = this.loadTail.then(async () => {
      const metadata = await bridge.readImageMetadata(resourceId);
      const pixels = checkedPixels(metadata.width, metadata.height, resourceId);
      if (pixels > this.maximumPixels) throw new Error(`图像像素数超过前端服务预算：${resourceId}`);
      const bytes = await bridge.readResource(resourceId);
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      try {
        if (bitmap.width !== metadata.width || bitmap.height !== metadata.height)
          throw new Error(`图像尺寸在读取期间发生变化：${resourceId}`);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          canvas.width = 0;
          canvas.height = 0;
          throw new Error(`无法创建图像像素读取面：${resourceId}`);
        }
        try {
          context.drawImage(bitmap, 0, 0);
        } catch (error) {
          canvas.width = 0;
          canvas.height = 0;
          throw error;
        }
        const surface = { canvas, context, pixels };
        if (entry.retired) {
          releasePixelSurface(surface);
          throw new Error(`图像像素请求已过期：${resourceId}`);
        }
        entry.surface = surface;
        entry.pixels = pixels;
        this.retainedPixels += pixels;
        this.evictBudget(entry);
        return surface;
      } finally {
        bitmap.close();
      }
    });
    this.loadTail = load.then(
      () => undefined,
      () => undefined,
    );
    entry.promise = load.catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry;
  }

  private evictBudget(protectedEntry?: PixelSurfaceEntry): void {
    while (this.retainedPixels > this.maximumPixels) {
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => entry !== protectedEntry && entry.users === 0 && entry.pixels > 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!candidate) return;
      this.releaseEntry(candidate[0], candidate[1]);
    }
  }

  private releaseEntry(key: string, entry: PixelSurfaceEntry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (entry.pixels > 0) {
      this.retainedPixels = Math.max(0, this.retainedPixels - entry.pixels);
      entry.pixels = 0;
    }
    if (entry.surface) {
      releasePixelSurface(entry.surface);
      entry.surface = undefined;
    }
  }
}

function checkedPixels(width: number, height: number, resourceId: string): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw new Error(`图像尺寸无效：${resourceId}`);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) throw new Error(`图像像素数溢出：${resourceId}`);
  return pixels;
}

function releasePixelSurface(surface: DecodedPixelSurface): void {
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}

export async function handleRuntimeService(
  request: RuntimeServiceRequest,
  correlationId: ServiceInteger | undefined,
  context: RuntimeServiceContext,
): Promise<void> {
  let result: unknown;
  try {
    context.lease.assertActive();
    if (context.lease.duplicate)
      throw new RuntimeServiceError("invalid_request", "duplicate active service request ID");
    const query = validateServiceRequest(request);
    const presentation = context.currentPresentation();
    const response = await resolveRuntimeService(request, query, presentation, context);
    context.lease.assertActive();
    result = {
      type: "ready",
      payload: [
        ...(isStrictProjectionService(request)
          ? encodeProjectionServicePayload(response)
          : encodeServicePayload(response)),
      ],
    };
  } catch (error) {
    if (!context.lease.active()) return;
    const failure =
      error instanceof RuntimeServiceError
        ? error
        : new RuntimeServiceError("backend_failure", String(error));
    result = {
      type: "error",
      error: {
        code:
          failure.category === "unsupported"
            ? "frontend.unsupported_service"
            : `frontend.${failure.category}`,
        message: `${request.kind}/${request.operation}@${request.operation_version?.major}.${request.operation_version?.minor}: ${failure.message}`,
      },
    };
  }
  try {
    if (!context.lease.active()) return;
    await context.send(
      { type: "service_response", value: { request_id: request.request_id, result } },
      correlationId,
    );
  } finally {
    context.lease.finish();
  }
}

async function resolveRuntimeService(
  request: RuntimeServiceRequest,
  query: any,
  presentation: PresentationState,
  context: RuntimeServiceContext,
): Promise<Map<number, unknown>> {
  if (isHtmlQueryService(request))
    return resolveHtmlRuntimeService(query, context.html, context.lease);
  if (request.kind === "sql" && request.operation === "rustyera.sql") {
    if (!context.sql) throw new RuntimeServiceError("unsupported", "SQL provider is not installed");
    return context.sql.handle(query, context.lease.signal);
  }
  switch (`${request.kind}/${request.operation}`) {
    case "audio/audio_observation": {
      if (!context.audio)
        throw new RuntimeServiceError("unsupported", "audio provider is not installed");
      return context.audio.observe(query);
    }
    case "input_state/device_pump": {
      const expected = devicePumpQuery(query);
      const through = await context.pumpDevices(expected.epoch, expected.afterEventSequence);
      return mapOf([0, expected.epoch], [1, through]);
    }
    case "input_state/pointer_state": {
      const expected = projectionQuery(query);
      const provider = projectionProvider(context);
      // Pointer coordinates and hit testing depend on the mounted viewport and canonical
      // presentation, but not on virtual-history row measurements that may settle later.
      await provider.prepareEnvironment(expected, context.lease);
      context.lease.assertActive();
      if (!provider.matchesEnvironment(expected))
        throw new RuntimeServiceError("stale_projection", "pointer projection changed");
      const pointer = provider.pointer();
      return mapOf(
        [0, pointer.x],
        [1, pointer.y],
        [2, pointer.buttonValue],
        [3, expected.presentationRevision],
        [4, expected.environmentRevision],
        [5, expected.projectionSpaceRevision],
      );
    }
    case "canvas/sample_canvas_pixel": {
      const pixelQuery = canvasPixelQuery(query);
      const provider = projectionProvider(context);
      const projected = await provider.prepare(pixelQuery.context, context.lease);
      context.lease.assertActive();
      const argb = await provider.canvas(pixelQuery, projected, context.lease);
      context.lease.assertActive();
      if (!provider.matches(pixelQuery.context))
        throw new RuntimeServiceError("stale_projection", "canvas projection changed");
      return mapOf(
        [0, projectionMap(pixelQuery.context)],
        [1, pixelQuery.canvasRevision],
        [2, argb],
      );
    }
    case "presentation_query/get_line_geometry_v1": {
      const expected = lineGeometryQuery(query);
      const provider = projectionProvider(context);
      await provider.prepare(expected.context, context.lease);
      context.lease.assertActive();
      if (!provider.matches(expected.context))
        throw new RuntimeServiceError("stale_projection", "line projection changed");
      const geometry = await provider.lineGeometry(expected, context.lease);
      context.lease.assertActive();
      if (!provider.matches(expected.context))
        throw new RuntimeServiceError("stale_projection", "line projection changed");
      return mapOf(
        [0, projectionMap(expected.context)],
        [1, expected.lineId],
        [2, geometry.top],
        [3, geometry.height],
        [4, geometry.viewportHeight],
      );
    }
    case "entropy/random_seed": {
      const entropy = context.nextEntropy();
      if (entropy != null) return mapOf([0, entropy]);
      const bytes = crypto.getRandomValues(new Uint32Array(2));
      return mapOf([0, (BigInt(bytes[0]) << 32n) | BigInt(bytes[1])]);
    }
    case "clock/local_date_time": {
      const now = context.clock() ?? new Date();
      return mapOf(
        [0, now.getFullYear()],
        [1, now.getMonth() + 1],
        [2, now.getDate()],
        [3, now.getHours()],
        [4, now.getMinutes()],
        [5, now.getSeconds()],
        [6, now.getMilliseconds()],
        [7, -now.getTimezoneOffset()],
      );
    }
    case "input_state/get_key_state": {
      const code = Number(at(query, 0));
      return mapOf([0, document.hasFocus()], [1, context.heldKeys.has(code)], [2, false]);
    }
    case "image/image_metadata": {
      const metadata = await context.bridge.readImageMetadata(String(at(query, 0)));
      return mapOf(
        [0, metadata.width],
        [1, metadata.height],
        [2, metadata.format],
        [3, metadata.animated],
      );
    }
    case "image/image_pixel": {
      const resource = String(at(query, 0));
      const pixel = await context.imagePixels.pixel(
        context.bridge,
        resource,
        Number(at(query, 2)),
        Number(at(query, 3)),
        context.resourceGeneration,
      );
      return mapOf([0, pixel]);
    }
    case "canvas/decode_canvas_image": {
      const metadata = decodeImageMetadata(at(query, 0) as Uint8Array);
      return mapOf([0, metadata.width], [1, metadata.height]);
    }
    case "presentation_query/get_display_line": {
      const index = Number(at(query, 1));
      return mapOf(
        [0, at(query, 0)],
        [1, presentation.lines[index] ? plainLine(presentation.lines[index]) : ""],
      );
    }
    case "presentation_query/html_get_printed_str": {
      const index = Number(at(query, 1));
      const text = presentation.lines.at(-(index + 1));
      return mapOf(
        [0, at(query, 0)],
        [1, text ? printedHtmlLine(text, Number(presentation.settings.line_height ?? 0)) : ""],
      );
    }
    case "presentation_query/serialize_physical_history": {
      const body = presentation.lines.map(plainLine).join("\n");
      return mapOf([0, at(query, 0)], [1, at(query, 2) ? body : `${at(query, 1)}\n\n${body}`]);
    }
    case "font_metrics/gget_text_size": {
      const text = String(at(query, 1));
      const canvas = document.createElement("canvas");
      const canvasContext = canvas.getContext("2d")!;
      canvasContext.font = `${Number(at(query, 3)) / 1000}pt ${String(at(query, 2))}`;
      const metrics = canvasContext.measureText(text);
      return mapOf(
        [0, at(query, 0)],
        [1, Math.ceil(metrics.width)],
        [2, Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)],
      );
    }
    default:
      throw new RuntimeServiceError(
        "unsupported",
        `不支持的前端服务：${request.kind}/${request.operation}`,
      );
  }
}

function projectionProvider(context: RuntimeServiceContext): RuntimeProjectionServiceProvider {
  if (!context.projection)
    throw new RuntimeServiceError("unsupported", "projection query provider is not installed");
  return context.projection;
}
