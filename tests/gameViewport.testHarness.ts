import {
  flushPromises as flushVuePromises,
  shallowMount as shallowMountComponent,
} from "@vue/test-utils";

import {
  nextTick as nextVueTick,
  reactive as makeReactive,
  ref as makeRef,
  unref as unwrapRef,
} from "vue";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.hoisted(() => vi.fn());

const measure = vi.hoisted(() => vi.fn());

const naturalMeasureElement = vi.hoisted(() => vi.fn());

const virtualOptions = vi.hoisted(() => ({ value: undefined as any }));

const virtualState = vi.hoisted(() => ({
  items: [] as any[],
  totalSize: 0,
  naturalRange: { startIndex: 0, endIndex: 0 },
  useOptionsRange: false,
}));

const defaultRangeExtractor = vi.hoisted(
  () => (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
    if (range.count === 0) return [];
    return Array.from(
      {
        length:
          Math.min(range.count - 1, range.endIndex + range.overscan) -
          Math.max(0, range.startIndex - range.overscan) +
          1,
      },
      (_, offset) => Math.max(0, range.startIndex - range.overscan) + offset,
    );
  },
);

const continueFromViewport = vi.hoisted(() => vi.fn());

const projectViewport = vi.hoisted(() => vi.fn());

const store = makeReactive({
  runtimeEpoch: 1,
  presentation: {
    revision: 1,
    historyRevision: 1,
    lines: [
      {
        line_id: 1,
        alignment: "left",
        runs: [] as any[],
        text_background_eligible: false,
      },
    ],
    scene: { revision: 0, layers: [] as any[] },
    resources: { sprites: [], canvases: [] },
    htmlIsland: [] as any[],
    tooltip: {},
    settings: {},
    inputWait: undefined as any,
  },
  continueFromViewport,
  projectViewport,
  skip: vi.fn(),
  interactionEnabled: (interaction: any) => interaction.enabled === true,
  effectivePreferences: { imageScale: 1 },
  gameTextStyle: { fontFamily: "sans-serif", fontSize: "12px", fontSizePx: 12 },
  gameLineHeightPx: 13,
  useMouse: true,
  scrollHeight: 1,
});

vi.mock("@tanstack/vue-virtual", () => ({
  defaultRangeExtractor,
  measureElement: naturalMeasureElement,
  useVirtualizer: (options: any) => {
    virtualOptions.value = options;
    return makeRef({
      getVirtualItems: () => {
        if (!virtualState.useOptionsRange) return virtualState.items;
        const resolved = unwrapRef(options);
        return resolved
          .rangeExtractor({
            ...virtualState.naturalRange,
            overscan: resolved.overscan,
            count: resolved.count,
          })
          .map((index: number) => ({
            index,
            key: resolved.getItemKey(index),
            start: index * resolved.estimateSize(index),
          }));
      },
      getTotalSize: () => virtualState.totalSize,
      calculateRange: () => virtualState.naturalRange,
      measureElement: vi.fn(),
      measure,
      scrollToIndex,
      measurementsCache: [],
    });
  },
}));

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

vi.mock("@/components/SceneCompositor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SceneCompositor",
      props: {
        scene: { type: Object, required: true },
        lineTops: { type: Array, required: true },
        scrollTop: { type: Number, required: true },
        viewportWidth: { type: Number, required: true },
        viewportHeight: { type: Number, required: true },
        depthRanks: { type: Array, required: true },
      },
      setup(_props, { slots }) {
        return () =>
          h("div", { class: "scene-compositor-test-double" }, [
            slots.default?.(),
            slots["positioned-html"]?.(),
          ]);
      },
    }),
  };
});

import DisplayLineImplementation from "@/components/DisplayLine.vue";

import GameViewportImplementation from "@/components/GameViewport.vue";

const DisplayLine = DisplayLineImplementation;
const GameViewport = GameViewportImplementation;
const flushPromises = flushVuePromises;
const shallowMount = shallowMountComponent;
const nextTick = nextVueTick;
const reactive = makeReactive;
const ref = makeRef;
const unref = unwrapRef;

function mountViewport() {
  return shallowMount(GameViewport, {
    global: { stubs: { SceneCompositor: false } },
  });
}

function dispatchTouch(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerId: number,
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
  });
  target.dispatchEvent(event);
}

export {
  DisplayLine,
  GameViewport,
  afterEach,
  beforeEach,
  continueFromViewport,
  defaultRangeExtractor,
  describe,
  dispatchTouch,
  expect,
  flushPromises,
  it,
  measure,
  mountViewport,
  naturalMeasureElement,
  nextTick,
  projectViewport,
  reactive,
  ref,
  scrollToIndex,
  shallowMount,
  store,
  unref,
  vi,
  virtualOptions,
  virtualState,
};
