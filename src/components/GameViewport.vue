<script setup lang="ts">
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElement,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/vue-virtual";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";

import DisplayLine from "@/components/DisplayLine.vue";
import GameTooltip from "@/components/GameTooltip.vue";
import HtmlNode from "@/components/HtmlNode.vue";
import SceneCompositor from "@/components/SceneCompositor.vue";
import { useTouchSecondaryAction } from "@/components/useTouchSecondaryAction";
import { isViewportContinuationClick } from "@/core/viewportInteraction";
import { htmlBoxRowLayoutsForRange } from "@/core/htmlBoxLayout";
import { usesConfiguredLineHeight } from "@/core/lineLayout";
import { compactSceneDepthRanks, sceneDepthKey, sceneDepthRankKey } from "@/core/sceneStacking";
import type {
  Color,
  DisplayLine as PresentationLine,
  DisplayRun,
  MediaPlacement,
} from "@/core/types";
import { measureGameViewport } from "@/platform/viewportMeasurement";
import { currentLineGeometry, registerLineGeometryProvider } from "@/platform/lineGeometry";
import {
  RuntimeServiceError,
  sameServiceInteger,
  type LineGeometryQuery,
} from "@/core/runtimeServiceProtocol";
import { activateScenePointer } from "@/platform/scenePointerObservation";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const viewport = ref<HTMLElement>();
const history = ref<HTMLElement>();
const touchSecondaryAction = useTouchSecondaryAction(
  () => store.useMouse,
  () => void store.skip(),
);
const viewportColumns = ref(100);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
const viewportScrollTop = ref(0);
let viewportObserver: ResizeObserver | undefined;
let unregisterLineGeometry: (() => void) | undefined;
let viewportFrame: number | undefined;
let projectedWidth = -1;
let projectedHeight = -1;
let projectedLineColumns = -1;
let projectedLayoutIdentity = "";
let keyedRuntimeEpoch = "";
let bottomFollowRevision = 0;
let followingBottom = false;
let preserveNfViewport = false;
let nfUserScrolled = false;
const keyedLines = new Map<number, { id: string; key: string; mediaLayout?: string }>();
type RangeExtractor = (range: Range) => number[];
const baseRangeExtractor = shallowRef<RangeExtractor>(defaultRangeExtractor);
const activeRangeExtractor = shallowRef<RangeExtractor>(defaultRangeExtractor);
const geometryRangeLeases = new Map<number, number>();
const geometryAbort = new AbortController();

const sceneDepthRanks = computed(() =>
  compactSceneDepthRanks([
    ...store.presentation.scene.layers.map((layer) => layer.depth),
    ...presentationHtmlDepths(),
  ]),
);
provide(sceneDepthRankKey, (depth) => sceneDepthRanks.value.get(sceneDepthKey(depth)) ?? 0);

watch(
  () => store.runtimeEpoch,
  (runtimeEpoch) => {
    const epoch = String(runtimeEpoch);
    if (epoch !== keyedRuntimeEpoch) {
      keyedLines.clear();
      preserveNfViewport = false;
      nfUserScrolled = false;
    }
    keyedRuntimeEpoch = epoch;
  },
  { immediate: true, flush: "sync" },
);

watch(
  () => store.presentation.inputWait,
  async (wait) => {
    if (wait == null) return;
    const preserve =
      wait.viewport_policy === "preserve_user_viewport" || wait.viewport_policy === 1;
    if (preserve) {
      if (!preserveNfViewport) nfUserScrolled = !isAtBottom();
      preserveNfViewport = true;
      return;
    }
    preserveNfViewport = false;
    nfUserScrolled = false;
    bottomFollowRevision += 1;
    const revision = bottomFollowRevision;
    followingBottom = true;
    selectTerminalRange();
    await nextTick();
    if (revision !== bottomFollowRevision) return;
    goBottom();
    await nextAnimationFrame();
    if (revision !== bottomFollowRevision) return;
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
    followingBottom = false;
    releaseTerminalRange();
  },
  // Apply the policy before the pre-flush history watcher observes a snapshot
  // that publishes both a new tail and its NF wait in one reactive commit.
  { flush: "sync" },
);

