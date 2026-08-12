<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { platformBridge } from "@/platform";
import { resourceUrl } from "@/core/resources";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{
  replay: any;
  scale?: number;
  displayWidth?: number;
  displayHeight?: number;
  visible?: boolean;
}>();
const store = useRuntimeStore();
const firstSurface = ref<HTMLCanvasElement>();
const secondSurface = ref<HTMLCanvasElement>();
const activeSurface = ref(-1);
const decodedImages = new Map<string, Promise<HTMLImageElement>>();
type CanvasDrawable = Parameters<CanvasRenderingContext2D["drawImage"]>[0];
interface RenderRequest {
  replay: any;
  resources: any;
  resourceGeneration: number;
  token: number;
}

let pendingRender: RenderRequest | undefined;
let rendering = false;
let stopped = false;
let latestRenderToken = 0;

function requestRender(): void {
  if (stopped) return;
  // Animation frames can arrive faster than image decoding. Keep one in-flight replay and
  // coalesce its backlog to the newest frame so older work can never commit out of order.
  pendingRender = {
    replay: props.replay,
    resources: store.presentation.resources,
    resourceGeneration: Number(store.projectResourceGeneration ?? 0),
    token: ++latestRenderToken,
  };
  if (!rendering) void drainRenders();
}

async function drainRenders(): Promise<void> {
  rendering = true;
  try {
    while (!stopped && pendingRender) {
      const request = pendingRender;
      pendingRender = undefined;
      await nextTick();
      if (stopped || !firstSurface.value || !secondSurface.value) return;
      const projected = document.createElement("canvas");
      projected.width = canvasDimension(request.replay.size.width);
      projected.height = canvasDimension(request.replay.size.height);
      const context = projected.getContext("2d");
      if (!context) continue;
      try {
        await replayCommands(
          context,
          request.replay,
          new Set([Number(request.replay.canvas_id)]),
          request.resources,
          request.resourceGeneration,
        );
      } catch (error) {
        console.warn("Unable to replay generated canvas", error);
        continue;
      }
      if (stopped || request.resourceGeneration !== Number(store.projectResourceGeneration ?? 0))
        continue;
      await presentCanvas(projected, request);
    }
  } finally {
    rendering = false;
    if (!stopped && pendingRender) void drainRenders();
  }
}

async function replayCommands(
  context: CanvasRenderingContext2D,
  replay: any,
  ancestors: Set<number>,
  resources: any,
  resourceGeneration: number,
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
        );
        if (source)
          drawProjected(context, source.image, source.rectangle, command.destination, {
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
              );
        drawProjected(context, source, command.source, command.destination, {
          colorMatrix: command.color_matrix,
          mask,
          rotationDegrees: Number(command.rotation_millidegrees ?? 0) / 1000,
          rotationCenter: command.rotation_center,
        });
        break;
      }
    }
  }
}

async function spriteSource(
  name: string,
  ancestors: Set<number>,
  resources: any,
  revision: unknown,
  resourceGeneration: number,
): Promise<{ image: CanvasDrawable; rectangle: Rectangle } | undefined> {
  const sprite = resources.sprites?.find(
    (item: any) => String(item.name).toUpperCase() === String(name).toUpperCase(),
  );
  if (sprite?.canvas_id != null) {
    const image = await canvasSource(
      Number(sprite.canvas_id),
      ancestors,
      resources,
      resourceGeneration,
    );
    if (!image) return undefined;
    return {
      image,
      rectangle: sprite.canvas_rectangle ?? {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      },
    };
  }
  const frame = sprite?.frames?.[0];
  if (frame?.canvas_id != null) {
    const image = await canvasSource(
      Number(frame.canvas_id),
      ancestors,
      resources,
      resourceGeneration,
    );
    if (!image) return undefined;
    return { image, rectangle: tupleRectangle(frame.source_rectangle, image) };
  }
  const resourceId = frame?.resource_id ?? name;
  try {
    const image = await decodedImage(resourceId, Number(revision), resourceGeneration);
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

function commitCanvas(element: HTMLCanvasElement, projected: HTMLCanvasElement): boolean {
  // Only the hidden back surface is ever mutated. Resizing or replacing pixels on WebKit's
  // currently composited canvas can expose an intermediate transparent surface.
  try {
    if (element.width !== projected.width) element.width = projected.width;
    if (element.height !== projected.height) element.height = projected.height;
    const context = element.getContext("2d");
    if (!context) return false;
    context.save();
    try {
      context.globalCompositeOperation = "copy";
      context.drawImage(projected, 0, 0);
    } finally {
      context.restore();
    }
    return true;
  } catch (error) {
    console.warn("Unable to commit generated canvas", error);
    return false;
  }
}

async function presentCanvas(projected: HTMLCanvasElement, request: RenderRequest): Promise<void> {
  const targetIndex = activeSurface.value === 0 ? 1 : 0;
  const target = targetIndex === 0 ? firstSurface.value : secondSurface.value;
  if (!target) return;
  if (!commitCanvas(target, projected)) return;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (
    stopped ||
    target !== (targetIndex === 0 ? firstSurface.value : secondSurface.value) ||
    request.resourceGeneration !== Number(store.projectResourceGeneration ?? 0) ||
    request.token !== latestRenderToken
  )
    return;
  activeSurface.value = targetIndex;
  // Apply both visibility changes before the other surface can become the next back buffer.
  await nextTick();
}

async function canvasSource(
  canvasId: number,
  ancestors: Set<number>,
  resources: any,
  resourceGeneration: number,
): Promise<HTMLCanvasElement | undefined> {
  if (ancestors.has(canvasId)) return undefined;
  const replay = resources.canvases?.find((item: any) => Number(item.canvas_id) === canvasId);
  if (!replay) return undefined;
  const element = document.createElement("canvas");
  element.width = canvasDimension(replay.size.width);
  element.height = canvasDimension(replay.size.height);
  const context = element.getContext("2d");
  if (!context) return undefined;
  const next = new Set(ancestors);
  next.add(canvasId);
  await replayCommands(context, replay, next, resources, resourceGeneration);
  return element;
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function canvasDimension(value: unknown): number {
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

watch(() => props.replay, requestRender, { deep: true });
watch(
  () => store.projectResourceGeneration,
  () => {
    decodedImages.clear();
    requestRender();
  },
  { flush: "sync" },
);
onMounted(requestRender);
onBeforeUnmount(() => {
  stopped = true;
  pendingRender = undefined;
  decodedImages.clear();
});
</script>

<template>
  <span
    class="canvas-replay-stack"
    :style="{
      display: visible === false ? 'none' : undefined,
      width: `${displayWidth ?? Number(replay.size.width) * (scale ?? 1)}px`,
      height: `${displayHeight ?? Number(replay.size.height) * (scale ?? 1)}px`,
    }"
  >
    <canvas
      ref="firstSurface"
      class="canvas-replay-surface"
      :class="{ 'canvas-replay': activeSurface === 0 }"
      :style="{ visibility: activeSurface === 0 ? 'visible' : 'hidden' }"
      :aria-hidden="activeSurface !== 0"
    />
    <canvas
      ref="secondSurface"
      class="canvas-replay-surface"
      :class="{ 'canvas-replay': activeSurface === 1 }"
      :style="{ visibility: activeSurface === 1 ? 'visible' : 'hidden' }"
      :aria-hidden="activeSurface !== 1"
    />
  </span>
</template>
