import { acquireResourceUrl } from "@/core/resources";
import { platformBridge } from "@/platform";

interface CachedImage {
  promise: Promise<HTMLImageElement>;
  pixels: number;
}
type ImageCache = Map<string, CachedImage>;
type CanvasDrawable = Parameters<CanvasRenderingContext2D["drawImage"]>[0];
const MAXIMUM_CANVAS_SIDE = 8_192;
const MAXIMUM_REPLAY_PIXELS = 64 * 1024 * 1024;
const MAXIMUM_REPLAY_SURFACES = 32;
const MAXIMUM_REPLAY_DEPTH = 16;
const MAXIMUM_ENCODED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DECODED_IMAGE_COUNT = 32;
const MAXIMUM_DECODED_IMAGE_PIXELS = 64 * 1024 * 1024;
const canvasReleases = new WeakMap<HTMLCanvasElement, () => void>();

export class CanvasReplayBudget {
  private pixels = 0;
  private surfaces = 0;

  reserve(width: number, height: number, depth = 0): () => void {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 0 ||
      height < 0 ||
      width > MAXIMUM_CANVAS_SIDE ||
      height > MAXIMUM_CANVAS_SIDE
    )
      throw new Error("canvas replay surface dimensions exceed the frontend budget");
    if (depth > MAXIMUM_REPLAY_DEPTH)
      throw new Error("canvas replay recursion exceeds the frontend budget");
    const pixels = width * height;
    if (
      !Number.isSafeInteger(pixels) ||
      this.pixels + pixels > MAXIMUM_REPLAY_PIXELS ||
      this.surfaces + 1 > MAXIMUM_REPLAY_SURFACES
    )
      throw new Error("canvas replay surfaces exceed the frontend pixel budget");
    this.pixels += pixels;
    this.surfaces += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pixels -= pixels;
      this.surfaces -= 1;
    };
  }
}

export interface CanvasReplayRenderControl {
  budget: CanvasReplayBudget;
  active(): boolean;
}

interface WirePoint {
  x: unknown;
  y: unknown;
}

interface WireRectangle extends WirePoint {
  width: unknown;
  height: unknown;
}

export type CanvasReplayCommand =
  | { type: "clear"; argb: unknown; rectangle?: WireRectangle | null }
  | { type: "set_pixel"; argb: unknown; point: WirePoint }
  | { type: "fill_rectangle"; brush_argb: unknown; rectangle: WireRectangle }
  | { type: "set_brush"; argb: unknown }
  | { type: "set_pen"; argb: unknown; width: unknown }
  | { type: "set_dash_style"; style: unknown; cap: unknown }
  | { type: "set_font"; style_bits: unknown; size: unknown; family: string }
  | { type: "draw_line"; start: WirePoint; end: WirePoint }
  | { type: "draw_text"; text: string; point: WirePoint }
  | { type: "load_encoded_image"; encoded: number[] }
  | {
      type: "draw_sprite";
      name: string;
      destination: WireRectangle;
      color_matrix?: number[];
    }
  | {
      type: "draw_canvas";
      source_canvas_id: unknown;
      mask_canvas_id?: unknown;
      source: WireRectangle;
      destination: WireRectangle;
      color_matrix?: number[];
      rotation_millidegrees?: unknown;
      rotation_center?: WirePoint;
    };

interface CanvasSpriteFrame {
  canvas_id?: unknown;
  resource_id?: string;
  source_rectangle?: readonly unknown[];
}

interface CanvasSprite {
  name: string;
  canvas_id?: unknown;
  canvas_rectangle?: WireRectangle;
  frames?: CanvasSpriteFrame[];
}

export interface CanvasReplayData {
  canvas_id: unknown;
  revision: unknown;
  size: { width: unknown; height: unknown };
  commands?: CanvasReplayCommand[];
}

export interface CanvasReplayResources {
  sprites?: CanvasSprite[];
  canvases?: CanvasReplayData[];
}

export interface CanvasReplayRenderer {
  clear(): void;
  replay(
    context: CanvasRenderingContext2D,
    replay: CanvasReplayData,
    ancestors: Set<number>,
    resources: CanvasReplayResources,
    resourceGeneration: number,
    control?: CanvasReplayRenderControl,
  ): Promise<void>;
}

