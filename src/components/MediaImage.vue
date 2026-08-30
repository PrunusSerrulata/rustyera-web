<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, useId, watch, watchEffect } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import { htmlMeasurementProjectionKey } from "@/components/htmlMeasurementProjection";
import { HTML_MEASUREMENT_LIMITS } from "@/core/htmlMeasurement";
import { fixedColorMatrixFilter } from "@/core/colorMatrix";
import {
  resolveCanvasReplay,
  resolveSpriteReplay,
  type RevisionedSpriteReplay,
} from "@/core/replayResources";
import {
  RuntimeServiceError,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import { acquireResourceUrl } from "@/core/resources";
import type { PresentationLength } from "@/core/types";
import { platformBridge } from "@/platform";
import { useRuntimeStore } from "@/stores/runtime";

const props = withDefaults(
  defineProps<{
    placement: any;
    alt?: string;
    lineSlot?: boolean;
    frameIndex?: number;
    allowFrameCanvas?: boolean;
    resolveSprite?: boolean;
    spriteRevision?: ServiceInteger;
  }>(),
  {
    alt: undefined,
    lineSlot: true,
    frameIndex: 0,
    allowFrameCanvas: false,
    resolveSprite: true,
    spriteRevision: undefined,
  },
);
const measurement = inject(htmlMeasurementProjectionKey, undefined);
const store = measurement?.state ?? useRuntimeStore();
const source = ref("");
const failed = ref(false);
const hovered = ref(false);
const naturalSize = ref<{ width: number; height: number }>();
const activeResourceId = computed(() =>
  hovered.value && props.placement.hover_resource_id
    ? props.placement.hover_resource_id
    : props.placement.resource_id,
);
const colorMatrix = computed(() => fixedColorMatrixFilter(props.placement.color_matrix));
const colorFilterId = `media-color-${useId().replace(/[^a-zA-Z0-9_-]/g, "-")}`;
const colorFilter = computed(() => (colorMatrix.value ? `url(#${colorFilterId})` : undefined));

interface MediaSpriteFrame {
  canvas_id?: unknown;
  canvas_revision?: unknown;
  resource_id?: string;
  source_rectangle?: readonly unknown[];
}

interface MediaSpriteReplay extends RevisionedSpriteReplay {
  canvas_id?: unknown;
  canvas_revision?: unknown;
  frames?: MediaSpriteFrame[];
  size?: readonly unknown[];
}

const sprite = computed(() => {
  if (!props.resolveSprite) return undefined;
  const revision = props.spriteRevision ?? props.placement.revision;
  if (revision == null) return undefined;
  return resolveSpriteReplay<MediaSpriteReplay>(
    store.presentation.resources.sprites as MediaSpriteReplay[] | undefined,
    activeResourceId.value,
    revision,
  );
});
const frame = computed(() => {
  const frames = sprite.value?.frames ?? [];
  return frames.length ? frames[Math.max(0, props.frameIndex) % frames.length] : undefined;
});
const canvasReplay = computed(() => {
  const canvasId =
    sprite.value?.canvas_id ??
    (measurement || props.allowFrameCanvas ? frame.value?.canvas_id : undefined);
  if (canvasId == null) return undefined;
  const canvasRevision =
    sprite.value?.canvas_id != null ? sprite.value.canvas_revision : frame.value?.canvas_revision;
  if (canvasRevision == null)
    throw new RuntimeServiceError("invalid_request", "canvas-backed sprite has no canvas revision");
  const replay = resolveCanvasReplay(
    store.presentation.resources.canvases,
    serviceInteger(canvasId, "sprite canvas id", true),
    serviceInteger(canvasRevision, "sprite canvas revision", true),
  );
  if (!replay)
    throw new RuntimeServiceError("backend_failure", "canvas-backed sprite revision is missing");
  return replay;
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
  if (measurement) {
    const lease = measurement.acquireImage(resourceId, props.placement.revision);
    measurement.track(
      lease.ready.then((value) => {
        measurement.assertCurrent();
        if (!active) return;
        naturalSize.value = { width: value.width, height: value.height };
        source.value = value.url;
        sourceIdentity.value = identity;
      }),
    );
    onCleanup(() => {
      active = false;
      lease.release();
    });
    return;
  }
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
  if (measurement) {
    const imageScale = store.effectivePreferences.imageScale;
    if (
      [width, height].some(
        (value) =>
          value != null &&
          (!Number.isFinite(value) || value * imageScale > HTML_MEASUREMENT_LIMITS.side),
      ) ||
      (width != null &&
        height != null &&
        width * height * imageScale * imageScale > HTML_MEASUREMENT_LIMITS.pixels)
    )
      throw new RuntimeServiceError(
        "resource_limit",
        "HTML media layout dimensions exceed the measurement budget",
      );
  }
  return { width, height };
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
  colorMatrix.value
    ? 1
    : props.placement.opacity?.denominator
      ? props.placement.opacity.numerator / props.placement.opacity.denominator
      : 1,
);
const scale = computed(() => store.effectivePreferences.imageScale);
const escapesConsoleRow = computed(() => props.placement.requested_y != null);
const positionedSlotHeight = computed(
  () => logicalPixels(props.placement.height) ?? store.gameTextStyle.fontSizePx,
);
const positionedSlotScale = computed(() => (escapesConsoleRow.value ? 1 : scale.value));
const directStyle = computed(() => ({
  width: dimensions.value.width ? `${dimensions.value.width * scale.value}px` : undefined,
  height: dimensions.value.height ? `${dimensions.value.height * scale.value}px` : undefined,
  top: verticalOffset(),
  left: horizontalOffset(),
  opacity: opacity.value,
  zIndex: props.placement.depth,
  transform: imageTransform.value,
  filter: colorFilter.value,
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
  left: horizontalOffset() ?? "0px",
  transform: verticallyFlipped.value ? "scaleY(-1)" : undefined,
  filter: colorFilter.value,
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
  left: horizontalOffset(),
  opacity: opacity.value,
  zIndex: props.placement.depth,
  transform: imageTransform.value,
  filter: colorFilter.value,
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

function horizontalOffset(): string | undefined {
  const value = props.placement.requested_x as PresentationLength | undefined;
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
  if (!measurement) hovered.value = true;
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
  <svg v-if="colorMatrix" class="media-color-filter" aria-hidden="true">
    <filter :id="colorFilterId" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" :values="colorMatrix" />
    </filter>
  </svg>
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
