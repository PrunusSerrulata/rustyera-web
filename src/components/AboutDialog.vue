<script setup lang="ts">
import DraggableDialog from "@/components/DraggableDialog.vue";
import { platformFrontendVersion } from "@/platform";

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const frontendVersion = platformFrontendVersion();
const coreVersion = import.meta.env.VITE_RUSTYERA_CORE_VERSION;
</script>

<template>
  <DraggableDialog :open="open" title="关于 RustyEra" @close="$emit('close')">
    <dl class="about-details">
      <dt>作者</dt>
      <dd>PrunusSerrulata</dd>
      <dt>前端版本</dt>
      <dd>{{ frontendVersion }}</dd>
      <dt>core 版本</dt>
      <dd>{{ coreVersion }}</dd>
      <dt>许可证</dt>
      <dd>GPL-3.0-only</dd>
    </dl>
    <footer class="dialog-actions">
      <span class="spacer" />
      <button type="button" class="primary" @click="$emit('close')">确定</button>
    </footer>
  </DraggableDialog>
</template>