export function createCanvasReplayRenderer(): CanvasReplayRenderer {
  const decodedImages: ImageCache = new Map();
  return {
    clear(): void {
      releaseDecodedImages(decodedImages);
    },
    replay(
      context: CanvasRenderingContext2D,
      replay: CanvasReplayData,
      ancestors: Set<number>,
      resources: CanvasReplayResources,
      resourceGeneration: number,
      control = { budget: new CanvasReplayBudget(), active: () => true },
    ): Promise<void> {
      return replayCommands(
        context,
        replay,
        ancestors,
        resources,
        resourceGeneration,
        decodedImages,
        control,
        0,
      );
    },
  };
}

async function replayCommands(
  context: CanvasRenderingContext2D,
  replay: CanvasReplayData,
  ancestors: Set<number>,
  resources: CanvasReplayResources,
  resourceGeneration: number,
  decodedImages: ImageCache,
  control: CanvasReplayRenderControl,
  depth: number,
): Promise<void> {
  assertActive(control);
  let brush = "#000";
  let pen = "#000";
  let penWidth = 1;
  let font = "16px sans-serif";
  for (const command of replay.commands ?? []) {
    assertActive(control);
    switch (command.type) {
      case "clear":
        context.save();
        context.globalCompositeOperation = "copy";
        context.fillStyle = argb(command.argb);
        if (command.rectangle)
          context.fillRect(
            numeric(command.rectangle.x),
            numeric(command.rectangle.y),
            numeric(command.rectangle.width),
            numeric(command.rectangle.height),
          );
        else context.fillRect(0, 0, context.canvas.width, context.canvas.height);
        context.restore();
        break;
      case "set_pixel":
        context.fillStyle = argb(command.argb);
        context.fillRect(numeric(command.point.x), numeric(command.point.y), 1, 1);
        break;
      case "fill_rectangle":
        context.fillStyle = argb(command.brush_argb);
        context.fillRect(
          numeric(command.rectangle.x),
          numeric(command.rectangle.y),
          numeric(command.rectangle.width),
          numeric(command.rectangle.height),
        );
        break;
      case "set_brush":
        brush = argb(command.argb);
        break;
      case "set_pen":
        pen = argb(command.argb);
        penWidth = Number(command.width) / 1000;
        break;
      case "set_dash_style":
        context.setLineDash(dashPattern(command.style, penWidth));
        context.lineCap =
          Number(command.cap) === 2 ? "square" : Number(command.cap) === 1 ? "round" : "butt";
        break;
      case "set_font":
        font = `${Number(command.style_bits) & 2 ? "italic " : ""}${Number(command.style_bits) & 1 ? "bold " : ""}${Number(command.size) / 1000}pt ${command.family}`;
        break;
      case "draw_line":
        context.strokeStyle = pen;
        context.lineWidth = penWidth;
        context.beginPath();
        context.moveTo(numeric(command.start.x), numeric(command.start.y));
        context.lineTo(numeric(command.end.x), numeric(command.end.y));
        context.stroke();
        break;
      case "draw_text":
        context.fillStyle = brush;
        context.font = font;
        context.fillText(command.text, numeric(command.point.x), numeric(command.point.y));
        break;
      case "load_encoded_image": {
        if (command.encoded.length > MAXIMUM_ENCODED_IMAGE_BYTES)
          throw new Error("encoded canvas image exceeds the frontend budget");
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(command.encoded)]));
        let release: (() => void) | undefined;
        try {
          release = control.budget.reserve(bitmap.width, bitmap.height, depth);
          assertActive(control);
          context.drawImage(bitmap, 0, 0);
        } finally {
          bitmap.close();
          release?.();
        }
        break;
      }
      case "draw_sprite": {
        const source = await spriteSource(
          command.name,
          ancestors,
          resources,
          replay.revision,
          resourceGeneration,
          decodedImages,
          control,
          depth,
        );
        if (source) {
          try {
            drawProjected(
              context,
              source.image,
              source.rectangle,
              rectangle(command.destination),
              { colorMatrix: command.color_matrix },
              control.budget,
              depth,
            );
          } finally {
            releaseCanvas(source.image);
          }
        }
        break;
      }
      case "draw_canvas": {
        const source = await canvasSource(
          Number(command.source_canvas_id),
          ancestors,
          resources,
          resourceGeneration,
          decodedImages,
          control,
          depth + 1,
        );
        if (!source) break;
        let mask: HTMLCanvasElement | undefined;
        try {
          mask =
            command.mask_canvas_id == null
              ? undefined
              : await canvasSource(
                  Number(command.mask_canvas_id),
                  ancestors,
                  resources,
                  resourceGeneration,
                  decodedImages,
                  control,
                  depth + 1,
                );
          drawProjected(
            context,
            source,
            rectangle(command.source),
            rectangle(command.destination),
            {
              colorMatrix: command.color_matrix,
              mask,
              rotationDegrees: Number(command.rotation_millidegrees ?? 0) / 1000,
              rotationCenter: command.rotation_center ? point(command.rotation_center) : undefined,
            },
            control.budget,
            depth,
          );
        } finally {
          releaseCanvas(source);
          releaseCanvas(mask);
        }
        break;
      }
    }
  }
}

