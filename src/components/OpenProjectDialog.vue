<script setup lang="ts">
import DraggableDialog from "@/components/DraggableDialog.vue";

defineProps<{ open: boolean }>();
defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
  <DraggableDialog :open="open" title="打开新项目" @close="$emit('cancel')">
    <p>打开新项目会丢失当前游戏中尚未保存的进度。</p>
    <p>确定要打开新项目吗？</p>
    <footer class="dialog-actions">
      <span class="spacer" />
      <button type="button" @click="$emit('cancel')">取消</button>
      <button type="button" class="danger" @click="$emit('confirm')">打开新项目</button>
    </footer>
  </DraggableDialog>
</template>
