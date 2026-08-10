<script setup lang="ts">
import { computed } from "vue";

import type { FontAccessStatus } from "@/core/types";

const props = defineProps<{
  id: string;
  modelValue: string;
  fontFamilies: string[];
  status: FontAccessStatus;
  error: string;
  hostKind: "browser" | "tauri";
  disabled: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  requestFonts: [];
}>();

const statusId = computed(() => `${props.id}-font-access-status`);
const message = computed(() => {
  switch (props.status) {
    case "loading":
      return props.hostKind === "browser"
        ? "正在等待浏览器授权并读取系统字体…"
        : "正在读取系统字体…";
    case "ready":
      return props.fontFamilies.length > 0
        ? `可选择 ${props.fontFamilies.length} 个项目或系统字体。`
        : "字体访问已授权，但没有返回可用的系统字体。";
    case "unsupported":
      return "此浏览器无法读取系统字体列表，请直接输入字体名称。";
    case "denied":
      return "未获得系统字体访问授权，仍可直接输入字体名称。";
    case "error":
      return props.error
        ? `读取系统字体失败：${props.error}`
        : "读取系统字体失败，仍可直接输入字体名称。";
    default:
      return "尚未读取系统字体列表。";
  }
});
</script>

<template>
  <input
    :id="id"
    type="text"
    :value="modelValue"
    list="available-game-fonts"
    :aria-describedby="statusId"
    :disabled="disabled"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
  <div class="font-access-status" :data-state="status">
    <span :id="statusId" role="status" aria-live="polite">{{ message }}</span>
    <button
      v-if="['idle', 'denied', 'error'].includes(status)"
      type="button"
      :disabled="disabled"
      @click="emit('requestFonts')"
    >
      {{ status === "idle" ? "读取系统字体" : "重试" }}
    </button>
  </div>
</template>
