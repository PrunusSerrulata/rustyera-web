<script setup lang="ts">
import { computed, ref } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import MediaImage from "@/components/MediaImage.vue";
import type { CanvasReplayData } from "@/components/canvasReplayRenderer";
import { usePointerButton } from "@/components/usePointerButton";
import { pointerButtonValue } from "@/platform/pointerObservation";
import { sceneColorMatrixFilter } from "@/core/colorMatrix";
import { resolveCanvasReplay, resolveSpriteReplay } from "@/core/replayResources";
import type { SceneLayerV1, SceneSourceV1 } from "@/core/scene";
import { sceneInteractionEligible, submitSceneInteraction } from "@/core/sceneActivation";
import { RuntimeServiceError, serviceInteger } from "@/core/runtimeServiceProtocol";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{
  layer: SceneLayerV1;
  top: number;
  left: number;
  stackOrder: number;
  bottomAligned?: boolean;
  selectedByMap?: boolean;
  animationTimeMs?: number;
  hoverAnimationTimeMs?: number;
  activationScope: string;
}>();
const store = useRuntimeStore();
const pointerInside = ref(false);

const interaction = computed(() => props.layer.interaction);
const selectable = computed(() => sceneInteractionEligible(interaction.value, store));
const activeSource = computed(() =>
  selected.value && interaction.value?.hover_source
    ? interaction.value.hover_source
    : props.layer.source,
);
const resolved = computed(() => resolveSource(activeSource.value));
const selected = computed(
  () =>
    selectable.value &&
    (interaction.value?.hit_map ? props.selectedByMap === true : pointerInside.value),
);
const width = computed(() => logicalPixels(props.layer.size.width, "scene layer width"));
const height = computed(() => logicalPixels(props.layer.size.height, "scene layer height"));
const frameIndex = computed(() => animatedFrameIndex(resolved.value?.sprite?.frames ?? []));
const filterId = `scene-color-${String(props.layer.layer_id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
const colorMatrix = computed(() => sceneColorMatrixFilter(props.layer.color_matrix));
const style = computed(() => ({
  left: `${props.left}px`,
  top: `${props.top}px`,
  width: width.value > 0 ? `${width.value}px` : undefined,
  height: height.value > 0 ? `${height.value}px` : undefined,
  // Snake's color filter replaces its opacity filter when both arguments are present.
  opacity: colorMatrix.value ? 1 : props.layer.opacity / 255,
  zIndex: props.stackOrder,
  transform: props.bottomAligned ? "translateY(-100%)" : undefined,
}));
const visualStyle = computed(() => ({
  filter: colorMatrix.value ? `url(#${filterId})` : undefined,
}));
const placement = computed(() => ({
  resource_id:
    activeSource.value.type === "resource"
      ? activeSource.value.resource_id
      : activeSource.value.type === "sprite"
        ? activeSource.value.sprite_name
        : "",
  x: 0,
  y: 0,
  width: serviceInteger(props.layer.size.width, "scene layer width", true),
  height: serviceInteger(props.layer.size.height, "scene layer height", true),
  depth: 0,
  opacity: { numerator: 1, denominator: 1 },
  revision: activeSource.value.resource_revision,
  requested_width: width.value ? { unit: "pixels", value: width.value } : undefined,
  requested_height: height.value ? { unit: "pixels", value: height.value } : undefined,
}));
const pointerButton = usePointerButton(() => {
  const current = interaction.value;
  const value = pointerButtonValue(current?.value);
  if (!current || !selectable.value || current.hit_map || value == null) return undefined;
  return { epoch: current.token.epoch, value };
});

interface SceneSpriteFrame {
  delay_ms?: unknown;
}

interface SceneSpriteReplay {
  name: unknown;
  revision: unknown;
  frames?: SceneSpriteFrame[];
}

function resolveSource(
  source: SceneSourceV1,
): { source: SceneSourceV1; sprite?: SceneSpriteReplay; canvas?: CanvasReplayData } | undefined {
  if (source.type === "resource") return { source };
  if (source.type === "sprite") {
    const sprite = resolveSpriteReplay<SceneSpriteReplay>(
      store.presentation.resources.sprites as SceneSpriteReplay[] | undefined,
      source.sprite_name,
      source.resource_revision,
    );
    return sprite ? { source, sprite } : undefined;
  }
  const canvas = resolveCanvasReplay(
    store.presentation.resources.canvases as CanvasReplayData[] | undefined,
    source.canvas_id,
    source.resource_revision,
  );
  return canvas ? { source, canvas } : undefined;
}

function animatedFrameIndex(frames: SceneSpriteFrame[]): number {
  if (frames.length < 2) return 0;
  const delays = frames.map((frame) => frameDelay(frame.delay_ms));
  const duration = delays.reduce((total, delay) => total + delay, 0);
  const elapsedSource =
    activeSource.value === interaction.value?.hover_source
      ? props.hoverAnimationTimeMs
      : props.animationTimeMs;
  let elapsed = Number(elapsedSource ?? 0) % duration;
  for (let index = 0; index < frames.length; index += 1) {
    elapsed -= delays[index];
    if (elapsed < 0) return index;
  }
  return 0;
}

function updateHit(): void {
  pointerInside.value = true;
}

function leave(): void {
  pointerInside.value = false;
}

function activate(event: MouseEvent): void {
  event.stopPropagation();
  const current = interaction.value;
  const selectedForActivation = current?.hit_map ? selected.value : selectable.value;
  if (current && selectedForActivation && selectable.value)
    submitSceneInteraction(props.activationScope, current, (token) => store.activate(token));
}

function logicalPixels(value: unknown, name: string): number {
  const integer = BigInt(serviceInteger(value, name, true));
  const absolute = integer < 0n ? -integer : integer;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
  if (absolute > maximum)
    throw new RuntimeServiceError("invalid_request", `${name} exceeds the DOM coordinate range`);
  return Number(absolute) / 1000;
}

function frameDelay(value: unknown): number {
  const delay = Number(serviceInteger(value ?? 1, "sprite frame delay"));
  return Math.max(1, delay);
}
</script>

<template>
  <span
    v-if="resolved"
    :ref="pointerButton"
    class="scene-layer"
    :class="{ 'scene-layer-interactive': selectable }"
    :style="style"
    :data-scene-layer-id="String(layer.layer_id)"
    :data-scene-depth="String(layer.depth)"
    :data-era-tooltip="interaction?.title || undefined"
    :aria-disabled="interaction ? !selectable : undefined"
    @pointerenter="updateHit"
    @pointermove="updateHit"
    @pointerleave="leave"
    @click="activate"
  >
    <svg v-if="colorMatrix" class="scene-color-filter" aria-hidden="true">
      <filter :id="filterId" color-interpolation-filters="sRGB">
        <feColorMatrix type="matrix" :values="colorMatrix" />
      </filter>
    </svg>
    <span class="scene-layer-visual" :style="visualStyle">
      <CanvasReplay
        v-if="resolved.canvas"
        :replay="resolved.canvas"
        :display-width="width || undefined"
        :display-height="height || undefined"
      />
      <MediaImage
        v-else
        :placement="placement"
        :line-slot="false"
        :frame-index="frameIndex"
        :allow-frame-canvas="true"
        :resolve-sprite="activeSource.type === 'sprite'"
        :sprite-revision="activeSource.resource_revision"
      />
    </span>
  </span>
</template>
