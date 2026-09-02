<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import {
  projectLogicalPixels,
  projectMediaDimensions,
  projectMediaOffset,
} from "@/core/mediaProjection";
import { acquireResourceUrl } from "@/core/resources";
import type { PresentationLength } from "@/core/types";
import { platformBridge } from "@/platform";
import { useRuntimeStore } from "@/stores/runtime";

const props = withDefaults(defineProps<{ placement: any; alt?: string; lineSlot?: boolean }>(), {
  alt: undefined,
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
const resourceIdentity = computed(() =>
  JSON.stringify(
    [
      Number(store.projectResourceGeneration ?? 0),
      activeResourceId.value,
      frame.value?.resource_id ?? activeResourceId.value,
      frame.value?.source_rectangle ?? null,
      props.placement.revision,
    ],
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  ),
);
// Emuera paints complete frames into a double-buffered control. Generated portraits instead
// arrive here as a canvas-backed sprite followed by their final file-backed sprite. Retain the
// last canvas in a stable container while that final image loads, then switch the two layers in
// one patch at a frame boundary. At most one layer contributes pixels at any time.
const retainedCanvasReplay = shallowRef<any>();
const sourceIdentity = ref("");
const handoffIdentity = ref("");
const handoffImageVisible = ref(false);
const handoffSource = computed(() =>
  sourceIdentity.value === handoffIdentity.value ? source.value : undefined,
);
let canvasHandoffFrame: number | undefined;
let mediaStopped = false;

watch(
  [canvasReplay, resourceIdentity],
  ([value, identity]) => {
    cancelCanvasHandoff();
    handoffImageVisible.value = false;
    if (value) {
      retainedCanvasReplay.value = value;
      handoffIdentity.value = "";
    } else if (retainedCanvasReplay.value) {
      handoffIdentity.value = identity;
    }
  },
  { immediate: true, flush: "sync" },
);

watchEffect((onCleanup) => {
  const resourceId = frame.value?.resource_id ?? activeResourceId.value;
  const identity = resourceIdentity.value;
  naturalSize.value = undefined;
  if (!resourceId || canvasReplay.value) {
    source.value = "";
    sourceIdentity.value = "";
    failed.value = false;
    return;
  }
  let active = true;
  // Keep the current visual mounted while a hover replacement loads. Otherwise
  // the pointer leaves a positioned image as soon as its one-row slot is exposed.
  failed.value = false;
  const lease = acquireResourceUrl(
    platformBridge(),
    resourceId,
    props.placement.revision,
    Number(store.projectResourceGeneration ?? 0),
  );
  void lease.url
    .then((value) => {
      if (active) {
        source.value = value;
        sourceIdentity.value = identity;
      }
    })
    .catch(() => {
      if (active) failed.value = true;
    });
  onCleanup(() => {
    active = false;
    lease.release();
  });
});

const dimensions = computed(() => {
  return projectMediaDimensions({
    requestedWidth: props.placement.requested_width,
    requestedHeight: props.placement.requested_height,
    placementWidth: props.placement.width,
    placementHeight: props.placement.height,
    spriteWidth: positive(sprite.value?.size?.[0]) ?? naturalSize.value?.width,
    spriteHeight: positive(sprite.value?.size?.[1]) ?? naturalSize.value?.height,
    fontSizePx: store.gameTextStyle.fontSizePx,
  });
});
const horizontallyFlipped = computed(() => Number(props.placement.requested_width?.value) < 0);
const horizontalTransform = computed(() => (horizontallyFlipped.value ? "scaleX(-1)" : undefined));
const verticallyFlipped = computed(() => Number(props.placement.requested_height?.value) < 0);
const imageTransform = computed(() => {
  if (horizontallyFlipped.value && verticallyFlipped.value) return "scale(-1, -1)";
  if (horizontallyFlipped.value) return "scaleX(-1)";
  return verticallyFlipped.value ? "scaleY(-1)" : undefined;
});

const opacity = computed(() =>
  props.placement.opacity?.denominator
    ? props.placement.opacity.numerator / props.placement.opacity.denominator
    : 1,
);
const scale = computed(() => store.effectivePreferences.imageScale);
const escapesConsoleRow = computed(() => props.placement.requested_y != null);
const positionedSlotHeight = computed(
  () => projectLogicalPixels(props.placement.height) ?? store.gameTextStyle.fontSizePx,
);
const positionedSlotScale = computed(() => (escapesConsoleRow.value ? 1 : scale.value));
const directStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: dimensions.value.height ? `${dimensions.value.height * scale.value}px` : undefined,
  top: verticalOffset(),
  opacity: opacity.value,
  zIndex: props.placement.depth,
  transform: imageTransform.value,
}));
const positionedSlotStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  // A ypos image escapes a fixed Emuera console row. Client image scaling changes its painted
  // pixels, not the row advance; scaling this slot accumulates one layout error per redraw.
  height: `${positionedSlotHeight.value * positionedSlotScale.value}px`,
  "--media-row-offset": `${-positionedSlotHeight.value * positionedSlotScale.value}px`,
  opacity: opacity.value,
  zIndex: props.placement.depth,
  transform: horizontalTransform.value,
}));
const positionedVisualStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: dimensions.value.height ? `${dimensions.value.height * scale.value}px` : undefined,
  top: verticalOffset() ?? "0px",
  transform: verticallyFlipped.value ? "scaleY(-1)" : undefined,
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
  transform: imageTransform.value,
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