function lineRenderKey(index: number): string {
  // Appending history must not invalidate every measured row. Reuse an index key only for media
  // frames with identical geometry; this preserves a generated animation's mounted canvas while
  // ensuring ordinary replacement rows never inherit the previous screen's measured height.
  const line = store.presentation.lines[index];
  const id = String(line?.line_id ?? index);
  const cached = keyedLines.get(index);
  if (cached?.id === id) return cached.key;
  const mediaLayout = mediaLayoutIdentity(line);
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
      placements.push([
        node.semantic.width,
        node.semantic.height,
        node.semantic.x,
        node.semantic.y,
        node.semantic.display,
      ]);
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

function measureLineElement(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLElement, Element>,
): number {
  if (entry == null) {
    const index = instance.indexFromElement(element);
    const key = instance.options.getItemKey(index);
    if (
      !instance.itemSizeCache.has(key) &&
      usesConfiguredLineHeight(store.presentation.lines[index])
    )
      return Math.max(1, instance.options.estimateSize(index));
  }
  return measureVirtualElement(element, entry, instance);
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
      measureElement: measureLineElement,
      overscan: 20,
      rangeExtractor: activeRangeExtractor.value,
      // Preserve measured rows and mounted media across same-epoch snapshots. When an animation
      // deletes and recreates an equal-length tail, reuse that row's render key so its canvas can
      // keep the prior frame visible until the replacement replay has committed.
      getItemKey: lineRenderKey,
    };
  }),
);
// TanStack can expose the previous range for one render while an authoritative snapshot trims or
// replaces history. Never let those retired indices reach the DOM or the line-geometry projection.
const items = computed(() =>
  (() => {
    const current = virtualizer.value.getVirtualItems();
    const valid = (item: (typeof current)[number]) =>
      item.index >= 0 && item.index < store.presentation.lines.length;
    // Preserve the virtualizer's array identity on the ordinary path so projection observers do
    // not schedule a second frame merely because validation inspected an already-valid range.
    return current.every(valid) ? current : current.filter(valid);
  })(),
);
const visibleBoxRowLayouts = computed(() => {
  const visibleItems = items.value;
  if (visibleItems.length === 0) return new Map();
  return htmlBoxRowLayoutsForRange(
    store.presentation.lines,
    visibleItems[0].index,
    visibleItems.at(-1)?.index ?? visibleItems[0].index,
  );
});
const measuredHistoryHeight = computed(() => {
  // Reading the virtual items keeps this projection in step with row measurements.
  void items.value;
  return virtualizer.value.getTotalSize();
});
const historyHeight = computed(() => Math.max(viewportHeight.value, measuredHistoryHeight.value));
const historyBottomInset = computed(() =>
  Math.max(0, viewportHeight.value - measuredHistoryHeight.value),
);
const sceneLineTops = computed(() => {
  void items.value;
  const tops = new Map<string, number>();
  const measurements = virtualizer.value.measurementsCache ?? [];
  for (const measurement of measurements) {
    const line = store.presentation.lines[measurement.index];
    if (line) tops.set(String(line.line_id), measurement.start + historyBottomInset.value);
  }
  return tops;
});

function presentationHtmlDepths(): unknown[] {
  const depths: unknown[] = [];
  const visitNode = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { semantic?: unknown; children?: unknown };
    if (value.semantic && typeof value.semantic === "object") {
      const semantic = value.semantic as { type?: unknown; depth?: unknown };
      if (semantic.type === "division" && semantic.depth != null) depths.push(semantic.depth);
    }
    if (Array.isArray(value.children)) for (const child of value.children) visitNode(child);
  };
  const visitRun = (run: unknown): void => {
    if (!run || typeof run !== "object") return;
    const value = run as {
      type?: unknown;
      document?: { nodes?: unknown[] };
      runs?: unknown[];
      content?: unknown[];
    };
    if (value.type === "html_document")
      for (const node of value.document?.nodes ?? []) visitNode(node);
    for (const child of value.runs ?? value.content ?? []) visitRun(child);
  };
  for (const line of store.presentation.lines) for (const run of line.runs) visitRun(run);
  for (const document of store.presentation.htmlIsland)
    for (const node of document?.nodes ?? []) visitNode(node);
  return depths;
}

const bottomFollowSource = () =>
  [store.presentation.historyRevision, store.presentation.lines.at(-1)?.line_id] as const;
