<script setup lang="ts">
import { computed, provide } from "vue";

import HtmlNode from "@/components/HtmlNode.vue";
import {
  htmlMeasurementProjectionKey,
  type HtmlMeasurementProjection,
} from "@/components/htmlMeasurementProjection";
import { textRunStyle } from "@/components/textRunPresentation";
import type { CanonicalHtmlDocument, HtmlQueryStyle } from "@/core/htmlMeasurement";

const props = defineProps<{
  document: CanonicalHtmlDocument;
  style: HtmlQueryStyle;
  projection: HtmlMeasurementProjection;
  documentMode: boolean;
}>();
provide(htmlMeasurementProjectionKey, props.projection);
const textStyle = computed(() =>
  textRunStyle(
    { type: "text", text: "", style: props.style.base },
    props.projection.state.effectivePreferences,
  ),
);
</script>

<template>
  <div
    class="game-line html-measurement-line"
    :style="[
      textStyle,
      {
        width: documentMode ? '100%' : 'max-content',
        minHeight: '0',
        minWidth: '0',
        maxWidth: 'none',
        display: 'block',
        margin: '0',
        padding: '0',
        border: '0',
        whiteSpace: documentMode ? 'pre-wrap' : 'pre',
        contain: 'none',
        fontWeight: style.base.bold ? 'bold' : 'normal',
        fontStyle: style.base.italic ? 'italic' : 'normal',
        textDecoration:
          [style.base.underline && 'underline', style.base.strikeout && 'line-through']
            .filter(Boolean)
            .join(' ') || 'none',
      },
    ]"
    data-html-measurement-line
  >
    <HtmlNode
      v-for="(node, index) in document.nodes"
      :key="index"
      :node="node"
      :measurement-path="[index]"
    />
  </div>
</template>