function positive(value: unknown): number | undefined {
  const result = Math.abs(Number(value));
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function verticalOffset(): string | undefined {
  const value = props.placement.requested_y as PresentationLength | undefined;
  const magnitude = projectMediaOffset(value, store.gameTextStyle.fontSizePx);
  return magnitude != null && Number.isFinite(magnitude)
    ? `${magnitude * scale.value}px`
    : undefined;
}

function imageLoaded(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight };
  }
  if (!canvasReplay.value && retainedCanvasReplay.value) {
    const identity = image.dataset.handoffIdentity;
    if (
      !identity ||
      identity !== handoffIdentity.value ||
      identity !== resourceIdentity.value ||
      identity !== sourceIdentity.value ||
      image.naturalWidth <= 0 ||
      image.naturalHeight <= 0
    )
      return;
    cancelCanvasHandoff();
    canvasHandoffFrame = requestAnimationFrame(() => {
      canvasHandoffFrame = undefined;
      if (
        !canvasReplay.value &&
        retainedCanvasReplay.value &&
        identity === handoffIdentity.value &&
        identity === resourceIdentity.value &&
        identity === sourceIdentity.value &&
        !mediaStopped
      )
        handoffImageVisible.value = true;
    });
  }
}

function imageFailed(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  if (image.dataset.handoffIdentity !== handoffIdentity.value) return;
  cancelCanvasHandoff();
  handoffImageVisible.value = false;
}

function cancelCanvasHandoff(): void {
  if (canvasHandoffFrame == null) return;
  cancelAnimationFrame(canvasHandoffFrame);
  canvasHandoffFrame = undefined;
}

function startHover(): void {
  hovered.value = true;
}

function stopHover(): void {
  hovered.value = false;
}

onBeforeUnmount(() => {
  mediaStopped = true;
  cancelCanvasHandoff();
});
</script>

<template>
  <span
    v-if="lineSlot && retainedCanvasReplay"
    class="media-image media-positioned"
    :style="positionedSlotStyle"
  >
    <span
      class="media-visual"
      :class="{
        'media-bottom-anchored': bottomAnchored,
        'media-sprite': !canvasReplay && sprite && frame,
        'media-canvas-handoff': !canvasReplay,
      }"
      :style="positionedVisualStyle"
    >
      <CanvasReplay
        :replay="retainedCanvasReplay"
        :display-width="dimensions.width ? dimensions.width * scale : undefined"
        :display-height="dimensions.height ? dimensions.height * scale : undefined"
        :visible="!handoffImageVisible"
      />
      <img
        v-if="!canvasReplay"
        class="media-canvas-handoff-image"
        :class="{ 'media-canvas-handoff-image-visible': handoffImageVisible }"
        :src="handoffSource"
        :data-handoff-identity="handoffIdentity"
        :alt="alt ?? ''"
        :style="frame ? spriteSourceStyle : undefined"
        draggable="false"
        @error="imageFailed"
        @load="imageLoaded"
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
  <span
    v-else-if="retainedCanvasReplay"
    class="media-image"
    :class="{
      'media-sprite': !canvasReplay && sprite && frame,
      'media-canvas-handoff': !canvasReplay,
    }"
    :style="frame ? spriteStyle : directStyle"
  >
    <CanvasReplay
      :replay="retainedCanvasReplay"
      :scale="store.effectivePreferences.imageScale"
      :visible="!handoffImageVisible"
      :style="{ transform: horizontalTransform }"
    />
    <img
      v-if="!canvasReplay"
      class="media-canvas-handoff-image"
      :class="{ 'media-canvas-handoff-image-visible': handoffImageVisible }"
      :src="handoffSource"
      :data-handoff-identity="handoffIdentity"
      :alt="alt ?? ''"
      :style="frame ? spriteSourceStyle : undefined"
      draggable="false"
      @error="imageFailed"
      @load="imageLoaded"
    />
  </span>
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
