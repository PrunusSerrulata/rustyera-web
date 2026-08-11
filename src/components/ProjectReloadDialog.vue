<script setup lang="ts">
import { ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";

const props = defineProps<{
  mode: "folder" | "script" | null;
  targets: string[];
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; confirm: [target: string] }>();
const selected = ref("");

watch(
  () => [props.mode, props.targets] as const,
  ([mode]) => {
    if (mode && !props.targets.includes(selected.value)) selected.value = props.targets[0] ?? "";
  },
  { immediate: true, deep: true },
);

function submit(): void {
  if (selected.value) emit("confirm", selected.value);
}
</script>

<template>
  <DraggableDialog
    :open="mode != null"
    :title="mode === 'folder' ? '重新加载脚本文件夹' : '重新加载单个脚本'"
    :close-disabled="busy"
    return-focus="#menu-file"
    @close="emit('close')"
  >
    <form class="project-reload-form" @submit.prevent="submit">
      <p>
        {{ mode === "folder" ? "选择当前项目中的脚本文件夹。" : "选择当前项目中的脚本文件。" }}
        重新加载会保留兼容的游戏状态和当前输入等待。
      </p>
      <label class="project-reload-field">
        <span>{{ mode === "folder" ? "脚本文件夹" : "脚本文件" }}</span>
        <select v-model="selected" :disabled="busy || !targets.length">
          <option v-for="target in targets" :key="target" :value="target">{{ target }}</option>
        </select>
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="busy || !selected">
          {{ busy ? "正在读取脚本列表…" : "重新加载" }}
        </button>
      </footer>
    </form>
  </DraggableDialog>
</template>