let followAfterRender = false;
watch(
  bottomFollowSource,
  ([historyRevision], [previousHistoryRevision]) => {
    // Equal-length dynamic-map refreshes replace the tail with new line IDs without
    // counting as new history. Keep following them only when the old frame was at bottom;
    // an intentionally scrolled-back viewport must remain untouched.
    if (preserveNfViewport) nfUserScrolled = !isAtBottom();
    const shouldFollow =
      !(preserveNfViewport && nfUserScrolled) &&
      (historyRevision !== previousHistoryRevision || followingBottom || isAtBottom());
    bottomFollowRevision += 1;
    followAfterRender = shouldFollow;
    if (shouldFollow) selectTerminalRange();
    else {
      followingBottom = false;
      releaseTerminalRange();
    }
  },
  { flush: "pre" },
);
watch(
  bottomFollowSource,
  async () => {
    if (!followAfterRender) return;
    followAfterRender = false;
    const followRevision = bottomFollowRevision;
    followingBottom = true;
    // The pre-flush extractor made the new tail part of this commit. Select it immediately so the
    // browser can paint the final interactive row without waiting for a second virtualizer range.
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
    // The terminal extractor only has to make the new tail part of the first commit. Keeping it
    // beyond the two measurement frames can hide the user's scrolled-back range when natural
    // range synchronization is delayed, so the newest follow generation always releases it.
    releaseTerminalRange();
  },
  { flush: "post" },
);

function selectTerminalRange(): void {
  const lineHeight = Math.max(1, store.gameLineHeightPx);
  const visibleLines =
    viewportHeight.value > 0
      ? Math.max(1, Math.ceil(viewportHeight.value / lineHeight))
      : undefined;
  // A distinct extractor identity invalidates TanStack's range memo even when a redraw replaces
  // an equal-length tail. Mounting only the terminal window avoids retaining both generations of
  // interactive controls while the post-render scroll catches up.
  baseRangeExtractor.value = (range) => {
    if (range.count === 0) return [];
    const visible = visibleLines ?? Math.max(1, range.endIndex - range.startIndex + 1);
    const start = Math.max(0, range.count - visible);
    // The extractor exists only for the first followed commit. Mount exactly the visible tail;
    // applying the steady-state overscan here creates dozens of off-screen rich rows on the
    // latency-critical input transition, even though the natural range is restored after layout.
    return Array.from({ length: range.count - start }, (_, offset) => start + offset);
  };
  refreshRangeExtractor();
}

function releaseTerminalRange(): void {
  baseRangeExtractor.value = defaultRangeExtractor;
  refreshRangeExtractor();
}

function acquireGeometryRange(index: number): () => void {
  geometryRangeLeases.set(index, (geometryRangeLeases.get(index) ?? 0) + 1);
  refreshRangeExtractor();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (geometryRangeLeases.get(index) ?? 1) - 1;
    if (remaining > 0) geometryRangeLeases.set(index, remaining);
    else geometryRangeLeases.delete(index);
    refreshRangeExtractor();
  };
}

function refreshRangeExtractor(): void {
  const base = baseRangeExtractor.value;
  const forced = [...geometryRangeLeases.keys()];
  if (forced.length === 0) {
    activeRangeExtractor.value = base;
    return;
  }
  activeRangeExtractor.value = (range) => {
    const indexes = new Set(base(range));
    for (const index of forced) if (index >= 0 && index < range.count) indexes.add(index);
    return [...indexes].sort((left, right) => left - right);
  };
}

function releaseTerminalRangeOnScrollBack(): void {
  viewportScrollTop.value = viewport.value?.scrollTop ?? 0;
  if (preserveNfViewport) nfUserScrolled = !isAtBottom();
  if (!followingBottom && !isAtBottom()) releaseTerminalRange();
  scheduleViewportSynchronization();
}

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

