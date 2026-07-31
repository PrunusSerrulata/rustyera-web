<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import { resourceUrl } from "@/core/resources";
import type { PresentationLength } from "@/core/types";
import { platformBridge } from "@/platform";
import { useRuntimeStore } from "@/stores/runtime";

const props = withDefaults(defineProps<{ placement: any; alt?: string; lineSlot?: boolean }>(), {
  lineSlot: true,
});
const store = useRuntimeStore();
const source = ref("");
const failed = ref(false);
const hovered = ref(false);
const naturalSize = ref<{ width: number; height: number }>();
const activeResourceId = computed(() =>
  hovered.value && props.placement.hover_resource_id
    ? props.placement.hover_resource_id
    : props.placement.resource_id,
);
const sprite = computed(() => {
  const key = activeResourceId.value.toUpperCase();
  return store.presentation.resources.sprites?.find(
    (item: any) => String(item.name).toUpperCase() === key,
  );
});
const frame = computed(() => sprite.value?.frames?.[0]);
const canvasReplay = computed(() => {
  const canvasId = sprite.value?.canvas_id;
  return canvasId == null
    ? undefined
    : store.presentation.resources.canvases?.find((item: any) => item.canvas_id === canvasId);
});

watchEffect((onCleanup) => {
  const resourceId = frame.value?.resource_id ?? activeResourceId.value;
  naturalSize.value = undefined;
  if (!resourceId || canvasReplay.value) {
    source.value = "";
    failed.value = false;
    return;
  }
  let active = true;
  // Keep the current visual mounted while a hover replacement loads. Otherwise
  // the pointer leaves a positioned image as soon as its one-row slot is exposed.
  failed.value = false;
  void resourceUrl(platformBridge(), resourceId, props.placement.revision)
    .then((value) => {
      if (active) source.value = value;
    })
    .catch(() => {
      if (active) failed.value = true;
    });
  onCleanup(() => {
    active = false;
  });
});

const dimensions = computed(() => {
  const spriteWidth = positive(sprite.value?.size?.[0]) ?? naturalSize.value?.width;
  const spriteHeight = positive(sprite.value?.size?.[1]) ?? naturalSize.value?.height;
  const requestedWidth = projectLength(props.placement.requested_width);
  const requestedHeight = projectLength(props.placement.requested_height);
  const placementWidth = logicalPixels(props.placement.width);
  const placementHeight = logicalPixels(props.placement.height);
  let width = requestedWidth ?? placementWidth;
  let height = requestedHeight ?? placementHeight;
  if (width == null && height == null) {
    width = spriteWidth;
    height = spriteHeight;
  }
  if (width != null && height == null && spriteWidth && spriteHeight) {
    height = (width * spriteHeight) / spriteWidth;
  } else if (height != null && width == null && spriteWidth && spriteHeight) {
    width = (height * spriteWidth) / spriteHeight;
  }
  return { width, height };
});

const opacity = computed(() =>
  props.placement.opacity?.denominator
    ? props.placement.opacity.numerator / props.placement.opacity.denominator
    : 1,
);
const scale = computed(() => store.effectivePreferences.imageScale);
const directStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: dimensions.value.height ? `${dimensions.value.height * scale.value}px` : undefined,
  top: verticalOffset(),
  opacity: opacity.value,
  zIndex: props.placement.depth,
}));
const positionedSlotStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: `${(logicalPixels(props.placement.height) ?? store.gameTextStyle.fontSizePx) * scale.value}px`,
  "--media-row-offset": `${-(logicalPixels(props.placement.height) ?? store.gameTextStyle.fontSizePx) * scale.value}px`,
  opacity: opacity.value,
  zIndex: props.placement.depth,
}));
const positionedVisualStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: dimensions.value.height ? `${dimensions.value.height * scale.value}px` : undefined,
  top: verticalOffset() ?? "0px",
}));
const bottomAnchored = computed(() => {
  const y = props.placement.requested_y as PresentationLength | undefined;
  const height = props.placement.requested_height as PresentationLength | undefined;
  if (!y || !height || y.unit !== height.unit) return false;
  const yValue = Number(y.value);
  const heightValue = Math.abs(Number(height.value));
  return Number.isFinite(yValue) && Number.isFinite(heightValue) && yValue + heightValue === 0;
});
const spriteStyle = computed(() => ({
  width: `${(dimensions.value.width ?? 0) * scale.value}px`,
  height: `${(dimensions.value.height ?? 0) * scale.value}px`,
  top: verticalOffset(),
  opacity: opacity.value,
  zIndex: props.placement.depth,
}));
const spriteSourceStyle = computed(() => {
  const rectangle = frame.value?.source_rectangle ?? [0, 0, 0, 0];
  const sourceWidth = positive(rectangle[2]) ?? positive(sprite.value?.size?.[0]) ?? 1;
  const sourceHeight = positive(rectangle[3]) ?? positive(sprite.value?.size?.[1]) ?? 1;
  const ratioX = ((dimensions.value.width ?? sourceWidth) * scale.value) / sourceWidth;
  const ratioY = ((dimensions.value.height ?? sourceHeight) * scale.value) / sourceHeight;
  return {
    left: `${-Number(rectangle[0] ?? 0) * ratioX}px`,
    top: `${-Number(rectangle[1] ?? 0) * ratioY}px`,
    transform: `scale(${ratioX}, ${ratioY})`,
  };
});

