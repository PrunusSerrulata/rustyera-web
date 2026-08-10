<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import LogNotification from "@/components/LogNotification.vue";
import type { LogNotificationState } from "@/core/log";
import { oldestOverflowCount } from "@/core/notificationLayout";

const props = defineProps<{
  notifications: LogNotificationState[];
  diagnosis: string;
}>();
const emit = defineEmits<{ dismiss: [id: number] }>();

const container = ref<HTMLElement>();
const notificationGapPx = 8;
const viewportBottomMarginPx = 10;
let resizeObserver: ResizeObserver | undefined;
let fitQueued = false;
let observationRefreshQueued = false;

function scheduleFit(refreshObservedItems = false): void {
  observationRefreshQueued ||= refreshObservedItems;
  if (fitQueued) return;
  fitQueued = true;
  void nextTick(() => {
    fitQueued = false;
    if (observationRefreshQueued) {
      observationRefreshQueued = false;
      observeItems();
    }
    fitToViewport();
  });
}

function observeItems(): void {
  resizeObserver?.disconnect();
  const element = container.value;
  if (!resizeObserver || !element) return;
  for (const item of element.querySelectorAll<HTMLElement>(
    ".log-notification, .diagnosis-notification",
  )) {
    resizeObserver.observe(item);
  }
}

function handleViewportResize(): void {
  scheduleFit();
}

function fitToViewport(): void {
  const element = container.value;
  if (!element || props.notifications.length === 0) return;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const availableHeight = Math.max(
    0,
    viewportHeight - element.getBoundingClientRect().top - viewportBottomMarginPx,
  );
  const heights = [...element.querySelectorAll<HTMLElement>(".log-notification")].map(
    (notification) => notification.getBoundingClientRect().height,
  );
  const diagnosisHeight =
    element.querySelector<HTMLElement>(".diagnosis-notification")?.getBoundingClientRect().height ??
    0;
  const overflow = oldestOverflowCount(
    heights,
    diagnosisHeight,
    notificationGapPx,
    availableHeight,
  );
  for (const notification of props.notifications.slice(0, overflow)) {
    emit("dismiss", notification.id);
  }
}

watch(
  () => [props.diagnosis, ...props.notifications.map((notification) => notification.id)],
  () => scheduleFit(true),
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("resize", handleViewportResize);
  resizeObserver = new ResizeObserver(() => scheduleFit());
  scheduleFit(true);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleViewportResize);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="container" class="corner-notifications" :style="{ gap: `${notificationGapPx}px` }">
    <LogNotification
      v-for="notification in notifications"
      :id="notification.id"
      :key="notification.id"
      :level="notification.level"
      :message="notification.message"
      @close="emit('dismiss', $event)"
    />
    <div v-if="diagnosis" class="diagnosis-notification" role="status" aria-live="polite">
      {{ diagnosis }}
    </div>
  </div>
</template>
