<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  canvasDimension,
  createCanvasReplayRenderer,
  type CanvasReplayData,
  type CanvasReplayResources,
} from "@/components/canvasReplayRenderer";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{
  replay: CanvasReplayData;
  scale?: number;
  displayWidth?: number;
  displayHeight?: number;
  visible?: boolean;
}>();
const store = useRuntimeStore();
const firstSurface = ref<HTMLCanvasElement>();
const secondSurface = ref<HTMLCanvasElement>();
const activeSurface = ref(-1);
const renderer = createCanvasReplayRenderer();
interface RenderRequest {
  replay: CanvasReplayData;
  resources: CanvasReplayResources;
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
        await renderer.replay(
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

watch(() => props.replay, requestRender, { deep: true });
watch(
  () => store.projectResourceGeneration,
  () => {
    renderer.clear();
    requestRender();
  },
  { flush: "sync" },
);
onMounted(requestRender);
onBeforeUnmount(() => {
  stopped = true;
  pendingRender = undefined;
  renderer.clear();
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
