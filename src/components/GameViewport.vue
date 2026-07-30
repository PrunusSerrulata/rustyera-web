<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import DisplayLine from "@/components/DisplayLine.vue";
import GameTooltip from "@/components/GameTooltip.vue";
import HtmlNode from "@/components/HtmlNode.vue";
import MediaImage from "@/components/MediaImage.vue";
import { isViewportContinuationClick } from "@/core/viewportInteraction";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const viewport = ref<HTMLElement>();
const history = ref<HTMLElement>();
const viewportColumns = ref(100);
const viewportHeight = ref(0);
let viewportObserver: ResizeObserver | undefined;
let viewportFrame: number | undefined;
let projectedWidth = -1;
const virtualizer = useVirtualizer(
  computed(() => {
    return {
      count: store.presentation.lines.length,
      getScrollElement: () => viewport.value ?? null,
      estimateSize: () => 26,
      overscan: 20,
      // Preserve measured rows across same-epoch snapshots, but isolate restarted sessions.
      getItemKey: (index: number) =>
        `${store.runtimeEpoch}:${store.presentation.lines[index]?.line_id ?? index}`,
    };
  }),
);
const items = computed(() => virtualizer.value.getVirtualItems());
const measuredHistoryHeight = computed(() => {
  // Reading the virtual items keeps this projection in step with row measurements.
  void items.value;
  return virtualizer.value.getTotalSize();
});
const historyHeight = computed(() => Math.max(viewportHeight.value, measuredHistoryHeight.value));
const historyBottomInset = computed(() =>
  Math.max(0, viewportHeight.value - measuredHistoryHeight.value),
);

watch(
  () => store.presentation.historyRevision,
  async () => {
    await nextTick();
    goBottom();
    // Dynamic rows are measured only after the first scroll makes the tail
    // visible. Follow the corrected size on the next frame, then clamp to the
    // actual DOM bottom after Vue Virtual has applied that measurement.
    await nextAnimationFrame();
    goBottom();
    await nextAnimationFrame();
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
  },
);

function goBottom(): void {
  if (!store.presentation.lines.length) return;
  virtualizer.value.scrollToIndex(Math.max(0, store.presentation.lines.length - 1), {
    align: "end",
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function lineMinimumHeight(line: any): string | undefined {
  let hasSpaceShape = false;
  let negativeImageBottom = 0;
  const visit = (node: any): void => {
    const semantic = node?.semantic;
    if (semantic?.type === "shape" && semantic.kind?.toLowerCase() === "space") {
      hasSpaceShape = true;
    } else if (semantic?.type === "image") {
      const y = projectHtmlLength(semantic.y);
      const height = projectHtmlLength(semantic.height, true);
      if (y != null && y < 0 && height != null) {
        negativeImageBottom = Math.max(
          negativeImageBottom,
          (y + height) * store.effectivePreferences.imageScale,
        );
      }
    }
    for (const child of node?.children ?? []) visit(child);
  };
  for (const run of line?.runs ?? []) {
    if (run.type === "html_document") {
      for (const node of run.document?.nodes ?? []) visit(node);
    }
  }
  return hasSpaceShape && negativeImageBottom > store.gameTextStyle.fontSizePx
    ? `${negativeImageBottom}px`
    : undefined;
}

function projectHtmlLength(value: any, absolute = false): number | undefined {
  if (!value) return undefined;
  const raw = Number(value.value);
  const projected =
    value.unit === "pixels"
      ? raw
      : value.unit === "logical"
        ? raw / 1000
        : (raw * store.gameTextStyle.fontSizePx) / 100;
  if (!Number.isFinite(projected)) return undefined;
  return absolute ? Math.abs(projected) : projected;
}

function click(event: MouseEvent): void {
  if (viewport.value && isViewportContinuationClick(event, viewport.value)) {
    void store.continueFromViewport();
  }
}

function measureViewportColumns(): void {
  if (!viewport.value) return;
  const probe = document.createElement("span");
  const sample = "0000000000";
  probe.className = "column-width-probe";
  probe.textContent = sample;
  viewport.value.append(probe);
  const columnWidth = probe.getBoundingClientRect().width / sample.length;
  probe.remove();
  const availableWidth = history.value?.clientWidth || viewport.value.clientWidth;
  if (columnWidth > 0 && availableWidth > 0) {
    viewportColumns.value = Math.max(1, Math.floor(availableWidth / columnWidth));
  }
}

function synchronizeViewport(): void {
  viewportFrame = undefined;
  if (!viewport.value) return;
  viewportHeight.value = viewport.value.clientHeight;
  measureViewportColumns();
  if (viewport.value.clientWidth === projectedWidth) return;
  projectedWidth = viewport.value.clientWidth;
  void store.projectViewport();
}

function scheduleViewportSynchronization(): void {
  if (viewportFrame != null) cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(synchronizeViewport);
}

onMounted(() => {
  synchronizeViewport();
  if (typeof ResizeObserver !== "undefined" && viewport.value) {
    viewportObserver = new ResizeObserver(scheduleViewportSynchronization);
    viewportObserver.observe(viewport.value);
  }
});
onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  if (viewportFrame != null) cancelAnimationFrame(viewportFrame);
});
watch(
  () => [store.gameTextStyle?.fontFamily, store.gameTextStyle?.fontSize],
  async () => {
    await nextTick();
    measureViewportColumns();
  },
);
</script>

<template>
  <main
    ref="viewport"
    class="game-viewport"
    tabindex="0"
    :inert="store.gameInteractionsBlocked"
    :aria-busy="store.gameInteractionsBlocked"
    @click="click"
    @contextmenu.prevent="store.skip"
  >
    <div class="background-layer">
      <MediaImage
        v-for="background in store.presentation.backgrounds"
        :key="`${background.resource_id}:${background.revision}`"
        :placement="background"
        :line-slot="false"
      />
    </div>
    <div
      ref="history"
      class="virtual-history"
      :class="{ 'history-bottom-aligned': historyBottomInset > 0 }"
      :style="{ height: `${historyHeight}px` }"
    >
      <div
        v-for="item in items"
        :key="String(item.key)"
        :ref="(element) => element && virtualizer.measureElement(element as Element)"
        class="game-line"
        :class="`align-${store.presentation.lines[item.index].alignment}`"
        :data-index="item.index"
        :style="{
          transform: `translateY(${item.start + historyBottomInset}px)`,
          minHeight: lineMinimumHeight(store.presentation.lines[item.index]),
        }"
      >
        <DisplayLine
          :line="store.presentation.lines[item.index]"
          :viewport-columns="viewportColumns"
        />
      </div>
    </div>
    <div class="html-island">
      <template
        v-for="(document, documentIndex) in store.presentation.htmlIsland"
        :key="documentIndex"
      >
        <HtmlNode v-for="(node, nodeIndex) in document.nodes" :key="nodeIndex" :node="node" />
      </template>
    </div>
  </main>
  <GameTooltip :scope="viewport" :settings="store.presentation.tooltip" />
</template>