function wholeLineBackground(line: PresentationLine | undefined): string | undefined {
  const color = store.presentation.settings.text_line_background as Color | null | undefined;
  if (!line?.text_background_eligible || color == null) return undefined;
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`;
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
  if (activateScenePointer(event.clientX, event.clientY)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
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

function synchronizeViewport(forceObservation = false): void {
  viewportFrame = undefined;
  if (!viewport.value) return;
  viewportScrollTop.value = viewport.value.scrollTop;
  const measurement = measureGameViewport(viewport.value, history.value);
  viewportWidth.value = measurement.width;
  viewportHeight.value = measurement.height;
  viewportColumns.value = measurement.lineColumns;
  const layoutIdentity = viewportLayoutIdentity();
  if (
    !forceObservation &&
    measurement.width === projectedWidth &&
    measurement.height === projectedHeight &&
    measurement.lineColumns === projectedLineColumns &&
    layoutIdentity === projectedLayoutIdentity
  )
    return;
  projectedWidth = measurement.width;
  projectedHeight = measurement.height;
  projectedLineColumns = measurement.lineColumns;
  projectedLayoutIdentity = layoutIdentity;
  void store.projectViewport(measurement, layoutIdentity);
}

function viewportLayoutIdentity(): string {
  return JSON.stringify([
    viewportScrollTop.value,
    viewportWidth.value,
    viewportHeight.value,
    measuredHistoryHeight.value,
    historyBottomInset.value,
    items.value.map((item) => [item.key, item.index, item.start, item.size]),
  ]);
}

function scheduleViewportSynchronization(): void {
  if (viewportFrame != null) cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => synchronizeViewport());
}

onMounted(() => {
  synchronizeViewport();
  if (typeof ResizeObserver !== "undefined" && viewport.value) {
    viewportObserver = new ResizeObserver(scheduleViewportSynchronization);
    viewportObserver.observe(viewport.value);
  }
  unregisterLineGeometry = registerLineGeometryProvider(realizeLineGeometry);
});
onBeforeUnmount(() => {
  geometryAbort.abort();
  geometryRangeLeases.clear();
  refreshRangeExtractor();
  unregisterLineGeometry?.();
  viewportObserver?.disconnect();
  if (viewportFrame != null) cancelAnimationFrame(viewportFrame);
});

async function realizeLineGeometry(query: LineGeometryQuery, signal: AbortSignal) {
  const targetViewport = viewport.value;
  if (!targetViewport || !targetViewport.isConnected)
    throw new RuntimeServiceError("stale_projection", "game viewport is unavailable");
  assertGeometryActive(signal);
  const index = store.presentation.lines.findIndex((line) =>
    sameServiceInteger(line.line_id, query.lineId),
  );
  if (index < 0) return currentLineGeometry(targetViewport, query.lineId);
  const release = acquireGeometryRange(index);
  try {
    await nextTick();
    assertGeometryActive(signal);
    await nextAnimationFrame();
    assertGeometryActive(signal);
    await nextTick();
    assertGeometryActive(signal);
    return currentLineGeometry(targetViewport, query.lineId);
  } finally {
    release();
    await nextTick();
  }
}

function assertGeometryActive(signal: AbortSignal): void {
  if (signal.aborted || geometryAbort.signal.aborted)
    throw new RuntimeServiceError("stale_projection", "line geometry query was cancelled");
}
watch(
  [
    () => store.gameTextStyle?.fontFamily,
    () => store.gameTextStyle?.fontSize,
    () => store.gameLineHeightPx,
  ],
  async () => {
    await nextTick();
    synchronizeViewport(true);
    virtualizer.value.measure();
  },
);
watch(viewportLayoutIdentity, () => scheduleViewportSynchronization());
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
    @scroll.passive="releaseTerminalRangeOnScrollBack"
    @wheel.prevent="wheel"
  >
    <SceneCompositor
      :scene="store.presentation.scene ?? { revision: 0, layers: [] }"
      :line-tops="sceneLineTops"
      :scroll-top="viewportScrollTop"
      :viewport-width="viewportWidth"
      :viewport-height="viewportHeight"
      :depth-ranks="sceneDepthRanks"
      :style="{ height: `${historyHeight}px` }"
    >
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
          :data-line-id="String(store.presentation.lines[item.index].line_id)"
          :style="{
            transform: `translateY(${item.start + historyBottomInset}px)`,
            minHeight: lineMinimumHeight(store.presentation.lines[item.index]),
            backgroundColor: wholeLineBackground(store.presentation.lines[item.index]),
          }"
        >
          <DisplayLine
            :line="store.presentation.lines[item.index]"
            :viewport-columns="viewportColumns"
            :box-row-layout="visibleBoxRowLayouts.get(item.index)"
          />
        </div>
      </div>
      <template #positioned-html>
        <div class="html-island">
          <template
            v-for="(document, documentIndex) in store.presentation.htmlIsland"
            :key="documentIndex"
          >
            <HtmlNode v-for="(node, nodeIndex) in document.nodes" :key="nodeIndex" :node="node" />
          </template>
        </div>
      </template>
    </SceneCompositor>
  </main>
  <GameTooltip :scope="viewport" :settings="store.presentation.tooltip" />
</template>
