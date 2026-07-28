<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { formatLogEntry, formatLogTime, logLevelLabel } from "@/core/log";

const props = defineProps<{ open: boolean; entries: any[] }>();
const emit = defineEmits<{ close: []; clear: [] }>();
const threshold = ref("info");
const list = ref<HTMLOListElement>();
const ranks: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const visible = computed(() =>
  props.entries.filter((entry) => ranks[entry.level] >= ranks[threshold.value]),
);
const text = computed(() =>
  visible.value.length ? `${visible.value.map((entry) => formatLogEntry(entry)).join("\n")}\n` : "",
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    if (list.value) list.value.scrollTop = list.value.scrollHeight;
  },
  { immediate: true },
);

async function copy(): Promise<void> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text.value);
      return;
    }
  } catch {
    // Sandboxed WebViews can expose Clipboard but reject it without a user permission grant.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text.value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
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
      <button type="button" @click="copy">复制</button
      ><button type="button" @click="download">导出</button
      ><button type="button" @click="emit('clear')">清空</button>
    </div>
    <ol ref="list" class="log-list">
      <li v-for="(entry, index) in visible" :key="index" :class="entry.level">
        <span class="log-bracket">[</span><time>{{ formatLogTime(entry.timestamp) }}</time
        ><span class="log-bracket">] </span
        ><strong class="log-level">{{ logLevelLabel(entry.level) }}</strong
        ><span class="log-message">{{ ` ${entry.message}` }}</span>
      </li>
    </ol>
  </DraggableDialog>
</template>
