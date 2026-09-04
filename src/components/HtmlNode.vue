<script setup lang="ts">
import { computed, inject } from "vue";

import { htmlMeasurementProjectionKey } from "@/components/htmlMeasurementProjection";
import { htmlMeasurementSegments } from "@/core/htmlMeasurement";
import { useSceneDepthRank } from "@/core/sceneStacking";

import MediaImage from "@/components/MediaImage.vue";
import { usePointerButton } from "@/components/usePointerButton";
import { htmlPointerButtonValue } from "@/platform/pointerObservation";
import {
  htmlTextSegments,
  lastRenderableTextNodeIndex,
  nextRenderableTextCharacter,
  type HtmlTextSegment,
} from "@/core/htmlBoxLayout";
import {
  projectPresentationLength,
  projectRectangleShape,
  projectSpaceShape,
} from "@/core/shapeProjection";
import type { PresentationLength } from "@/core/types";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "HtmlNode" });
const props = defineProps<{
  node: any;
  alignTrailingBoxEdge?: boolean;
  trailingBoxFill?: { character: string; columns: number };
  followingTextCharacter?: string;
  measurementPath?: number[];
}>();
const measurement = inject(htmlMeasurementProjectionKey, undefined);
const children = computed<any[]>(() => props.node.children ?? []);
const store = measurement?.state ?? useRuntimeStore();
const sceneDepthRank = useSceneDepthRank();
const pointerButton = measurement
  ? undefined
  : usePointerButton(() => {
      const interaction = props.node.interaction;
      if (props.node.kind !== "button" || !interaction) return undefined;
      const value = htmlPointerButtonValue(interaction);
      return value == null ? undefined : { epoch: interaction.epoch, value };
    });
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
        revision: htmlImageRevision(props.node.semantic.source),
        requested_width: props.node.semantic.width,
        requested_height: props.node.semantic.height,
        requested_y: props.node.semantic.y,
        requested_x: props.node.semantic.x,
        display: props.node.semantic.display,
        color_matrix: props.node.semantic.color_matrix,
      }
    : null,
);

