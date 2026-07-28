<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onMounted, ref, watch } from "vue";

import HtmlNode from "@/components/HtmlNode.vue";
import MediaImage from "@/components/MediaImage.vue";
import RunRenderer from "@/components/RunRenderer.vue";
import { isViewportContinuationClick } from "@/core/viewportInteraction";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const viewport = ref<HTMLElement>();
const virtualizer = useVirtualizer(
  computed(() => ({
    count: store.presentation.lines.length,
    getScrollElement: () => viewport.value ?? null,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index: number) => store.presentation.lines[index]?.line_id ?? index,
  })),
);
const items = computed(() => virtualizer.value.getVirtualItems());

watch(
  () => store.presentation.revision,
  async () => {
    await nextTick();
    goBottom();
  },
);

function goBottom(): void {
  virtualizer.value.scrollToIndex(Math.max(0, store.presentation.lines.length - 1), {
    align: "end",
  });
  requestAnimationFrame(() => {
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
  });
}

function click(event: MouseEvent): void {
  if (viewport.value && isViewportContinuationClick(event, viewport.value)) {
    void store.continueFromViewport();
  }
}

onMounted(() => store.projectViewport());
</script>

<template>
  <main
    ref="viewport"
    class="game-viewport"
    tabindex="0"
    @click="click"
    @load.capture="goBottom"
    @contextmenu.prevent="store.skip"
  >
    <div class="background-layer">
      <MediaImage
        v-for="background in store.presentation.backgrounds"
        :key="`${background.resource_id}:${background.revision}`"
        :placement="background"
      />
    </div>
    <div class="virtual-history" :style="{ height: `${virtualizer.getTotalSize()}px` }">
      <div
        v-for="item in items"
        :key="String(item.key)"
        :ref="(element) => element && virtualizer.measureElement(element as Element)"
        class="game-line"
        :class="`align-${store.presentation.lines[item.index].alignment}`"
        :data-index="item.index"
        :style="{ transform: `translateY(${item.start}px)` }"
      >
        <RunRenderer
          v-for="(run, index) in store.presentation.lines[item.index].runs"
          :key="index"
          :run="run"
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
</template>