function projectLength(value: PresentationLength | undefined): number | undefined {
  if (!value) return undefined;
  if (value.unit === "pixels") return Math.abs(Number(value.value));
  if (value.unit === "logical") return Math.abs(Number(value.value)) / 1000;
  return (Math.abs(Number(value.value)) * store.gameTextStyle.fontSizePx) / 100;
}

function logicalPixels(value: unknown): number | undefined {
  const result = Math.abs(Number(value)) / 1000;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function positive(value: unknown): number | undefined {
  const result = Math.abs(Number(value));
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function verticalOffset(): string | undefined {
  const value = props.placement.requested_y as PresentationLength | undefined;
  if (!value) return undefined;
  const magnitude =
    value.unit === "pixels"
      ? Number(value.value)
      : value.unit === "logical"
        ? Number(value.value) / 1000
        : (Number(value.value) * store.gameTextStyle.fontSizePx) / 100;
  return Number.isFinite(magnitude) ? `${magnitude * scale.value}px` : undefined;
}

function imageLoaded(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight };
  }
}

function startHover(): void {
  hovered.value = true;
}

function stopHover(): void {
  hovered.value = false;
}
</script>

<template>
  <span
    v-if="lineSlot && canvasReplay"
    class="media-image media-positioned"
    :style="positionedSlotStyle"
  >
    <span
      class="media-visual"
      :class="{ 'media-bottom-anchored': bottomAnchored }"
      :style="positionedVisualStyle"
    >
      <CanvasReplay
        :replay="canvasReplay"
        :display-width="dimensions.width ? dimensions.width * scale : undefined"
        :display-height="dimensions.height ? dimensions.height * scale : undefined"
      />
    </span>
  </span>
  <span
    v-else-if="lineSlot && sprite && frame && source && dimensions.width && dimensions.height"
    class="media-image media-positioned"
    :style="positionedSlotStyle"
  >
    <span
      class="media-visual media-sprite"
      :class="{ 'media-hovered': hovered, 'media-bottom-anchored': bottomAnchored }"
      :style="positionedVisualStyle"
      @mouseenter="startHover"
      @mousemove="startHover"
      @mouseleave="stopHover"
    >
      <img
        :src="source"
        :alt="alt ?? ''"
        :style="spriteSourceStyle"
        draggable="false"
        @load="imageLoaded"
      />
    </span>
  </span>
  <span
    v-else-if="lineSlot && source"
    class="media-image media-positioned"
    :style="positionedSlotStyle"
  >
    <img
      class="media-visual"
      :class="{ 'media-hovered': hovered, 'media-bottom-anchored': bottomAnchored }"
      :src="source"
      :alt="alt ?? ''"
      :style="positionedVisualStyle"
      draggable="false"
      @mouseenter="startHover"
      @mousemove="startHover"
      @mouseleave="stopHover"
      @load="imageLoaded"
    />
  </span>
  <CanvasReplay
    v-else-if="canvasReplay"
    :replay="canvasReplay"
    :scale="store.effectivePreferences.imageScale"
  />
  <span
    v-else-if="sprite && frame && source && dimensions.width && dimensions.height"
    class="media-image media-sprite"
    :style="spriteStyle"
    @mouseenter="startHover"
    @mouseleave="stopHover"
  >
    <img
      :src="source"
      :alt="alt ?? ''"
      :style="spriteSourceStyle"
      draggable="false"
      @load="imageLoaded"
    />
  </span>
  <img
    v-else-if="source"
    class="media-image"
    :src="source"
    :alt="alt ?? ''"
    :style="directStyle"
    draggable="false"
    @mouseenter="startHover"
    @mouseleave="stopHover"
    @load="imageLoaded"
  />
  <span v-else-if="failed && alt" class="media-image-fallback">{{ alt }}</span>
</template>
