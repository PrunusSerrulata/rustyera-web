import { resourceUrl } from "@/core/resources";
import { platformBridge } from "@/platform";

type ImageCache = Map<string, Promise<HTMLImageElement>>;
type CanvasDrawable = Parameters<CanvasRenderingContext2D["drawImage"]>[0];

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
  ): Promise<void>;
}

export function createCanvasReplayRenderer(): CanvasReplayRenderer {
  const decodedImages: ImageCache = new Map();
  return {
    clear(): void {
      decodedImages.clear();
    },
    replay(
      context: CanvasRenderingContext2D,
      replay: CanvasReplayData,
      ancestors: Set<number>,
      resources: CanvasReplayResources,
      resourceGeneration: number,
    ): Promise<void> {
      return replayCommands(
        context,
        replay,
        ancestors,
        resources,
        resourceGeneration,
        decodedImages,
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
): Promise<void> {
  let brush = "#000";
  let pen = "#000";
  let penWidth = 1;
  let font = "16px sans-serif";
  for (const command of replay.commands ?? []) {
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
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(command.encoded.map(Number))]),
        );
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
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
        );
        if (source)
          drawProjected(context, source.image, source.rectangle, rectangle(command.destination), {
            colorMatrix: command.color_matrix,
          });
        break;
      }
      case "draw_canvas": {
        const source = await canvasSource(
          Number(command.source_canvas_id),
          ancestors,
          resources,
          resourceGeneration,
          decodedImages,
        );
        if (!source) break;
        const mask =
          command.mask_canvas_id == null
            ? undefined
            : await canvasSource(
                Number(command.mask_canvas_id),
                ancestors,
                resources,
                resourceGeneration,
                decodedImages,
              );
        drawProjected(context, source, rectangle(command.source), rectangle(command.destination), {
          colorMatrix: command.color_matrix,
          mask,
          rotationDegrees: Number(command.rotation_millidegrees ?? 0) / 1000,
          rotationCenter: command.rotation_center ? point(command.rotation_center) : undefined,
        });
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
  if (cached) return cached;
  const image = resourceUrl(platformBridge(), resourceId, revision, resourceGeneration)
    .then(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return image;
    })
    .catch((error) => {
      decodedImages.delete(key);
      throw error;
    });
  decodedImages.set(key, image);
  return image;
}

async function canvasSource(
  canvasId: number,
  ancestors: Set<number>,
  resources: CanvasReplayResources,
  resourceGeneration: number,
  decodedImages: ImageCache,
): Promise<HTMLCanvasElement | undefined> {
  if (ancestors.has(canvasId)) return undefined;
  const replay = resources.canvases?.find((item) => Number(item.canvas_id) === canvasId);
  if (!replay) return undefined;
  const element = document.createElement("canvas");
  element.width = canvasDimension(replay.size.width);
  element.height = canvasDimension(replay.size.height);
  const context = element.getContext("2d");
  if (!context) return undefined;
  const next = new Set(ancestors);
  next.add(canvasId);
  await replayCommands(context, replay, next, resources, resourceGeneration, decodedImages);
  return element;
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
): void {
  const projected = document.createElement("canvas");
  projected.width = Math.max(1, Math.abs(Number(destination.width)));
  projected.height = Math.max(1, Math.abs(Number(destination.height)));
  const opacity = simpleOpacity(options.colorMatrix);
  const readsPixels = opacity == null && options.colorMatrix?.length === 25;
  const context = projected.getContext(
    "2d",
    readsPixels ? { willReadFrequently: true } : undefined,
  );
  if (!context) return;
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
  if (options.mask) applyMask(context, options.mask, source, projected.width, projected.height);

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
): void {
  const projected = document.createElement("canvas");
  projected.width = width;
  projected.height = height;
  const maskContext = projected.getContext("2d");
  if (!maskContext) return;
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
