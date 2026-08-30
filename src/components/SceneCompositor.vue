<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import type { CanvasReplayData } from "@/components/canvasReplayRenderer";
import SceneLayer from "@/components/SceneLayer.vue";
import { resolveCanvasReplay } from "@/core/replayResources";
import { sceneInteractionEligible, submitSceneInteraction } from "@/core/sceneActivation";
import { projectSceneLayer } from "@/core/sceneProjection";
import { sceneDepthKey, type SceneDepthRanks } from "@/core/sceneStacking";
import type { SceneInteractionV1, SceneSourceV1, SceneStateV1 } from "@/core/scene";
import {
  RuntimeServiceError,
  sameServiceInteger,
  serviceInteger,
} from "@/core/runtimeServiceProtocol";
import { pointerButtonValue, type PointerButtonModel } from "@/platform/pointerObservation";
import { registerScenePointerProvider } from "@/platform/scenePointerObservation";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{
  scene: SceneStateV1;
  lineTops: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  depthRanks: SceneDepthRanks;
  clock?: () => number;
}>();
const store = useRuntimeStore();
const compositor = ref<HTMLElement>();
const hitMapCanvas = ref<InstanceType<typeof CanvasReplay>>();
const selectedButtonValue = ref<bigint>();
let unregisterPointer: (() => void) | undefined;
let lastPointer: { x: number; y: number } | undefined;
let lastPixelSample: { key: string; buttonValue: bigint | undefined } | undefined;
let animationTimer: number | undefined;
let animationSessionStart = clockNow();
const animationTimeMs = ref(0);
const animationOrigins = new Map<string, number>();

const animationScope = computed(
  () => `${String(store.runtimeEpoch)}:${String(store.projectResourceGeneration)}`,
);
const animationSources = computed(() =>
  props.scene.layers.flatMap((layer) =>
    [layer.source, layer.interaction?.hover_source].filter(
      (source): source is SceneSourceV1 => source?.type === "sprite",
    ),
  ),
);
const projectedLayers = computed(() =>
  props.scene.layers.flatMap((layer) => {
    const projection = projectSceneLayer(layer, {
      lineTops: props.lineTops,
      scrollTop: props.scrollTop,
      viewportWidth: props.viewportWidth,
      viewportHeight: props.viewportHeight,
    });
    if (!projection?.visible) return [];
    const stackOrder = props.depthRanks.get(sceneDepthKey(layer.depth));
    if (stackOrder == null)
      throw new RuntimeServiceError("invalid_request", "scene depth has no compositor rank");
    return [{ layer, stackOrder, ...projection }];
  }),
);
const hitMapReplay = computed(() => {
  const sources = props.scene.layers
    .map((layer) => layer.interaction?.hit_map)
    .filter((source): source is SceneSourceV1 => source != null);
  if (!sources.length) return undefined;
  const source = sources[0];
  if (
    source.type !== "canvas" ||
    sources.some(
      (candidate) =>
        candidate.type !== "canvas" ||
        !sameServiceInteger(candidate.canvas_id, source.canvas_id) ||
        !sameServiceInteger(candidate.resource_revision, source.resource_revision),
    )
  )
    throw new RuntimeServiceError(
      "invalid_request",
      "scene interactions do not share one revision-bound canvas hit map",
    );
  return resolveCanvasReplay<CanvasReplayData>(
    store.presentation.resources.canvases as CanvasReplayData[] | undefined,
    source.canvas_id,
    source.resource_revision,
  );
});

onMounted(() => {
  unregisterPointer = registerScenePointerProvider({
    observe: observeAt,
    activate: activateAt,
  });
});
onBeforeUnmount(() => unregisterPointer?.());
watch(
  animationScope,
  () => {
    animationSessionStart = clockNow();
    animationTimeMs.value = 0;
    animationOrigins.clear();
    ensureAnimationOrigins(animationSources.value);
  },
  { immediate: true },
);
watch(animationSources, ensureAnimationOrigins, { immediate: true });
watch(
  () => Number(store.presentation.resources.animation_timer_ms ?? 0),
  (milliseconds) => {
    if (animationTimer != null) window.clearInterval(animationTimer);
    animationTimer = undefined;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return;
    animationTimer = window.setInterval(() => {
      animationTimeMs.value = Math.max(0, clockNow() - animationSessionStart);
    }, milliseconds);
  },
  { immediate: true },
);
watch(
  [
    () => props.scrollTop,
    () => props.viewportWidth,
    () => props.viewportHeight,
    () => props.scene.revision,
  ],
  () => {
    if (lastPointer) observeAt(lastPointer.x, lastPointer.y);
  },
);
onBeforeUnmount(() => {
  if (animationTimer != null) window.clearInterval(animationTimer);
});

function clockNow(): number {
  const value = props.clock?.() ?? performance.now();
  if (!Number.isFinite(value))
    throw new RuntimeServiceError("invalid_request", "scene animation clock is not finite");
  return value;
}

function ensureAnimationOrigins(sources: SceneSourceV1[]): void {
  for (const source of sources) {
    const key = animationKey(source);
    if (key && !animationOrigins.has(key)) animationOrigins.set(key, animationTimeMs.value);
  }
}