async function spriteSource(
  name: string,
  ancestors: Set<number>,
  resources: CanvasReplayResources,
  revision: unknown,
  resourceGeneration: number,
  decodedImages: ImageCache,
  control: CanvasReplayRenderControl,
  depth: number,
): Promise<{ image: CanvasDrawable; rectangle: Rectangle } | undefined> {
  const sprite = resources.sprites?.find(
    (item) => String(item.name).toUpperCase() === String(name).toUpperCase(),
  );
  if (sprite?.canvas_id != null) {
    const image = await canvasSource(
      Number(sprite.canvas_id),
      ancestors,
      resources,
      resourceGeneration,
      decodedImages,
      control,
      depth + 1,
    );
    if (!image) return undefined;
    return {
      image,
      rectangle: sprite.canvas_rectangle
        ? rectangle(sprite.canvas_rectangle)
        : { x: 0, y: 0, width: image.width, height: image.height },
    };
  }
  const frame = sprite?.frames?.[0];
  if (frame?.canvas_id != null) {
    const image = await canvasSource(
      Number(frame.canvas_id),
      ancestors,
      resources,
      resourceGeneration,
      decodedImages,
      control,
      depth + 1,
    );
    if (!image) return undefined;
    return { image, rectangle: tupleRectangle(frame.source_rectangle, image) };
  }
  const resourceId = frame?.resource_id ?? name;
  try {
    const image = await decodedImage(
      resourceId,
      Number(revision),
      resourceGeneration,
      decodedImages,
    );
    assertActive(control);
    return { image, rectangle: tupleRectangle(frame?.source_rectangle, image) };
  } catch (error) {
    console.warn(`Unable to load canvas sprite resource: ${resourceId}`, error);
    throw error;
  }
}

function decodedImage(
  resourceId: string,
  revision: number,
  resourceGeneration: number,
  decodedImages: ImageCache,
): Promise<HTMLImageElement> {
  // A generated animation creates a fresh canvas revision for every frame, but its file-backed
  // source belongs to the same project resource graph. Keep resource IDs case-sensitive and
  // include the project generation so a hot reload cannot reuse an obsolete decoded file.
  const key = `${resourceGeneration}\0${resourceId}`;
  const cached = decodedImages.get(key);
  if (cached) return cached.promise;
  const lease = acquireResourceUrl(platformBridge(), resourceId, revision, resourceGeneration);
  const entry: CachedImage = {
    promise: undefined as unknown as Promise<HTMLImageElement>,
    pixels: 0,
  };
  const image = lease.url
    .then(async (source) => {
      const image = new Image();
      image.src = source;
      try {
        await image.decode();
        const pixels = image.width * image.height;
        if (!Number.isSafeInteger(pixels) || pixels > MAXIMUM_DECODED_IMAGE_PIXELS) {
          image.src = "";
          throw new Error("decoded canvas image exceeds the frontend pixel budget");
        }
        entry.pixels = pixels;
        evictDecodedImages(decodedImages, key);
        return image;
      } finally {
        lease.release();
      }
    })
    .catch((error) => {
      lease.release();
      decodedImages.delete(key);
      throw error;
    });
  entry.promise = image;
  decodedImages.set(key, entry);
  return image;
}

