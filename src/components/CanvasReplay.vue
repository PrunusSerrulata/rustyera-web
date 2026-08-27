<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  canvasDimension,
  CanvasReplayBudget,
  createCanvasReplayRenderer,
  type CanvasReplayData,
  type CanvasReplayResources,
} from "@/components/canvasReplayRenderer";
import { htmlMeasurementProjectionKey } from "@/components/htmlMeasurementProjection";
import { RuntimeServiceError } from "@/core/runtimeServiceProtocol";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{
  replay: CanvasReplayData;
  scale?: number;
  displayWidth?: number;
  displayHeight?: number;
  visible?: boolean;
}>();
const measurement = inject(htmlMeasurementProjectionKey, undefined);
const store = measurement?.state ?? useRuntimeStore();
const firstSurface = ref<HTMLCanvasElement>();
const secondSurface = ref<HTMLCanvasElement>();
const activeSurface = ref(-1);
const renderer = createCanvasReplayRenderer();
const measurementReleases = new Set<() => void>();
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
  if (!rendering) {
    const task = drainRenders();
    if (measurement) measurement.track(task);
    else void task;
  }
}

async function drainRenders(): Promise<void> {
  rendering = true;
  try {
    while (!stopped && pendingRender) {
      const request = pendingRender;
      pendingRender = undefined;
      if (measurement) await measurement.wait(nextTick());
      else await nextTick();
      if (stopped || !firstSurface.value || !secondSurface.value) return;
      const targetIndex = activeSurface.value === 0 ? 1 : 0;
      const target = targetIndex === 0 ? firstSurface.value : secondSurface.value;
      const width = canvasDimension(request.replay.size.width);
      const height = canvasDimension(request.replay.size.height);
      const budget = measurement?.budget ?? new CanvasReplayBudget();
      let releaseTarget: (() => void) | undefined;
      const active = () =>
        !stopped &&
        (!measurement || measurement.active()) &&
        request.token === latestRenderToken &&
        request.resourceGeneration === Number(store.projectResourceGeneration ?? 0);
      const context = target.getContext("2d");
      if (!context) {
        if (measurement)
          throw new RuntimeServiceError("backend_failure", "HTML canvas 2D context is unavailable");
        continue;
      }
      try {
        releaseTarget = budget.reserve(width, height);
        if (!active()) throw new Error("canvas replay was cancelled");
        target.width = width;
        target.height = height;
        const replayTask = renderer.replay(
          context,
          request.replay,
          new Set([Number(request.replay.canvas_id)]),
          request.resources,
          request.resourceGeneration,
          { budget, active, strict: !!measurement, resourceBridge: measurement?.resourceBridge },
        );
        if (measurement) await measurement.wait(replayTask);
        else await replayTask;
      } catch (error) {
        target.width = 0;
        target.height = 0;
        if (measurement) throw error;
        if (active()) console.warn("Unable to replay generated canvas", error);
        continue;
      } finally {
        if (measurement && target.width > 0 && target.height > 0 && releaseTarget)
          measurementReleases.add(releaseTarget);
        else releaseTarget?.();
      }
      if (!active()) {
        target.width = 0;
        target.height = 0;
        continue;
      }
      await presentCanvas(target, targetIndex, request);
    }
  } finally {
    rendering = false;
    if (!stopped && pendingRender) {
      const task = drainRenders();
      if (measurement) measurement.track(task);
      else void task;
    }
  }
}

async function presentCanvas(
  target: HTMLCanvasElement,
  targetIndex: number,
  request: RenderRequest,
): Promise<void> {
  if (measurement) {
    measurement.assertCurrent();
  } else {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (
    stopped ||
    target !== (targetIndex === 0 ? firstSurface.value : secondSurface.value) ||
    request.resourceGeneration !== Number(store.projectResourceGeneration ?? 0) ||
    request.token !== latestRenderToken
  )
    return;
  activeSurface.value = targetIndex;
  // Apply both visibility changes before the other surface can become the next back buffer.
  if (measurement) await measurement.wait(nextTick());
  else await nextTick();
}

watch(() => props.replay, requestRender, { deep: true });
watch(
  () => store.projectResourceGeneration,
  () => {
    renderer.clear();
    releaseSurfaces();
    requestRender();
  },
  { flush: "sync" },
);
onMounted(() => {
  // A newly-created <canvas> owns a browser-default 300x150 backing store. Retire both defaults
  // before validating the first replay so an oversized/invalid frame cannot leave either surface
  // allocated even though it is never presented.
  releaseSurfaces();
  requestRender();
});
onBeforeUnmount(() => {
  stopped = true;
  pendingRender = undefined;
  renderer.clear();
  releaseSurfaces();
});

function releaseSurfaces(): void {
  activeSurface.value = -1;
  for (const release of measurementReleases) release();
  measurementReleases.clear();
  for (const surface of [firstSurface.value, secondSurface.value]) {
    if (!surface) continue;
    surface.width = 0;
    surface.height = 0;
  }
}
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
