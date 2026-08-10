<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

const props = defineProps<{ id: number; message: string }>();
const emit = defineEmits<{ close: [id: number] }>();

const dismissAfterMs = 8000;
let dismissTimer: number | undefined;
let dismissed = false;

function dismiss(): void {
  if (dismissed) return;
  dismissed = true;
  if (dismissTimer != null) window.clearTimeout(dismissTimer);
  dismissTimer = undefined;
  emit("close", props.id);
}

onMounted(() => {
  dismissTimer = window.setTimeout(dismiss, dismissAfterMs);
});

onBeforeUnmount(() => {
  if (dismissTimer != null) window.clearTimeout(dismissTimer);
  dismissTimer = undefined;
});
</script>

<template>
  <aside class="warning-notification" role="alert" aria-live="assertive" aria-atomic="true">
    <span
      class="warning-notification-countdown"
      :style="{ animationDuration: `${dismissAfterMs}ms` }"
      aria-hidden="true"
    />
    <div class="warning-notification-content">
      <strong>警告</strong>
      <span>{{ message }}</span>
    </div>
    <button type="button" aria-label="关闭警告" title="关闭" @click="dismiss">×</button>
  </aside>
</template>