function htmlImageRevision(name: unknown): unknown {
  const key = String(name ?? "").toUpperCase();
  const matches = (store.presentation.resources.sprites ?? []).filter(
    (sprite: any) => String(sprite?.name ?? "").toUpperCase() === key,
  );
  if (matches.length > 1) throw new Error("HTML image sprite revision is ambiguous");
  return matches[0]?.revision ?? 0;
}
const spaceShapeStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "shape" || semantic.kind?.toLowerCase() !== "space") return null;
  const shape = projectSpaceShape(semantic.parameters?.[0], store.gameTextStyle.fontSizePx);
  if (shape == null) return null;
  return {
    ...pixelStyle(shape),
    // CSS rejects negative widths, while Snake Emuera keeps them as signed cursor
    // advances. A zero-width inline box with a negative leading margin has the
    // same effect on the following image without inventing a painted rectangle.
    marginLeft: shape.advance < 0 ? `${shape.advance}px` : undefined,
  };
});
const rectangleShapeStyle = computed(() => {
  const semantic = props.node.semantic;
  if (semantic?.type !== "shape" || semantic.kind?.toLowerCase() !== "rect") return null;
  const shape = projectRectangleShape(semantic.parameters ?? [], store.gameTextStyle.fontSizePx);
  if (shape == null) return null;
  return {
    slot: pixelStyle(shape.slot),
    visual: {
      ...pixelStyle(shape.visual),
      left: `${shape.visual.left}px`,
      top: `${shape.visual.top}px`,
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
    fontSize:
      semantic.size_millipixels == null
        ? undefined
        : `${Number(semantic.size_millipixels) / 1000}px`,
    verticalAlign: semantic.vertical_alignment ?? undefined,
    textRendering: semantic.render_intent?.renderer === "skia" ? "optimizeLegibility" : undefined,
  };
});
const layeredDivisionStyle = computed(() => {
  const semantic = props.node.semantic;
  const display = semantic?.display ?? (semantic?.relative === true ? "relative" : undefined);
  if (semantic?.type !== "division" || display == null) return null;
  const width = projectLength(semantic.width);
  const height = projectLength(semantic.height);
  if (width == null) return null;
  const boxModel = projectBoxModel(semantic.box_model);
  if (boxModel == null) return null;
  const [marginTop, marginRight, marginBottom, marginLeft] = boxModel.margin;
  return {
    left: `${(projectLength(semantic.x) ?? 0) + marginLeft}px`,
    top: `${(projectLength(semantic.y) ?? 0) + marginTop}px`,
    width: `${Math.max(0, Math.abs(width) - marginLeft - marginRight)}px`,
    height:
      height == null ? undefined : `${Math.max(0, Math.abs(height) - marginTop - marginBottom)}px`,
    zIndex: sceneDepthRank(semantic.depth),
    backgroundColor: semantic.color == null ? undefined : htmlColor(semantic.color),
    ...boxModel.style,
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
  if (interaction && store.interactionEnabled(interaction) && store.canInteract)
    void store.activate({ epoch: interaction.epoch, id: interaction.id });
}

function projectLength(value: PresentationLength | undefined): number | undefined {
  return projectPresentationLength(value, store.gameTextStyle.fontSizePx);
}

function pixelStyle(box: { width: number; height: number }): { width: string; height: string } {
  return { width: `${box.width}px`, height: `${box.height}px` };
}

function htmlColor(value: unknown): string {
  const color = Number(value);
  if (!Number.isFinite(color)) return "rgb(0, 0, 0)";
  return `rgb(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff})`;
}

function projectBoxModel(value: any): {
  margin: [number, number, number, number];
  style: Record<string, string | undefined>;
} | null {
  const lengths = (part: unknown): number[] | undefined | null => {
    if (part == null) return undefined;
    if (!Array.isArray(part) || part.length !== 4) return null;
    const projected = part.map(projectLength);
    return projected.every((item) => item != null) ? (projected as number[]) : null;
  };
  const margin = lengths(value?.margin);
  const borderWidth = lengths(value?.border);
  const borderRadius = lengths(value?.radius);
  const padding = lengths(value?.padding);
  if ([margin, borderWidth, borderRadius, padding].includes(null)) return null;
  let borderColor: string | undefined;
  if (value?.border_colors != null) {
    if (!Array.isArray(value.border_colors) || value.border_colors.length !== 4) return null;
    borderColor = value.border_colors.map(htmlColor).join(" ");
  }
  return {
    margin: (margin ?? [0, 0, 0, 0]) as [number, number, number, number],
    style: {
      borderStyle: borderWidth == null ? undefined : "solid",
      borderWidth: borderWidth?.map((item) => `${item}px`).join(" "),
      borderColor,
      borderRadius: borderRadius?.map((item) => `${item}px`).join(" "),
      padding: padding?.map((item) => `${item}px`).join(" "),
    },
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

function textSegments(value: unknown): HtmlTextSegment[] {
  return htmlTextSegments(
    value,
    store.replaceFullWidthSpaces,
    props.alignTrailingBoxEdge === true,
    props.trailingBoxFill,
    props.followingTextCharacter,
  );
}

const measurementSegments = computed(() =>
  measurement && props.node.type === "text"
    ? htmlMeasurementSegments(props.node.text, store.replaceFullWidthSpaces)
    : [],
);

const measurementPath = computed(() => props.measurementPath?.join("."));

const trailingTextChildIndex = computed(() =>
  lastRenderableTextNodeIndex(props.node.children ?? []),
);
</script>

<template>
  <span
    v-if="measurement && node.type === 'text'"
    :data-html-text-path="measurementPath"
    style="display: contents"
  >
    <span
      v-for="(segment, index) in measurementSegments"
      :key="index"
      :data-html-segment="index"
      :class="{
        'html-ascii-space': segment.kind === 'space',
        'html-box-cell': segment.kind === 'box',
      }"
      :data-continuation="segment.continuation"
      :style="{ width: segment.width }"
      >{{ segment.text }}</span
    >
  </span>
  <template v-else-if="node.type === 'text'">
    <template v-for="(segment, index) in textSegments(node.text)" :key="index">
      <span
        v-if="segment.kind === 'space'"
        class="html-ascii-space"
        :style="{ width: segment.width }"
        >{{ segment.text }}</span
      >
      <span
        v-else-if="segment.kind === 'box'"
        class="html-box-cell"
        :data-continuation="segment.continuation"
        :style="{ width: segment.width }"
        >{{ segment.text }}</span
      >
      <span
        v-else-if="segment.kind === 'fill'"
        class="html-box-fill"
        :style="{ width: segment.width }"
        >{{ segment.text }}</span
      >
      <span
        v-else-if="segment.kind === 'edge'"
        class="html-box-cell html-trailing-box-edge"
        :style="{ width: segment.width }"
        >{{ segment.text }}</span
      >
      <template v-else>{{ segment.text }}</template>
    </template>
  </template>
  <br
    v-else-if="node.kind === 'break'"
    :data-html-break-path="measurement ? measurementPath : undefined"
  />
  <span
    v-else-if="spaceShapeStyle"
    class="html-node html-shape html-shape-space"
    :style="spaceShapeStyle"
    :data-html-atomic-path="measurement ? measurementPath : undefined"
  />
  <span
    v-else-if="rectangleShapeStyle"
    class="html-node html-shape html-shape-rect"
    :style="rectangleShapeStyle.slot"
    :data-html-atomic-path="measurement ? measurementPath : undefined"
  >
    <span class="html-shape-rect-visual" :style="rectangleShapeStyle.visual" />
  </span>
  <span
    v-else-if="measurement && imagePlacement"
    :data-html-atomic-path="measurementPath"
    style="display: contents"
  >
    <MediaImage :placement="imagePlacement" />
  </span>
  <MediaImage v-else-if="imagePlacement" :placement="imagePlacement" />
  <span
    v-else-if="layeredDivisionStyle"
    class="html-node html-division"
    :data-html-atomic-path="measurement ? measurementPath : undefined"
  >
    <span class="html-division-visual" :style="layeredDivisionStyle">
      <HtmlNode
        v-for="(child, index) in children"
        :key="index"
        :node="child"
        :measurement-path="measurement ? [...(props.measurementPath ?? []), index] : undefined"
      />
    </span>
  </span>
  <component
    :is="tag"
    v-else
    :ref="pointerButton"
    :disabled="
      node.interaction && (!store.interactionEnabled(node.interaction) || !store.canInteract)
    "
    :aria-description="tooltipTitle"
    class="html-node"
    :class="{
      'html-font': fontStyle,
      'html-node-positioned': lockedPositionStyle,
      'html-positioned-media': lockedPositionStyle && hasPositionedMedia,
    }"
    :style="[fontStyle, lockedPositionStyle]"
    :data-era-tooltip="tooltipTitle"
    :data-html-renderer="node.semantic?.render_intent?.renderer"
    :data-html-edging="node.semantic?.render_intent?.edging"
    :data-html-hinting="node.semantic?.render_intent?.hinting"
    @click="activate"
  >
    <HtmlNode
      v-for="(child, index) in children"
      :key="index"
      :node="child"
      :measurement-path="measurement ? [...(props.measurementPath ?? []), index] : undefined"
      :align-trailing-box-edge="alignTrailingBoxEdge && index === trailingTextChildIndex"
      :trailing-box-fill="
        alignTrailingBoxEdge && index === trailingTextChildIndex ? trailingBoxFill : undefined
      "
      :following-text-character="
        nextRenderableTextCharacter(node.children ?? [], index, followingTextCharacter)
      "
    />
  </component>
</template>
