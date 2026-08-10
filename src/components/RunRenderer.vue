<script setup lang="ts">
import { computed } from "vue";

import HtmlNode from "@/components/HtmlNode.vue";
import MediaImage from "@/components/MediaImage.vue";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "RunRenderer" });
const props = defineProps<{ run: any }>();
const store = useRuntimeStore();
const textStyle = computed(() => {
  const style = props.run.style ?? {};
  const foreground = style.foreground;
  const background = style.background;
  return {
    color: foreground ? `var(--game-interaction-foreground, ${rgba(foreground)})` : undefined,
    backgroundColor: background ? rgba(background) : undefined,
    fontWeight: style.bold ? "bold" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration:
      [style.underline && "underline", style.strikeout && "line-through"]
        .filter(Boolean)
        .join(" ") || undefined,
    fontFamily: store.effectivePreferences.fontFamilyOverride
      ? "var(--game-font)"
      : style.font_family
        ? `${style.font_family}, var(--game-font)`
        : undefined,
    fontSize:
      store.effectivePreferences.fontSizeOverridePx != null
        ? "var(--game-size)"
        : style.font_millipixels
          ? `${Number(style.font_millipixels) / 1000}px`
          : undefined,
  };
});
const textLayoutStyle = computed(() =>
  props.run.type === "text_layout"
    ? {
        display: "inline-block",
        // The viewport reports columns from the active font's zero advance. Use the
        // same physical cell here so fonts whose half-width advance is not exactly
        // half an em cannot accumulate layout drift across a console row.
        width: `${Math.max(0, Number(props.run.columns) || 0)}ch`,
        verticalAlign: "top",
      }
    : undefined,
);
const renderedText = computed(() =>
  store.replaceFullWidthSpaces
    ? String(props.run.text ?? "").replaceAll("　", "  ")
    : props.run.text,
);

function rgba(color: any): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`;
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
    class="game-button"
    :disabled="!run.enabled || !store.canInteract"
    :aria-description="run.title || undefined"
    :data-era-tooltip="run.title || undefined"
    @click="store.activate(run.token)"
  >
    <RunRenderer v-for="(child, index) in run.runs" :key="index" :run="child" />
  </button>
  <template v-else-if="run.type === 'html_document'">
    <HtmlNode v-for="(node, index) in run.document.nodes" :key="index" :node="node" />
  </template>
  <MediaImage v-else-if="run.type === 'image'" :placement="run.placement" :alt="run.alt_text" />
  <span v-else-if="run.type === 'shape'" class="shape" :data-shape="run.shape.kind" />
  <span
    v-else-if="run.type === 'column_cell'"
    class="column-cell"
    :style="{ textAlign: run.alignment }"
  >
    <RunRenderer v-for="(child, index) in run.content" :key="index" :run="child" />
  </span>
  <span v-else-if="run.type === 'separator'" class="separator" :data-pattern="run.pattern" />
  <span v-else-if="run.type === 'space'" class="space" />
</template>
