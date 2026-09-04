import { flushPromises as flushVuePromises, mount as mountComponent } from "@vue/test-utils";

import { nextTick as nextVueTick } from "vue";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resourceUrl, resourceUrlReleases, resourceBridge, store } = vi.hoisted(() => ({
  resourceUrl: vi.fn(),
  resourceUrlReleases: [] as Array<ReturnType<typeof vi.fn>>,
  resourceBridge: { readImageMetadata: vi.fn() },
  store: {
    projectResourceGeneration: 1,
    presentation: {
      resources: { sprites: [] as any[], canvases: [] as any[] },
    },
  },
}));

vi.mock("@/core/resources", () => ({
  acquireResourceUrl: (
    bridge: unknown,
    resourceId: string,
    revision?: number,
    generation?: number,
  ) => {
    const release = vi.fn();
    resourceUrlReleases.push(release);
    return { url: resourceUrl(bridge, resourceId, revision, generation), release };
  },
}));

vi.mock("@/platform", () => ({ platformBridge: () => resourceBridge }));

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import CanvasReplayImplementation from "@/components/CanvasReplay.vue";

import {
  CanvasReplayBudget as ReplayBudget,
  createCanvasReplayRenderer as createRenderer,
  type CanvasReplayData,
} from "@/components/canvasReplayRenderer";

import {
  HtmlMeasurementScope as MeasurementScope,
  htmlMeasurementProjectionKey as measurementProjectionKey,
} from "@/components/htmlMeasurementProjection";

import type { FrontendBridge } from "@/core/types";

import { RuntimeCanvasPixelSampler as CanvasPixelSampler } from "@/components/canvasPixelSampler";

import { RuntimeServiceRequests as ServiceRequests } from "@/stores/runtimeServiceRequests";

import type { CanvasPixelQuery } from "@/core/runtimeServiceProtocol";

const CanvasReplay = CanvasReplayImplementation;
const flushPromises = flushVuePromises;
const mount = mountComponent;
const nextTick = nextVueTick;
const CanvasReplayBudget = ReplayBudget;
const createCanvasReplayRenderer = createRenderer;
const HtmlMeasurementScope = MeasurementScope;
const htmlMeasurementProjectionKey = measurementProjectionKey;
const RuntimeCanvasPixelSampler = CanvasPixelSampler;
const RuntimeServiceRequests = ServiceRequests;

async function settleReplay(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await flushPromises();
    await nextTick();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await Promise.resolve();
    await nextTick();
  }
  expect(predicate()).toBe(true);
}

/** Sparse Canvas API model. Writes drive reads; no expected ARGB is preloaded into getImageData. */
function pixelContext(canvas: HTMLCanvasElement) {
  const pixels = new Map<string, number[]>();
  const context: any = {
    canvas,
    fillStyle: "",
    globalCompositeOperation: "source-over",
    drawImage: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: vi.fn((image: ImageData, x: number, y: number) => {
      for (let row = 0; row < image.height; row += 1)
        for (let column = 0; column < image.width; column += 1) {
          const offset = (row * image.width + column) * 4;
          pixels.set(`${x + column},${y + row}`, [...image.data.slice(offset, offset + 4)]);
        }
    }),
    getImageData: vi.fn((x: number, y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1)
        for (let column = 0; column < width; column += 1)
          data.set(
            pixels.get(`${x + column},${y + row}`) ?? [0, 0, 0, 0],
            (row * width + column) * 4,
          );
      return { width, height, data };
    }),
    fillRect: vi.fn((x: number, y: number, width: number, height: number) => {
      const color: number[] | undefined = context.fillStyle.match(/[\d.]+/g)?.map(Number);
      if (!color || color.length !== 4) throw new Error("pixel model needs an rgba fillStyle");
      for (let row = y; row < y + height; row += 1)
        for (let column = x; column < x + width; column += 1) {
          const previous = pixels.get(`${column},${row}`) ?? [0, 0, 0, 0];
          const alpha = color[3] + (previous[3] / 255) * (1 - color[3]);
          const rgb = color
            .slice(0, 3)
            .map((value, channel) =>
              alpha === 0
                ? 0
                : Math.round(
                    (value * color[3] +
                      ((previous[channel] * previous[3]) / 255) * (1 - color[3])) /
                      alpha,
                  ),
            );
          pixels.set(`${column},${row}`, [...rgb, Math.round(alpha * 255)]);
        }
    }),
  };
  return context;
}

function pendingSpriteReplays() {
  return [{ name: "pending.png", revision: 1, frames: [{ resource_id: "pending.png" }] }];
}

function blockImageStage(stage: "metadata" | "url" | "bitmap" | "image", width = 2, height = 2) {
  let finish!: () => void;
  let started = false;
  let finished = false;
  const close = vi.fn();
  const cleared = vi.fn();
  const releaseIndex = resourceUrlReleases.length;
  resourceBridge.readImageMetadata.mockReset().mockImplementation(async () => {
    if (stage !== "metadata") return { width, height };
    started = true;
    return new Promise<{ width: number; height: number }>((resolve) => {
      finish = () => resolve({ width, height });
    });
  });
  resourceUrl.mockReset().mockImplementation(async () => {
    if (stage !== "url") return "blob:pending";
    started = true;
    return new Promise<string>((resolve) => {
      finish = () => resolve("blob:pending");
    });
  });
  vi.stubGlobal(
    "Image",
    class {
      private source = "";
      width = width;
      height = height;
      get src() {
        return this.source;
      }
      set src(value: string) {
        this.source = value;
        if (!value) cleared();
      }
      async decode() {
        if (stage !== "image") return;
        started = true;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    },
  );
  if (stage === "bitmap")
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => {
        started = true;
        return new Promise<ImageBitmap>((resolve) => {
          finish = () => resolve({ width, height, close } as unknown as ImageBitmap);
        });
      }),
    );
  const encoded = new Uint8Array(24);
  encoded.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(encoded.buffer).setUint32(8, 13);
  encoded.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(encoded.buffer).setUint32(16, width);
  new DataView(encoded.buffer).setUint32(20, height);
  const command =
    stage === "bitmap"
      ? { type: "load_encoded_image" as const, encoded: [...encoded] }
      : {
          type: "draw_sprite" as const,
          name: "pending.png",
          resource_revision: 1,
          destination: { x: 0, y: 0, width: 2, height: 2 },
        };
  return {
    command,
    close,
    cleared,
    started: () => started,
    finished: () => finished,
    urlRelease: () => resourceUrlReleases[releaseIndex],
    finish: () => {
      finished = true;
      finish();
    },
  };
}

export {
  CanvasReplay,
  CanvasReplayBudget,
  HtmlMeasurementScope,
  RuntimeCanvasPixelSampler,
  RuntimeServiceRequests,
  afterEach,
  beforeEach,
  blockImageStage,
  createCanvasReplayRenderer,
  describe,
  expect,
  flushPromises,
  htmlMeasurementProjectionKey,
  it,
  mount,
  nextTick,
  pendingSpriteReplays,
  pixelContext,
  resourceBridge,
  resourceUrl,
  resourceUrlReleases,
  settleReplay,
  store,
  vi,
  waitFor,
};
export type { CanvasPixelQuery, CanvasReplayData, FrontendBridge };