function animationElapsed(source: SceneSourceV1 | null | undefined): number {
  const key = source ? animationKey(source) : undefined;
  if (!key) return 0;
  const origin = animationOrigins.get(key) ?? animationTimeMs.value;
  if (!animationOrigins.has(key)) animationOrigins.set(key, origin);
  return Math.max(0, animationTimeMs.value - origin);
}

function animationKey(source: SceneSourceV1): string | undefined {
  return source.type === "sprite"
    ? `${animationScope.value}:${source.sprite_name.toUpperCase()}:${String(
        source.resource_revision,
      )}`
    : undefined;
}

function observeAt(clientX: number, clientY: number): PointerButtonModel | undefined {
  const sample = sampleAt(clientX, clientY);
  selectedButtonValue.value = sample?.buttonValue;
  return sample?.model;
}

function activateAt(clientX: number, clientY: number): boolean {
  const sample = sampleAt(clientX, clientY);
  selectedButtonValue.value = sample?.buttonValue;
  if (!sample) return false;
  return submitSceneInteraction(animationScope.value, sample.interaction, (token) =>
    store.activate(token),
  );
}

function sampleAt(
  clientX: number,
  clientY: number,
): { buttonValue: bigint; interaction: SceneInteractionV1; model: PointerButtonModel } | undefined {
  lastPointer = { x: clientX, y: clientY };
  const replay = hitMapReplay.value;
  const canvas = hitMapCanvas.value;
  const viewport = compositor.value?.closest(".game-viewport");
  if (!replay || !canvas || !(viewport instanceof HTMLElement)) return undefined;
  const rectangle = viewport.getBoundingClientRect();
  const hitMapHeight = Number(serviceInteger(replay.size.height, "scene hit map height"));
  if (!Number.isSafeInteger(hitMapHeight))
    throw new RuntimeServiceError("invalid_request", "scene hit map height exceeds the DOM range");
  const x = Math.floor(clientX - rectangle.left - viewport.clientLeft);
  const y = Math.floor(
    clientY - rectangle.top - viewport.clientTop - viewport.clientHeight + hitMapHeight,
  );
  const sampleKey = [
    x,
    y,
    String(props.scene.revision),
    String(replay.canvas_id),
    String(replay.revision),
    String(store.projectResourceGeneration),
    props.scrollTop,
    props.viewportWidth,
    props.viewportHeight,
  ].join(":");
  if (lastPixelSample?.key !== sampleKey) {
    const pixel = canvas.sampleArgb(x, y);
    lastPixelSample = {
      key: sampleKey,
      buttonValue: pixel != null && pixel >>> 24 === 0xff ? BigInt(pixel & 0xffffff) : undefined,
    };
  }
  const buttonValue = lastPixelSample.buttonValue;
  if (buttonValue == null) return undefined;
  const interaction = props.scene.layers.find((layer) => {
    const current = layer.interaction;
    return (
      current?.hit_map != null &&
      eligible(current) &&
      protocolInteger(current.value) === buttonValue
    );
  })?.interaction;
  if (!interaction) return undefined;
  const value = pointerButtonValue(interaction.value);
  if (value == null) return undefined;
  return {
    buttonValue,
    interaction,
    model: { epoch: interaction.token.epoch, value },
  };
}

function eligible(interaction: SceneInteractionV1): boolean {
  return sceneInteractionEligible(interaction, store);
}

function selectButtonMap(event: PointerEvent): void {
  observeAt(event.clientX, event.clientY);
}

function clearSelection(): void {
  lastPointer = undefined;
  lastPixelSample = undefined;
  selectedButtonValue.value = undefined;
}

function protocolInteger(value: unknown): bigint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const scalar = value as { type?: unknown; value?: unknown };
  if (scalar.type !== "integer") return undefined;
  try {
    return BigInt(serviceInteger(scalar.value, "scene button value", true));
  } catch {
    return undefined;
  }
}
</script>

<template>
  <div
    ref="compositor"
    class="scene-compositor"
    @pointermove.capture="selectButtonMap"
    @pointerleave="clearSelection"
  >
    <div class="scene-layer-stack">
      <SceneLayer
        v-for="projected in projectedLayers"
        :key="String(projected.layer.layer_id)"
        :layer="projected.layer"
        :top="projected.top"
        :left="projected.left"
        :stack-order="projected.stackOrder"
        :bottom-aligned="projected.bottomAligned"
        :selected-by-map="
          protocolInteger(projected.layer.interaction?.value) === selectedButtonValue
        "
        :animation-time-ms="animationElapsed(projected.layer.source)"
        :hover-animation-time-ms="animationElapsed(projected.layer.interaction?.hover_source)"
        :activation-scope="animationScope"
      />
    </div>
    <slot />
    <slot name="positioned-html" />
    <span v-if="hitMapReplay" class="scene-hit-map" aria-hidden="true">
      <CanvasReplay ref="hitMapCanvas" :replay="hitMapReplay" />
    </span>
  </div>
</template>