function evictDecodedImages(decodedImages: ImageCache, protectedKey: string): void {
  let retainedPixels = [...decodedImages.values()].reduce((sum, entry) => sum + entry.pixels, 0);
  while (
    decodedImages.size > MAXIMUM_DECODED_IMAGE_COUNT ||
    retainedPixels > MAXIMUM_DECODED_IMAGE_PIXELS
  ) {
    let candidate: string | undefined;
    for (const key of decodedImages.keys()) {
      if (key !== protectedKey) {
        candidate = key;
        break;
      }
    }
    if (!candidate) return;
    const image = decodedImages.get(candidate);
    decodedImages.delete(candidate);
    retainedPixels -= image?.pixels ?? 0;
    void image?.promise.then(
      (decoded) => (decoded.src = ""),
      () => undefined,
    );
  }
}

function releaseDecodedImages(decodedImages: ImageCache): void {
  for (const image of decodedImages.values())
    void image.promise.then(
      (decoded) => (decoded.src = ""),
      () => undefined,
    );
  decodedImages.clear();
}

async function canvasSource(
  canvasId: number,
  ancestors: Set<number>,
  resources: CanvasReplayResources,
  resourceGeneration: number,
  decodedImages: ImageCache,
  control: CanvasReplayRenderControl,
  depth: number,
): Promise<HTMLCanvasElement | undefined> {
  if (ancestors.has(canvasId)) return undefined;
  const replay = resources.canvases?.find((item) => Number(item.canvas_id) === canvasId);
  if (!replay) return undefined;
  assertActive(control);
  const width = canvasDimension(replay.size.width);
  const height = canvasDimension(replay.size.height);
  const release = control.budget.reserve(width, height, depth);
  const element = document.createElement("canvas");
  canvasReleases.set(element, release);
  element.width = width;
  element.height = height;
  const context = element.getContext("2d");
  if (!context) {
    releaseCanvas(element);
    return undefined;
  }
  const next = new Set(ancestors);
  next.add(canvasId);
  try {
    await replayCommands(
      context,
      replay,
      next,
      resources,
      resourceGeneration,
      decodedImages,
      control,
      depth,
    );
    assertActive(control);
    return element;
  } catch (error) {
    releaseCanvas(element);
    throw error;
  }
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function point(value: WirePoint): { x: number; y: number } {
  return { x: numeric(value.x), y: numeric(value.y) };
}

function rectangle(value: WireRectangle): Rectangle {
  return {
    x: numeric(value.x),
    y: numeric(value.y),
    width: numeric(value.width),
    height: numeric(value.height),
  };
}

export function canvasDimension(value: unknown): number {
  const dimension = Math.abs(Number(value));
  return Number.isFinite(dimension) ? dimension : 0;
}

function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function tupleRectangle(value: unknown, fallback: { width: number; height: number }): Rectangle {
  const rectangle = Array.isArray(value) ? value : [];
  return {
    x: Number(rectangle[0] ?? 0),
    y: Number(rectangle[1] ?? 0),
    width: Number(rectangle[2] ?? fallback.width),
    height: Number(rectangle[3] ?? fallback.height),
  };
}

function drawProjected(
  target: CanvasRenderingContext2D,
  image: CanvasDrawable,
  source: Rectangle,
  destination: Rectangle,
  options: {
    colorMatrix?: number[];
    mask?: HTMLCanvasElement;
    rotationDegrees?: number;
    rotationCenter?: { x: number; y: number };
  },
  budget: CanvasReplayBudget,
  depth: number,
): void {
  if (!options.mask && !options.colorMatrix?.length && Number(options.rotationDegrees ?? 0) === 0) {
    target.drawImage(
      image,
      Number(source.x),
      Number(source.y),
      Number(source.width),
      Number(source.height),
      Number(destination.x),
      Number(destination.y),
      Number(destination.width),
      Number(destination.height),
    );
    return;
  }
  const projectedWidth = Math.max(1, Math.abs(Number(destination.width)));
  const projectedHeight = Math.max(1, Math.abs(Number(destination.height)));
  const release = budget.reserve(projectedWidth, projectedHeight, depth);
  const projected = document.createElement("canvas");
  canvasReleases.set(projected, release);
  projected.width = projectedWidth;
  projected.height = projectedHeight;
  const opacity = simpleOpacity(options.colorMatrix);
  const readsPixels = opacity == null && options.colorMatrix?.length === 25;
  const context = projected.getContext(
    "2d",
    readsPixels ? { willReadFrequently: true } : undefined,
  );
  if (!context) {
    releaseCanvas(projected);
    return;
  }
  try {
    if (opacity != null) {
      context.save();
      context.globalAlpha = opacity;
    }
    context.drawImage(
      image,
      Number(source.x),
      Number(source.y),
      Number(source.width),
      Number(source.height),
      0,
      0,
      projected.width,
      projected.height,
    );
    if (opacity != null) context.restore();
    else if (options.colorMatrix?.length === 25) applyColorMatrix(context, options.colorMatrix);
    if (options.mask)
      applyMask(context, options.mask, source, projected.width, projected.height, budget, depth);

    const rotation = Number(options.rotationDegrees ?? 0);
    if (!rotation) {
      target.drawImage(projected, Number(destination.x), Number(destination.y));
      return;
    }
    const center = options.rotationCenter ?? {
      x: Number(destination.x) + projected.width / 2,
      y: Number(destination.y) + projected.height / 2,
    };
    target.save();
    target.translate(Number(center.x), Number(center.y));
    target.rotate((rotation * Math.PI) / 180);
    target.translate(-Number(center.x), -Number(center.y));
    target.drawImage(projected, Number(destination.x), Number(destination.y));
    target.restore();
  } finally {
    releaseCanvas(projected);
  }
}

function simpleOpacity(values: number[] | undefined): number | undefined {
  if (values?.length !== 25) return undefined;
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const index = row * 5 + column;
      if (index === 18) continue;
      const expected = row === column ? 256 : 0;
      if (Number(values[index]) !== expected) return undefined;
    }
  }
  const opacity = Number(values[18]) / 256;
  return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : undefined;
}

