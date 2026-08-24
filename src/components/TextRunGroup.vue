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
const presentedRuns = computed(() =>
  props.runs.map((run) => ({
    run,
    text: renderedText(run, store.replaceFullWidthSpaces),
    style: [textRunStyle(run, store.effectivePreferences), textLayoutStyle(run)],
  })),
);
</script>

<template>
  <span
    v-for="(presented, index) in presentedRuns"
    :key="index"
    :class="{ 'text-layout': presented.run.type === 'text_layout' }"
    :data-columns="presented.run.type === 'text_layout' ? presented.run.columns : undefined"
    :style="presented.style"
    >{{ presented.text }}</span
  >
</template>
