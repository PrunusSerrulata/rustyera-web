<script setup lang="ts">
import { computed } from "vue";

import {
  renderedText,
  textLayoutStyle,
  textRunStyle,
  type TextDisplayRun,
} from "@/components/textRunPresentation";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "TextRunGroup" });

const props = defineProps<{
  runs: TextDisplayRun[];
}>();

const store = useRuntimeStore();
interface PresentedTextRun {
  type: TextDisplayRun["type"];
  text: string;
  columns?: number;
  style: ReturnType<typeof textRunStyle>[];
  whitespaceStyle?: string;
}

const presentedRuns = computed(() => {
  const presented: PresentedTextRun[] = [];
  for (const run of props.runs) {
    const text = renderedText(run, store.replaceFullWidthSpaces);
    const baseStyle = textRunStyle(run, store.effectivePreferences);
    const columns = run.type === "text_layout" ? Math.max(0, Number(run.columns) || 0) : undefined;
    const whitespaceStyle =
      run.type === "text_layout" && /^ +$/u.test(text) ? JSON.stringify(baseStyle) : undefined;
    const previous = presented.at(-1);
    if (
      whitespaceStyle != null &&
      previous?.whitespaceStyle === whitespaceStyle &&
      previous.columns != null
    ) {
      previous.text += text;
      previous.columns += columns ?? 0;
      previous.style = [
        baseStyle,
        textLayoutStyle({ ...run, type: "text_layout", columns: previous.columns }) ?? {},
      ];
      continue;
    }
    presented.push({
      type: run.type,
      text,
      columns,
      style: [baseStyle, textLayoutStyle(run) ?? {}],
      whitespaceStyle,
    });
  }
  return presented;
});
</script>

<template>
  <span
    v-for="(presented, index) in presentedRuns"
    :key="index"
    :class="{ 'text-layout': presented.type === 'text_layout' }"
    :data-columns="presented.columns"
    :style="presented.style"
    >{{ presented.text }}</span
  >
</template>
