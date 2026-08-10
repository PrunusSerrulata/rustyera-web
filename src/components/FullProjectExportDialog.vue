<script setup lang="ts">
import DraggableDialog from "@/components/DraggableDialog.vue";

defineProps<{
  open: boolean;
  label: string;
  value?: number;
}>();
defineEmits<{ cancel: [] }>();
</script>

<template>
  <DraggableDialog
    :open="open"
    title="导出全量项目文件"
    return-focus="#menu-file"
    @close="$emit('cancel')"
  >
    <div class="full-project-export" aria-live="polite">
      <progress max="100" :value="value" />
      <p>{{ label }}</p>
    </div>
    <footer class="dialog-actions">
      <span class="spacer" />
      <button type="button" class="danger" @click="$emit('cancel')">取消</button>
    </footer>
  </DraggableDialog>
</template>
