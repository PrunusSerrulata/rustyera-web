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
  font: "span",
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
const rectangleShapeStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "shape" || semantic.kind?.toLowerCase() !== "rect") return null;
  const parameters = semantic.parameters ?? [];
  let x: number | undefined = 0;
  let y: number | undefined = 0;
  let width: number | undefined;
  let height: number | undefined = store.gameTextStyle.fontSizePx;
  if (parameters.length === 1) {
    width = projectLength(parameters[0]);
  } else if (parameters.length === 4) {
    [x, y, width, height] = parameters.map(projectLength);
  } else {
    return null;
  }
  if (
    x == null ||
    y == null ||
    width == null ||
    height == null ||
    x < 0 ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const top = Math.min(0, y);
  const bottom = Math.max(store.gameTextStyle.fontSizePx, y + height);
  return {
    slot: {
      width: `${x + width}px`,
      height: `${bottom - top}px`,
    },
    visual: {
      left: `${x}px`,
      top: `${y - top}px`,
      width: `${width}px`,
      height: `${height}px`,
      backgroundColor: `var(--game-shape-foreground, ${
        semantic.color == null ? "currentColor" : htmlColor(semantic.color)
      })`,
      "--game-button-shape-foreground":
        semantic.button_color == null ? "var(--game-focus)" : htmlColor(semantic.button_color),
    },
  };
});
const fontStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "font") return null;
  return {
    color: `var(--game-interaction-foreground, ${
      semantic.color == null ? "inherit" : htmlColor(semantic.color)
    })`,
    "--game-button-foreground":
      semantic.button_color == null ? "var(--game-focus)" : htmlColor(semantic.button_color),
    fontFamily:
      store.effectivePreferences.fontFamilyOverride || !semantic.face
        ? undefined
        : `${semantic.face}, var(--game-font)`,
  };
});
const layeredDivisionStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "division" || semantic.relative !== true) return null;
  const width = projectLength(semantic.width);
  const height = projectLength(semantic.height);
  if (width == null || height == null) return null;
  const boxModel = projectBoxModel(semantic.box_model);
  if (boxModel == null) return null;
  const depth = Number(semantic.depth);
  return {
    left: `${projectLength(semantic.x) ?? 0}px`,
    top: `${projectLength(semantic.y) ?? 0}px`,
    width: `${Math.abs(width)}px`,
    height: `${Math.abs(height)}px`,
    zIndex: Number.isFinite(depth) ? depth : undefined,
    backgroundColor: semantic.color == null ? undefined : htmlColor(semantic.color),
    ...boxModel,
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

function htmlColor(value: unknown): string {
  const color = Number(value);
  if (!Number.isFinite(color)) return "rgb(0, 0, 0)";
  return `rgb(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff})`;
}

function projectBoxModel(value: any): Record<string, string | undefined> | null {
  if (!value) return {};
  // Era's division margin is part of the declared rectangle: it offsets the
  // content and reduces the available size. A CSS margin on an absolutely
  // positioned visual would only move it, so keep those divisions on the
  // ordinary HTML path until that geometry can be projected faithfully.
  if (value.margin != null) return null;
  const lengths = (part: unknown): string | undefined | null => {
    if (part == null) return undefined;
    if (!Array.isArray(part) || part.length !== 4) return null;
    const projected = part.map(projectLength);
    return projected.every((item) => item != null)
      ? projected.map((item) => `${item}px`).join(" ")
      : null;
  };
  const borderWidth = lengths(value.border);
  const borderRadius = lengths(value.radius);
  const padding = lengths(value.padding);
  if ([borderWidth, borderRadius, padding].includes(null)) return null;
  let borderColor: string | undefined;
  if (value.border_colors != null) {
    if (!Array.isArray(value.border_colors) || value.border_colors.length !== 4) return null;
    borderColor = value.border_colors.map(htmlColor).join(" ");
  }
  return {
    borderStyle: borderWidth == null ? undefined : "solid",
    borderWidth: borderWidth ?? undefined,
    borderColor,
    borderRadius: borderRadius ?? undefined,
    padding: padding ?? undefined,
  };
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
  const text = String(value ?? "");
  return (store.replaceFullWidthSpaces ? text.replaceAll("　", "  ") : text)
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
  <span
    v-else-if="rectangleShapeStyle"
    class="html-node html-shape html-shape-rect"
    :style="rectangleShapeStyle.slot"
  >
    <span class="html-shape-rect-visual" :style="rectangleShapeStyle.visual" />
  </span>
  <MediaImage v-else-if="imagePlacement" :placement="imagePlacement" />
  <span v-else-if="layeredDivisionStyle" class="html-node html-division">
    <span class="html-division-visual" :style="layeredDivisionStyle">
      <HtmlNode v-for="(child, index) in node.children ?? []" :key="index" :node="child" />
    </span>
  </span>
  <component
    :is="tag"
    v-else
    :disabled="node.interaction && (!node.interaction.enabled || !store.canInteract)"
    :aria-description="tooltipTitle"
    class="html-node"
    :class="{
      'html-font': fontStyle,
      'html-node-positioned': lockedPositionStyle,
      'html-positioned-media': lockedPositionStyle && hasPositionedMedia,
    }"
    :style="[fontStyle, lockedPositionStyle]"
    :data-era-tooltip="tooltipTitle"
    @click="activate"
  >
    <HtmlNode v-for="(child, index) in node.children ?? []" :key="index" :node="child" />
  </component>
</template>