function applyMask(
  context: CanvasRenderingContext2D,
  mask: HTMLCanvasElement,
  source: Rectangle,
  width: number,
  height: number,
  budget: CanvasReplayBudget,
  depth: number,
): void {
  const release = budget.reserve(width, height, depth);
  const projected = document.createElement("canvas");
  canvasReleases.set(projected, release);
  projected.width = width;
  projected.height = height;
  const maskContext = projected.getContext("2d");
  if (!maskContext) {
    releaseCanvas(projected);
    return;
  }
  try {
    maskContext.drawImage(
      mask,
      Number(source.x),
      Number(source.y),
      Number(source.width),
      Number(source.height),
      0,
      0,
      width,
      height,
    );
    context.save();
    context.globalCompositeOperation = "destination-in";
    context.drawImage(projected, 0, 0);
    context.restore();
  } finally {
    releaseCanvas(projected);
  }
}

function releaseCanvas(value: CanvasDrawable | undefined): void {
  if (!(value instanceof HTMLCanvasElement)) return;
  value.width = 0;
  value.height = 0;
  canvasReleases.get(value)?.();
  canvasReleases.delete(value);
}

function assertActive(control: CanvasReplayRenderControl): void {
  if (!control.active()) throw new Error("canvas replay was cancelled");
}

function applyColorMatrix(context: CanvasRenderingContext2D, values: number[]): void {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const matrix = values.map((value) => Number(value) / 256);
  for (let index = 0; index < image.data.length; index += 4) {
    const input = [
      image.data[index] / 255,
      image.data[index + 1] / 255,
      image.data[index + 2] / 255,
      image.data[index + 3] / 255,
      1,
    ];
    for (let channel = 0; channel < 4; channel += 1) {
      let output = 0;
      for (let component = 0; component < 5; component += 1)
        output += input[component] * matrix[component * 5 + channel];
      image.data[index + channel] = Math.round(Math.max(0, Math.min(1, output)) * 255);
    }
  }
  context.putImageData(image, 0, 0);
}

function dashPattern(style: unknown, width: number): number[] {
  const unit = Math.max(1, width);
  switch (Number(style)) {
    case 1:
      return [3 * unit, unit];
    case 2:
      return [unit, unit];
    case 3:
      return [3 * unit, unit, unit, unit];
    case 4:
      return [3 * unit, unit, unit, unit, unit, unit];
    default:
      return [];
  }
}

function argb(value: unknown): string {
  const unsigned = numeric(value) >>> 0;
  const alpha = ((unsigned >>> 24) & 0xff) / 255;
  return `rgba(${(unsigned >>> 16) & 0xff}, ${(unsigned >>> 8) & 0xff}, ${unsigned & 0xff}, ${alpha})`;
}
