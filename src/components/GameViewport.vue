<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import DisplayLine from "@/components/DisplayLine.vue";
import GameTooltip from "@/components/GameTooltip.vue";
import HtmlNode from "@/components/HtmlNode.vue";
import MediaImage from "@/components/MediaImage.vue";
import { useTouchSecondaryAction } from "@/components/useTouchSecondaryAction";
import { isViewportContinuationClick } from "@/core/viewportInteraction";
import type { DisplayLine as PresentationLine, DisplayRun, MediaPlacement } from "@/core/types";
import { measureGameViewport } from "@/platform/viewportMeasurement";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const viewport = ref<HTMLElement>();
const history = ref<HTMLElement>();
const touchSecondaryAction = useTouchSecondaryAction(
  () => store.useMouse,
  () => void store.skip(),
);
const viewportColumns = ref(100);
const viewportHeight = ref(0);
let viewportObserver: ResizeObserver | undefined;
let viewportFrame: number | undefined;
let projectedWidth = -1;
let projectedHeight = -1;
let projectedLineColumns = -1;
let keyedRuntimeEpoch = "";
let bottomFollowRevision = 0;
let followingBottom = false;
const keyedLines = new Map<number, { id: string; key: string; mediaLayout?: string }>();

watch(
  () => store.runtimeEpoch,
  (runtimeEpoch) => {
    const epoch = String(runtimeEpoch);
    if (epoch !== keyedRuntimeEpoch) keyedLines.clear();
    keyedRuntimeEpoch = epoch;
  },
  { immediate: true, flush: "sync" },
);

function lineRenderKey(index: number): string {
  // Appending history must not invalidate every measured row. Reuse an index key only for media
  // frames with identical geometry; this preserves a generated animation's mounted canvas while
  // ensuring ordinary replacement rows never inherit the previous screen's measured height.
  const line = store.presentation.lines[index];
  const id = String(line?.line_id ?? index);
  const mediaLayout = mediaLayoutIdentity(line);
  const cached = keyedLines.get(index);
  if (cached?.id === id) return cached.key;
  const key =
    mediaLayout != null && mediaLayout === cached?.mediaLayout
      ? cached.key
      : `${keyedRuntimeEpoch}:${id}`;
  keyedLines.set(index, { id, key, mediaLayout });
  return key;
}

function mediaLayoutIdentity(line: PresentationLine | undefined): string | undefined {
  const placements: unknown[] = [];
  const visitNode = (node: any): void => {
    if (node?.semantic?.type === "image") {
      placements.push([node.semantic.width, node.semantic.height, node.semantic.y]);
    }
    for (const child of node?.children ?? []) visitNode(child);
  };
  const visitPlacement = (placement: MediaPlacement): void => {
    placements.push([
      placement.requested_width,
      placement.requested_height,
      placement.requested_y,
      placement.width,
      placement.height,
    ]);
  };
  const visitRun = (run: DisplayRun): void => {
    switch (run.type) {
      case "image":
        visitPlacement(run.placement);
        break;
      case "html_document":
        for (const node of run.document?.nodes ?? []) visitNode(node);
        break;
      case "button":
        for (const child of run.runs) visitRun(child);
        break;
      case "column_cell":
        for (const child of run.content) visitRun(child);
        break;
    }
  };
  for (const run of line?.runs ?? []) visitRun(run);
  return placements.length
    ? JSON.stringify(placements, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )
    : undefined;
}
const virtualizer = useVirtualizer(
  computed(() => {
    // Equal-length replacements do not change count; revision keeps the virtualizer's key lookup
    // synchronized while lineRenderKey limits work to the requested virtual window.
    void store.presentation.revision;
    return {
      count: store.presentation.lines.length,
      getScrollElement: () => viewport.value ?? null,
      estimateSize: () => Math.max(1, store.gameLineHeightPx),
      overscan: 20,
      // Preserve measured rows and mounted media across same-epoch snapshots. When an animation
      // deletes and recreates an equal-length tail, reuse that row's render key so its canvas can
      // keep the prior frame visible until the replacement replay has committed.
      getItemKey: lineRenderKey,
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
  () => [store.presentation.historyRevision, store.presentation.lines.at(-1)?.line_id] as const,
  async ([historyRevision], [previousHistoryRevision]) => {
    // Equal-length dynamic-map refreshes replace the tail with new line IDs without
    // counting as new history. Keep following them only when the old frame was at bottom;
    // an intentionally scrolled-back viewport must remain untouched.
    if (historyRevision === previousHistoryRevision && !followingBottom && !isAtBottom()) return;
    const followRevision = ++bottomFollowRevision;
    followingBottom = true;
    await nextTick();
    if (followRevision !== bottomFollowRevision) return;
    goBottom();
    // Dynamic rows are measured only after the first scroll makes the tail
    // visible. Follow the corrected size on the next frame, then clamp to the
    // actual DOM bottom after Vue Virtual has applied that measurement.
    await nextAnimationFrame();
    if (followRevision !== bottomFollowRevision) return;
    goBottom();
    await nextAnimationFrame();
    if (followRevision !== bottomFollowRevision) return;
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
    followingBottom = false;
  },
);

function isAtBottom(): boolean {
  if (!viewport.value) return false;
  const maximumScrollTop = Math.max(0, viewport.value.scrollHeight - viewport.value.clientHeight);
  return maximumScrollTop - viewport.value.scrollTop <= 1;
}

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
  if (touchSecondaryAction.consumeClick()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!store.useMouse) return;
  if (viewport.value && isViewportContinuationClick(event, viewport.value)) {
    void store.continueFromViewport();
  }
}

function pointerDown(event: PointerEvent): void {
  if (
    event.pointerType === "touch" &&
    store.useMouse &&
    viewport.value &&
    isViewportContinuationClick(event, viewport.value)
  ) {
    // Animation frames replace their original output elements while a gesture is in progress.
    // Capture only non-interactive output so button taps retain their original click target.
    viewport.value.setPointerCapture?.(event.pointerId);
  }
  touchSecondaryAction.pointerDown(event);
}

function wheel(event: WheelEvent): void {
  if (!store.useMouse || !viewport.value) return;
  viewport.value.scrollTop += Math.sign(event.deltaY) * store.scrollHeight * store.gameLineHeightPx;
}

function synchronizeViewport(): void {
  viewportFrame = undefined;
  if (!viewport.value) return;
  const measurement = measureGameViewport(viewport.value, history.value);
  viewportHeight.value = measurement.height;
  viewportColumns.value = measurement.lineColumns;
  if (
    measurement.width === projectedWidth &&
    measurement.height === projectedHeight &&
    measurement.lineColumns === projectedLineColumns
  )
    return;
  projectedWidth = measurement.width;
  projectedHeight = measurement.height;
  projectedLineColumns = measurement.lineColumns;
  void store.projectViewport(measurement);
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
    synchronizeViewport();
  },
);
</script>

<template>
  <main
    ref="viewport"
    class="game-viewport"
    :class="{ 'mouse-disabled': !store.useMouse }"
    tabindex="0"
    :inert="store.gameInteractionsBlocked"
    :aria-busy="store.gameInteractionsBlocked"
    @click.capture="click"
    @mousedown.right.prevent="store.useMouse && store.skip()"
    @contextmenu.prevent
    @pointerdown="pointerDown"
    @pointermove="touchSecondaryAction.pointerMove"
    @pointerup="touchSecondaryAction.pointerUp"
    @pointercancel="touchSecondaryAction.pointerCancel"
    @wheel.prevent="wheel"
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
