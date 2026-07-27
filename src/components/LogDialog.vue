<script setup lang="ts">
import { computed, ref } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";

const props = defineProps<{ open: boolean; entries: any[] }>();
const emit = defineEmits<{ close: []; clear: [] }>();
const threshold = ref("info");
const ranks: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const visible = computed(() =>
  props.entries.filter((entry) => ranks[entry.level] >= ranks[threshold.value]),
);
const text = computed(() =>
  visible.value
    .map(
      (entry) => `${entry.timestamp.toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`,
    )
    .join("\n"),
);

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(text.value);
}

function download(): void {
  const url = URL.createObjectURL(new Blob([text.value], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rustyera-${new Date().toISOString().replaceAll(":", "")}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <DraggableDialog :open="open" title="Runtime / 前端日志" wide @close="emit('close')">
    <div class="log-toolbar">
      <label
        >最低等级
        <select v-model="threshold">
          <option>debug</option>
          <option>info</option>
          <option>warning</option>
          <option>error</option>
        </select></label
      >
      <button @click="copy">复制</button><button @click="download">导出</button
      ><button @click="emit('clear')">清空</button>
    </div>
    <ol class="log-list">
      <li v-for="(entry, index) in visible" :key="index" :class="entry.level">
        <time>{{ entry.timestamp.toLocaleTimeString() }}</time> {{ entry.message }}
      </li>
    </ol>
  </DraggableDialog>
</template>
