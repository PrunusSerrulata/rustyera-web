<script setup lang="ts">
import { computed, ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import type { TraditionalSaveSlot } from "@/core/types";

const props = defineProps<{
  open: boolean;
  mode: "export" | "import" | null;
  slots: TraditionalSaveSlot[];
  importName: string;
  busy: boolean;
  error: string;
  overwriteSlot: number | null;
}>();
const emit = defineEmits<{
  close: [];
  pick: [];
  confirm: [slot: number];
  cancelOverwrite: [];
  confirmOverwrite: [];
}>();
const selectedSlot = ref<number | null>(null);
const availableSlots = computed(() =>
  props.mode === "export" ? props.slots.filter((slot) => slot.occupied) : props.slots,
);

watch(
  () => [props.open, props.mode, props.slots] as const,
  ([open]) => {
    if (!open) return;
    if (!availableSlots.value.some((entry) => entry.slot === selectedSlot.value)) {
      selectedSlot.value = availableSlots.value[0]?.slot ?? null;
    }
  },
  { immediate: true, deep: true },
);

function slotName(slot: number): string {
  return slot.toString().padStart(2, "0");
}

function submit(): void {
  if (selectedSlot.value != null) emit("confirm", selectedSlot.value);
}
</script>

<template>
  <DraggableDialog
    :open="open"
    :title="mode === 'export' ? '导出存档' : '导入存档'"
    @close="emit('close')"
  >
    <template v-if="overwriteSlot != null">
      <p>槽位 {{ slotName(overwriteSlot) }} 已有存档。</p>
      <p>确认要用所选文件覆盖这个存档吗？</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="emit('cancelOverwrite')">返回</button>
        <button type="button" class="danger" :disabled="busy" @click="emit('confirmOverwrite')">
          {{ busy ? "正在导入…" : "确认覆盖" }}
        </button>
      </footer>
    </template>
    <form v-else class="traditional-save-form" @submit.prevent="submit">
      <p v-if="mode === 'export'">请选择一个非空存档槽位，存档将通过浏览器下载。</p>
      <template v-else>
        <p>请选择一个 .sav 存档文件及目标槽位。</p>
        <div class="save-file-picker">
          <button type="button" :disabled="busy" @click="emit('pick')">选择 .sav 文件…</button>
          <span :title="importName">{{ importName || "尚未选择文件" }}</span>
        </div>
      </template>
      <label class="save-slot-field">
        <span>存档槽位</span>
        <select v-model.number="selectedSlot" :disabled="busy || !availableSlots.length">
          <option v-for="entry in availableSlots" :key="entry.slot" :value="entry.slot">
            槽位 {{ slotName(entry.slot) }}{{ entry.occupied ? "（已有存档）" : "（空）" }}
          </option>
        </select>
      </label>
      <p v-if="mode === 'export' && !busy && !availableSlots.length" class="form-hint">
        当前项目没有可导出的存档。
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button
          type="submit"
          class="primary"
          :disabled="busy || selectedSlot == null || (mode === 'import' && !importName)"
        >
          {{ busy ? "正在处理…" : mode === "export" ? "导出" : "导入" }}
        </button>
      </footer>
    </form>
  </DraggableDialog>
</template>
