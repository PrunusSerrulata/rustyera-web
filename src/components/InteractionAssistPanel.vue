<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { assistedInteractionRows, interactionAssistModeVisible } from "@/core/interactionAssist";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const slot = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const expanded = ref(false);
const mobileBrowser = ref(false);
const gameAreaHeight = ref(0);
const collapsedHeight = ref(0);
let areaObserver: ResizeObserver | undefined;
let panelObserver: ResizeObserver | undefined;
let mobileQuery: MediaQueryList | undefined;

const rows = computed(() => assistedInteractionRows(store.presentation));
const flatItems = computed(() => rows.value.flatMap((row) => row.items));
const modeEligible = computed(() =>
  interactionAssistModeVisible(
    store.effectivePreferences.interactionAssistMode,
    store.bridgeKind,
    mobileBrowser.value,
  ),
);
const geometry = computed(() => {
  const collapsed = collapsedHeight.value;
  const projectedViewport = Math.max(0, gameAreaHeight.value - collapsed);
  const expandedMaximum = projectedViewport * 0.75;
  return {
    projectedViewport,
    expandedMaximum,
    show:
      modeEligible.value &&
      collapsed > 0 &&
      projectedViewport >= collapsed &&
      collapsed <= expandedMaximum,
  };
});
const visible = computed(() => geometry.value.show);
const panelStyle = computed(() => ({
  maxHeight: visible.value && expanded.value ? `${geometry.value.expandedMaximum}px` : undefined,
}));

watch(visible, (shown) => {
  if (!shown) expanded.value = false;
});
watch(
  () => [rows.value.length, flatItems.value.length],
  async () => {
    if (expanded.value) return;
    await nextTick();
    measurePanel();
  },
);

function phoneDevice(): boolean {
  const userAgentData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  return (
    userAgentData?.mobile === true ||
    /Android.*Mobile|iPhone|iPod|IEMobile|Windows Phone|Mobile/i.test(navigator.userAgent)
  );
}

function updateMobileBrowser(): void {
  mobileBrowser.value = phoneDevice() || mobileQuery?.matches === true;
}

function measurePanel(): void {
  if (!panel.value || expanded.value) return;
  collapsedHeight.value = Math.ceil(panel.value.getBoundingClientRect().height);
}

function measureArea(): void {
  const area = slot.value?.closest<HTMLElement>(".game-area");
  if (area) gameAreaHeight.value = Math.floor(area.getBoundingClientRect().height);
}

onMounted(() => {
  mobileQuery = window.matchMedia("(max-width: 760px)");
  mobileQuery.addEventListener("change", updateMobileBrowser);
  updateMobileBrowser();
  measureArea();
  measurePanel();
  const area = slot.value?.closest<HTMLElement>(".game-area");
  if (typeof ResizeObserver !== "undefined" && area && panel.value) {
    areaObserver = new ResizeObserver(measureArea);
    areaObserver.observe(area);
    panelObserver = new ResizeObserver(measurePanel);
    panelObserver.observe(panel.value);
  }
});

onBeforeUnmount(() => {
  mobileQuery?.removeEventListener("change", updateMobileBrowser);
  areaObserver?.disconnect();
  panelObserver?.disconnect();
});
</script>

<template>
  <div
    ref="slot"
    class="interaction-assist-slot"
    :class="{
      'interaction-assist-hidden': !visible,
      'interaction-assist-expanded': visible && expanded,
    }"
    :style="visible ? { height: `${collapsedHeight}px` } : undefined"
  >
    <section
      ref="panel"
      class="interaction-assist-panel"
      :class="{ expanded: visible && expanded }"
      :style="panelStyle"
      aria-label="交互辅助面板"
      :aria-hidden="!visible"
      :inert="!visible"
    >
      <header class="interaction-assist-header">
        <strong>交互辅助面板</strong>
        <button
          type="button"
          class="interaction-assist-toggle"
          aria-controls="interaction-assist-actions"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? "折叠" : "展开" }}
        </button>
      </header>
      <div id="interaction-assist-actions" class="interaction-assist-actions" :class="{ expanded }">
        <template v-if="expanded">
          <div
            v-for="row in rows"
            :key="row.rowKey"
            class="interaction-assist-row"
            :data-row-key="row.rowKey"
          >
            <button
              v-for="item in row.items"
              :key="item.key"
              type="button"
              class="interaction-assist-action"
              :title="item.label"
              :aria-label="item.label"
              :disabled="!store.canInteract"
              @click="store.activate(item.token)"
            >
              <span>{{ item.label }}</span>
            </button>
          </div>
        </template>
        <div v-else class="interaction-assist-row interaction-assist-flat-row">
          <button
            v-for="item in flatItems"
            :key="item.key"
            type="button"
            class="interaction-assist-action"
            :title="item.label"
            :aria-label="item.label"
            :disabled="!store.canInteract"
            @click="store.activate(item.token)"
          >
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
