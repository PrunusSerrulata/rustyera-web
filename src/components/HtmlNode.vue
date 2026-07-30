<script setup lang="ts">
import { computed } from "vue";

import MediaImage from "@/components/MediaImage.vue";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "HtmlNode" });
const props = defineProps<{ node: any }>();
const store = useRuntimeStore();
const tags: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  paragraph: "p",
  no_break: "span",
  button: "button",
  non_button: "span",
  division: "div",
};
const tag = computed(() => tags[props.node.kind] ?? "span");
const imagePlacement = computed(() =>
  props.node.semantic?.type === "image"
    ? {
        resource_id: props.node.semantic.source,
        hover_resource_id: props.node.semantic.hover_source,
        mask_resource_id: props.node.semantic.mask_source,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        depth: 0,
        opacity: { numerator: 1, denominator: 1 },
        revision: 0,
        requested_width: props.node.semantic.width,
        requested_height: props.node.semantic.height,
        requested_y: props.node.semantic.y,
      }
    : null,
);
const spaceShapeStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "shape" || semantic.kind?.toLowerCase() !== "space") return null;
  const width = projectLength(semantic.parameters?.[0]);
  return width == null
    ? null
    : {
        width: `${Math.max(0, width)}px`,
        height: `${store.gameTextStyle.fontSizePx}px`,
      };
});
const lockedPositionStyle = computed(() => {
  const semantic = props.node.semantic;
  if (!["button", "non_button"].includes(semantic?.type) || semantic.position == null) return null;
  const position = Number(semantic.position);
  return Number.isFinite(position)
    ? { left: `${(position * store.gameTextStyle.fontSizePx) / 100}px` }
    : null;
});
const tooltipTitle = computed(() => {
  const semantic = props.node.semantic;
  return semantic?.type === "button" || semantic?.type === "non_button"
    ? semantic.title || undefined
    : undefined;
});

function activate(): void {
  const interaction = props.node.interaction;
  if (interaction?.enabled && store.canInteract)
    void store.activate({ epoch: interaction.epoch, id: interaction.id });
}

function projectLength(value: { unit?: string; value?: unknown } | undefined): number | undefined {
  if (!value) return undefined;
  const raw = Number(value.value);
  const result =
    value.unit === "pixels" || value.unit === "logical"
      ? value.unit === "logical"
        ? raw / 1000
        : raw
      : (raw * store.gameTextStyle.fontSizePx) / 100;
  return Number.isFinite(result) ? result : undefined;
}
</script>

<template>
  <template v-if="node.type === 'text'">{{ node.text }}</template>
  <br v-else-if="node.kind === 'break'" />
  <span
    v-else-if="spaceShapeStyle"
    class="html-node html-shape html-shape-space"
    :style="spaceShapeStyle"
  />
  <MediaImage v-else-if="imagePlacement" :placement="imagePlacement" />
  <component
    :is="tag"
    v-else
    :disabled="node.interaction && (!node.interaction.enabled || !store.canInteract)"
    :aria-description="tooltipTitle"
    class="html-node"
    :class="{ 'html-node-positioned': lockedPositionStyle }"
    :style="lockedPositionStyle"
    :data-era-tooltip="tooltipTitle"
    @click="activate"
  >
    <HtmlNode v-for="(child, index) in node.children ?? []" :key="index" :node="child" />
  </component>
</template>
