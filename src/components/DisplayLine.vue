<script setup lang="ts">
import { computed } from "vue";

import RunRenderer from "@/components/RunRenderer.vue";
import TextRunGroup from "@/components/TextRunGroup.vue";
import { collectTextRunGroup, type TextDisplayRun } from "@/components/textRunPresentation";
import { responsiveColumnGroupLayout } from "@/core/columnLayout";
import type { DisplayLine, DisplayRun } from "@/core/types";

const props = defineProps<{ line: DisplayLine; viewportColumns: number }>();

interface SingleRun {
  type: "run";
  key: number;
  run: DisplayRun;
}

interface TextGroup {
  type: "text_group";
  key: number;
  runs: TextDisplayRun[];
}

interface ColumnGroup {
  type: "column_group";
  key: number;
  cells: Extract<DisplayRun, { type: "column_cell" }>[];
  columnWidth: number;
  columns: number;
}

type DisplayFragment = SingleRun | TextGroup | ColumnGroup;

const fragments = computed<DisplayFragment[]>(() => {
  const result: DisplayFragment[] = [];
  for (let index = 0; index < props.line.runs.length;) {
    const run = props.line.runs[index];
    const textGroup = collectTextRunGroup(props.line.runs, index);
    if (textGroup) {
      result.push({ type: "text_group", key: index, runs: textGroup.runs });
      index = textGroup.nextIndex;
      continue;
    }
    if (run.type !== "column_cell") {
      result.push({ type: "run", key: index, run });
      index += 1;
      continue;
    }

    const start = index;
    const cells: ColumnGroup["cells"] = [];
    while (props.line.runs[index]?.type === "column_cell") {
      cells.push(props.line.runs[index] as ColumnGroup["cells"][number]);
      index += 1;
    }
    const layout = responsiveColumnGroupLayout(
      props.viewportColumns,
      cells.map((cell) => cell.preferred_columns),
    );
    result.push({ type: "column_group", key: start, cells, ...layout });
  }
  return result;
});
</script>

<template>
  <template v-for="fragment in fragments" :key="fragment.key">
    <TextRunGroup v-if="fragment.type === 'text_group'" :runs="fragment.runs" />
    <RunRenderer
      v-else-if="fragment.type === 'run'"
      :run="fragment.run"
      :viewport-columns="viewportColumns"
    />
    <span
      v-else
      class="column-group"
      :style="{
        gridTemplateColumns: `repeat(${fragment.columns}, ${fragment.columnWidth}ch)`,
      }"
    >
      <RunRenderer
        v-for="(cell, index) in fragment.cells"
        :key="index"
        :run="cell"
        :viewport-columns="viewportColumns"
      />
    </span>
  </template>
</template>
