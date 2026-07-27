<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";

import CanvasReplay from "@/components/CanvasReplay.vue";
import { resourceUrl } from "@/core/resources";
import { platformBridge } from "@/platform";
import { useRuntimeStore } from "@/stores/runtime";

const props = defineProps<{ placement: any; alt?: string }>();
const store = useRuntimeStore();
const source = ref("");
const hovered = ref(false);
const sprite = computed(() =>
  store.presentation.resources.sprites?.find(
    (item: any) => item.name === props.placement.resource_id,
  ),
);
const canvasReplay = computed(() => {
  const canvasId = sprite.value?.canvas_id;
  return canvasId == null
    ? undefined
    : store.presentation.resources.canvases?.find((item: any) => item.canvas_id === canvasId);
});

watchEffect(async () => {
  let id =
    hovered.value && props.placement.hover_resource_id
      ? props.placement.hover_resource_id
      : props.placement.resource_id;
  const frame = sprite.value?.frames?.[0];
  if (frame?.resource_id) id = frame.resource_id;
  if (!canvasReplay.value)
    source.value = await resourceUrl(platformBridge(), id, props.placement.revision);
});

const style = computed(() => {
  const scale = store.effectivePreferences.imageScale;
  const opacity = props.placement.opacity?.denominator
    ? props.placement.opacity.numerator / props.placement.opacity.denominator
    : 1;
  return {
    width: props.placement.width ? `${(props.placement.width / 1000) * scale}px` : undefined,
    height: props.placement.height ? `${(props.placement.height / 1000) * scale}px` : undefined,
    opacity,
    zIndex: props.placement.depth,
  };
});
</script>

<template>
  <CanvasReplay
    v-if="canvasReplay"
    :replay="canvasReplay"
    :scale="store.effectivePreferences.imageScale"
  />
  <img
    v-else
    class="media-image"
    :src="source"
    :alt="alt ?? ''"
    :style="style"
    draggable="false"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  />
</template>
