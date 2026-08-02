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
        // Era HTML images still occupy one configured console row. Their requested
        // height controls the overflowing visual, not the row reserved in history.
        height: Number(store.presentation.settings?.line_height ?? 0),
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
const positionedHeight = computed(() => positionedMediaHeight(props.node));
const lockedPositionStyle = computed(() => {
  const semantic = props.node.semantic;
  if (!["button", "non_button"].includes(semantic?.type) || semantic.position == null) return null;
  const position = Number(semantic.position);
  if (!Number.isFinite(position)) return null;
  const height = positionedHeight.value;
  return {
    left: `${(position * store.gameTextStyle.fontSizePx) / 100}px`,
    height: height == null ? undefined : `${height}px`,
  };
});
const hasPositionedMedia = computed(() => positionedHeight.value != null);
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

function positionedMediaHeight(node: any): number | undefined {
  if (!(node?.children ?? []).some((child: any) => child?.kind === "break")) return undefined;
  let found = false;
  let measurable = true;
  let bottom = 0;
  const visit = (child: any): void => {
    if (child?.semantic?.type === "image") {
      const projectedHeight = projectLength(child.semantic.height);
      const projectedY = child.semantic.y == null ? 0 : projectLength(child.semantic.y);
      if (projectedHeight == null || projectedHeight === 0 || projectedY == null) {
        measurable = false;
        return;
      }
      found = true;
      bottom = Math.max(bottom, projectedY + Math.abs(projectedHeight));
    }
    for (const nested of child?.children ?? []) visit(nested);
  };
  for (const child of node?.children ?? []) visit(child);
  return found && measurable
    ? Math.max(store.gameLineHeightPx, bottom * store.effectivePreferences.imageScale)
    : undefined;
}

function textSegments(value: unknown): Array<{ text: string; space: boolean; width?: string }> {
  return String(value ?? "")
    .split(/( +)/)
    .filter(Boolean)
    .map((text) => ({
      text,
      space: text[0] === " ",
      width:
        text[0] === " " ? `${(text.length * store.gameTextStyle.fontSizePx) / 2}px` : undefined,
    }));
}
</script>

<template>
  <template v-if="node.type === 'text'">
    <template v-for="(segment, index) in textSegments(node.text)" :key="index">
      <span v-if="segment.space" class="html-ascii-space" :style="{ width: segment.width }">{{
        segment.text
      }}</span>
      <template v-else>{{ segment.text }}</template>
    </template>
  </template>
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
    :class="{
      'html-node-positioned': lockedPositionStyle,
      'html-positioned-media': lockedPositionStyle && hasPositionedMedia,
    }"
    :style="lockedPositionStyle"
    :data-era-tooltip="tooltipTitle"
    @click="activate"
  >
    <HtmlNode v-for="(child, index) in node.children ?? []" :key="index" :node="child" />
  </component>
</template>
