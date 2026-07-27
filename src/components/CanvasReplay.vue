<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";

import { platformBridge } from "@/platform";
import { resourceUrl } from "@/core/resources";

const props = defineProps<{ replay: any; scale?: number }>();
const canvas = ref<HTMLCanvasElement>();

async function render(): Promise<void> {
  await nextTick();
  const element = canvas.value;
  if (!element) return;
  element.width = props.replay.size.width;
  element.height = props.replay.size.height;
  const context = element.getContext("2d", { willReadFrequently: true })!;
  let brush = "#000";
  let pen = "#000";
  let penWidth = 1;
  let font = "16px sans-serif";
  for (const command of props.replay.commands ?? []) {
    switch (command.type) {
      case "clear":
        context.fillStyle = argb(command.argb);
        if (command.rectangle)
          context.fillRect(
            command.rectangle.x,
            command.rectangle.y,
            command.rectangle.width,
            command.rectangle.height,
          );
        else context.fillRect(0, 0, element.width, element.height);
        break;
      case "set_pixel":
        context.fillStyle = argb(command.argb);
        context.fillRect(command.point.x, command.point.y, 1, 1);
        break;
      case "fill_rectangle":
        context.fillStyle = argb(command.brush_argb);
        context.fillRect(
          command.rectangle.x,
          command.rectangle.y,
          command.rectangle.width,
          command.rectangle.height,
        );
        break;
      case "set_brush":
        brush = argb(command.argb);
        break;
      case "set_pen":
        pen = argb(command.argb);
        penWidth = command.width / 1000;
        break;
      case "set_font":
        font = `${command.style_bits & 2 ? "italic " : ""}${command.style_bits & 1 ? "bold " : ""}${command.size / 1000}pt ${command.family}`;
        break;
      case "draw_line":
        context.strokeStyle = pen;
        context.lineWidth = penWidth;
        context.beginPath();
        context.moveTo(command.start.x, command.start.y);
        context.lineTo(command.end.x, command.end.y);
        context.stroke();
        break;
      case "draw_text":
        context.fillStyle = brush;
        context.font = font;
        context.fillText(command.text, command.point.x, command.point.y);
        break;
      case "load_encoded_image": {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(command.encoded)]));
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        break;
      }
      case "draw_sprite": {
        // File-backed sprite names are resolved by the runtime resource graph. If a game
        // uses a direct resource name, render it here; canvas-backed sprites are composed
        // by the parent resource replay.
        try {
          const image = new Image();
          image.src = await resourceUrl(platformBridge(), command.name, props.replay.revision);
          await image.decode();
          context.drawImage(
            image,
            command.destination.x,
            command.destination.y,
            command.destination.width,
            command.destination.height,
          );
        } catch {
          /* a canvas-backed sprite is handled by its replay canvas */
        }
        break;
      }
    }
  }
}

function argb(value: number): string {
  const unsigned = value >>> 0;
  const alpha = ((unsigned >>> 24) & 0xff) / 255;
  return `rgba(${(unsigned >>> 16) & 0xff}, ${(unsigned >>> 8) & 0xff}, ${unsigned & 0xff}, ${alpha})`;
}

watch(() => props.replay, render, { deep: true });
onMounted(render);
</script>

<template>
  <canvas
    ref="canvas"
    class="canvas-replay"
    :style="{
      width: `${replay.size.width * (scale ?? 1)}px`,
      height: `${replay.size.height * (scale ?? 1)}px`,
    }"
  />
</template>
