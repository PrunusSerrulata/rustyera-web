<script setup lang="ts">
import { computed } from "vue";

import HtmlNode from "@/components/HtmlNode.vue";
import { usePointerButton } from "@/components/usePointerButton";
import { pointerButtonValue } from "@/platform/pointerObservation";
import MediaImage from "@/components/MediaImage.vue";
import TextRunGroup from "@/components/TextRunGroup.vue";
import {
  collectTextRunGroup,
  renderedText as presentText,
  textLayoutStyle as layoutText,
  textRunStyle as styleText,
  type TextDisplayRun,
} from "@/components/textRunPresentation";
import { projectRectangleShape, projectSpaceShape } from "@/core/shapeProjection";
import { lastRenderableTextNodeIndex, nextRenderableTextCharacter } from "@/core/htmlBoxLayout";
import type { DisplayRun } from "@/core/types";
import { plainRun } from "@/core/presentation";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "RunRenderer" });
const props = defineProps<{
  run: any;
  viewportColumns?: number;
  alignTrailingBoxEdge?: boolean;
  trailingBoxFill?: { character: string; columns: number };
}>();
const store = useRuntimeStore();
const pointerButton = usePointerButton(() => {
  if (props.run.type !== "button") return undefined;
  const value = pointerButtonValue(props.run.value);
  return value == null ? undefined : { epoch: props.run.token.epoch, value };
});

type NestedFragment =
  | { type: "text_group"; key: number; runs: TextDisplayRun[] }
  | { type: "run"; key: number; run: DisplayRun };

const nestedFragments = computed<NestedFragment[]>(() => {
  const runs: DisplayRun[] =
    props.run.type === "button"
      ? props.run.runs
      : props.run.type === "column_cell"
        ? props.run.content
        : [];
  const fragments: NestedFragment[] = [];
  for (let index = 0; index < runs.length;) {
    const textGroup = collectTextRunGroup(runs, index);
    if (textGroup) {
      fragments.push({ type: "text_group", key: index, runs: textGroup.runs });
      index = textGroup.nextIndex;
    } else {
      fragments.push({ type: "run", key: index, run: runs[index] });
      index += 1;
    }
  }
  return fragments;
});

const textStyle = computed(() => {
  return styleText(props.run, store.effectivePreferences);
});
const textLayoutStyle = computed(() => layoutText(props.run));
const renderedText = computed(() => presentText(props.run, store.replaceFullWidthSpaces));
const separatorColumns = computed(() => {
  const columns = Number(props.viewportColumns);
  return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
});
// Generate enough complete pattern units for every viewport column, then let
// the `ch`-sized element clip wide glyphs and multi-character patterns.
const separatorText = computed(() =>
  props.run.type === "separator"
    ? String(props.run.pattern ?? "").repeat(separatorColumns.value)
    : "",
);
const trailingHtmlNodeIndex = computed(() =>
  props.run.type === "html_document"
    ? lastRenderableTextNodeIndex(props.run.document.nodes ?? [])
    : -1,
);
const directRectangleShapeStyle = computed(() => {
  const run = props.run;
  if (run.type !== "shape" || String(run.shape.kind).toLowerCase() !== "rect") return null;
  const shape = projectRectangleShape(run.shape.parameters ?? [], store.gameTextStyle.fontSizePx);
  if (shape == null) return null;
  return {
    slot: pixelStyle(shape.slot),
    visual: {
      ...pixelStyle(shape.visual),
      left: `${shape.visual.left}px`,
      top: `${shape.visual.top}px`,
      backgroundColor: `var(--game-shape-foreground, ${
        run.shape.foreground == null ? "currentColor" : rgba(run.shape.foreground)
      })`,
      "--game-button-shape-foreground":
        run.shape.background == null ? "var(--game-focus)" : rgba(run.shape.background),
    },
  };
});
const directSpaceStyle = computed(() => {
  if (props.run.type !== "space") return undefined;
  const shape = projectSpaceShape(props.run.width, store.gameTextStyle.fontSizePx);
  return shape == null ? undefined : pixelStyle(shape);
});

function rgba(color: any): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`;
}

function pixelStyle(box: { width: number; height: number }): { width: string; height: string } {
  return { width: `${box.width}px`, height: `${box.height}px` };
}
</script>

<template>
  <span
    v-if="run.type === 'text' || run.type === 'text_layout'"
    :class="{ 'text-layout': run.type === 'text_layout' }"
    :data-columns="run.type === 'text_layout' ? run.columns : undefined"
    :style="[textStyle, textLayoutStyle]"
    >{{ renderedText }}</span
  >
  <button
    v-else-if="run.type === 'button'"
    :ref="pointerButton"
    class="game-button"
    :disabled="!store.interactionEnabled(run) || !store.canInteract"
    :aria-label="plainRun(run) || undefined"
    :aria-description="run.title || undefined"
    :data-era-tooltip="run.title || undefined"
    @click="store.activate(run.token)"
  >
    <template v-for="fragment in nestedFragments" :key="fragment.key">
      <TextRunGroup v-if="fragment.type === 'text_group'" :runs="fragment.runs" />
      <RunRenderer v-else :run="fragment.run" :viewport-columns="viewportColumns" />
    </template>
  </button>
  <template v-else-if="run.type === 'html_document'">
    <HtmlNode
      v-for="(node, index) in run.document.nodes"
      :key="index"
      :node="node"
      :align-trailing-box-edge="alignTrailingBoxEdge && index === trailingHtmlNodeIndex"
      :trailing-box-fill="
        alignTrailingBoxEdge && index === trailingHtmlNodeIndex ? trailingBoxFill : undefined
      "
      :following-text-character="nextRenderableTextCharacter(run.document.nodes, index)"
    />
  </template>
  <MediaImage v-else-if="run.type === 'image'" :placement="run.placement" :alt="run.alt_text" />
  <span
    v-else-if="run.type === 'shape' && directRectangleShapeStyle"
    class="shape shape-rect"
    :data-shape="run.shape.kind"
    :style="directRectangleShapeStyle.slot"
  >
    <span class="shape-rect-visual" :style="directRectangleShapeStyle.visual" />
  </span>
  <span
    v-else-if="run.type === 'shape'"
    class="shape shape-unsupported"
    :data-shape="run.shape.kind"
  />
  <span
    v-else-if="run.type === 'column_cell'"
    class="column-cell"
    :style="{ textAlign: run.alignment }"
  >
    <template v-for="fragment in nestedFragments" :key="fragment.key">
      <TextRunGroup v-if="fragment.type === 'text_group'" :runs="fragment.runs" />
      <RunRenderer v-else :run="fragment.run" :viewport-columns="viewportColumns" />
    </template>
  </span>
  <span
    v-else-if="run.type === 'separator'"
    class="separator"
    :data-pattern="run.pattern"
    :style="[textStyle, { width: `${separatorColumns}ch` }]"
    >{{ separatorText }}</span
  >
  <span v-else-if="run.type === 'space'" class="space" :style="directSpaceStyle" />
</template>
