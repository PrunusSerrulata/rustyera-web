import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
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

import CanvasReplay from "@/components/CanvasReplay.vue";
import {
  CanvasReplayBudget,
  createCanvasReplayRenderer,
  type CanvasReplayData,
} from "@/components/canvasReplayRenderer";
import type { FrontendBridge } from "@/core/types";
import { RuntimeCanvasPixelSampler } from "@/components/canvasPixelSampler";
import { RuntimeServiceRequests } from "@/stores/runtimeServiceRequests";
import type { CanvasPixelQuery } from "@/core/runtimeServiceProtocol";

describe("canvas resource replay", () => {
  const contexts: any[] = [];
  const contextsByCanvas = new WeakMap<HTMLCanvasElement, any>();

  beforeEach(() => {
    contexts.length = 0;
    store.projectResourceGeneration = 1;
    store.presentation.resources = { sprites: [], canvases: [] };
    resourceUrl.mockReset();
    resourceUrl.mockResolvedValue("blob:layer");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        width = 100;
        height = 100;
        decode = vi.fn().mockResolvedValue(undefined);
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const cached = contextsByCanvas.get(this);
      if (cached) return cached;
      const alphaStack: number[] = [];
      const context: any = {
        canvas: this,
        dimensionWrites: [] as string[],
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        drawnImages: [] as Array<{
          source: unknown;
          alpha: number;
          compositeOperation: string;
        }>,
        getImageData: vi.fn(),
        createImageData: vi.fn((width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        })),
        putImageData: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
      };
      context.drawImage = vi.fn((source: unknown) => {
        context.drawnImages.push({
          source,
          alpha: context.globalAlpha,
          compositeOperation: context.globalCompositeOperation,
        });
      });
      const compositeStack: string[] = [];
      context.save = vi.fn(() => {
        alphaStack.push(context.globalAlpha);
        compositeStack.push(context.globalCompositeOperation);
      });
      context.restore = vi.fn(() => {
        context.globalAlpha = alphaStack.pop() ?? context.globalAlpha;
        context.globalCompositeOperation = compositeStack.pop() ?? context.globalCompositeOperation;
      });
      let width = this.width;
      let height = this.height;
      Object.defineProperties(this, {
        width: {
          configurable: true,
          get: () => width,
          set: (value: number) => {
            context.dimensionWrites.push("width");
            width = Number(value);
          },
        },
        height: {
          configurable: true,
          get: () => height,
          set: (value: number) => {
            context.dimensionWrites.push("height");
            height = Number(value);
          },
        },
      });
      contexts.push(context);
      contextsByCanvas.set(this, context);
      return context as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("binds strict replay image metadata and resource URLs to the injected HTML resource bridge", async () => {
    const bridge = {
      readImageMetadata: vi.fn(async () => ({ width: 100, height: 100 })),
    } as unknown as FrontendBridge;
    const renderer = createCanvasReplayRenderer();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    try {
      await renderer.replay(
        context,
        {
          canvas_id: 1,
          revision: 7,
          size: { width: 10, height: 10 },
          commands: [
            {
              type: "draw_sprite",
              name: "frozen",
              destination: { x: 0, y: 0, width: 10, height: 10 },
            },
          ],
        },
        new Set([1]),
        { sprites: [{ name: "frozen", frames: [{ resource_id: "fixed.png" }] }] },
        91,
        {
          budget: new CanvasReplayBudget(),
          active: () => true,
          strict: true,
          resourceBridge: bridge,
        },
      );
      expect(bridge.readImageMetadata).toHaveBeenCalledWith("fixed.png");
      expect(resourceUrl).toHaveBeenCalledWith(bridge, "fixed.png", 7, 91);
      expect(contexts[0].drawnImages).toHaveLength(1);
    } finally {
      renderer.clear();
    }
  });

  it("checks HTML cancellation after metadata before acquiring a file-backed canvas source", async () => {
    let finish!: (value: { width: number; height: number }) => void;
    let active = true;
    const bridge = {
      readImageMetadata: vi.fn(
        () =>
          new Promise<{ width: number; height: number }>((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as FrontendBridge;
    const renderer = createCanvasReplayRenderer();
    const context = document.createElement("canvas").getContext("2d")!;
    const pending = renderer.replay(
      context,
      {
        canvas_id: 1,
        revision: 7,
        size: { width: 10, height: 10 },
        commands: [
          {
            type: "draw_sprite",
            name: "fixed.png",
            destination: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      },
      new Set([1]),
      {},
      91,
      {
        budget: new CanvasReplayBudget(),
        active: () => active,
        strict: true,
        resourceBridge: bridge,
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(() => vi.mocked(bridge.readImageMetadata).mock.calls.length === 1);
    active = false;
    finish({ width: 100, height: 100 });
    try {
      await rejected;
      expect(resourceUrl).not.toHaveBeenCalled();
    } finally {
      renderer.clear();
    }
  });

  it("keeps strict decoded images inside the same pixel budget as canvas surfaces", async () => {
    const budget = new CanvasReplayBudget();
    const releaseSurface = budget.reserve(8192, 8192);
    const bridge = {
      readImageMetadata: vi.fn(async () => ({ width: 100, height: 100 })),
    } as unknown as FrontendBridge;
    const renderer = createCanvasReplayRenderer();
    const context = document.createElement("canvas").getContext("2d")!;
    try {
      await expect(
        renderer.replay(
          context,
          {
            canvas_id: 1,
            revision: 7,
            size: { width: 10, height: 10 },
            commands: [
              {
                type: "draw_sprite",
                name: "fixed.png",
                destination: { x: 0, y: 0, width: 10, height: 10 },
              },
            ],
          },
          new Set([1]),
          {},
          91,
          { budget, active: () => true, strict: true, resourceBridge: bridge },
        ),
      ).rejects.toMatchObject({ category: "resource_limit" });
      expect(resourceUrl).not.toHaveBeenCalled();
    } finally {
      renderer.clear();
      releaseSurface();
    }
    const release = budget.reserve(8192, 8192);
    release();
  });

  it("holds pending bitmap pixels across request budgets and releases them after late cancellation", async () => {
    const pool = new CanvasReplayBudget();
    let finish!: (bitmap: ImageBitmap) => void;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const encoded = new Uint8Array(24);
    encoded.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(encoded.buffer).setUint32(8, 13);
    encoded.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(encoded.buffer).setUint32(16, 8192);
    new DataView(encoded.buffer).setUint32(20, 8192);
    const renderer = createCanvasReplayRenderer();
    const context = document.createElement("canvas").getContext("2d")!;
    let active = true;
    const pending = renderer.replay(
      context,
      {
        canvas_id: 1,
        revision: 1,
        size: { width: 10, height: 10 },
        commands: [{ type: "load_encoded_image", encoded: [...encoded] }],
      },
      new Set([1]),
      {},
      1,
      { budget: pool.fork(), active: () => active, strict: true },
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(() => vi.mocked(createImageBitmap).mock.calls.length === 1);
    active = false;
    renderer.clear();
    expect(() => pool.fork().reserve(1, 1)).toThrow("pixel budget");
    const close = vi.fn();
    finish({ width: 8192, height: 8192, close } as unknown as ImageBitmap);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(contexts[0].drawnImages).toHaveLength(0);
    const release = pool.fork().reserve(8192, 8192);
    release();
  });

  it("resolves GDRAWSPRITE names through sprite frames and crops their source", async () => {
    store.presentation.resources.sprites = [
      {
        name: "face-layer",
        frames: [
          {
            resource_id: "resources/face-layer.png",
            source_rectangle: [10, 20, 30, 40],
          },
        ],
      },
    ];
    mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 7,
          size: { width: 150n, height: 150n },
          commands: [
            {
              type: "draw_sprite",
              name: "FACE-LAYER",
              destination: { x: 4, y: 5, width: 60, height: 80 },
            },
          ],
        },
      },
    });
    await settleReplay();

    expect(resourceUrl).toHaveBeenCalledWith(resourceBridge, "resources/face-layer.png", 7, 1);
    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) =>
            call[0] instanceof Image && call.slice(1).join(",") === "10,20,30,40,4,5,60,80",
        ),
      ),
    ).toBe(true);
    // The direct no-transform path paints into the hidden persistent surface without allocating
    // a third full-size projection canvas.
    expect(contexts).toHaveLength(1);
  });

  it("recursively composites GDRAWG source canvases", async () => {
    store.presentation.resources.canvases = [
      {
        canvas_id: 2,
        revision: 3,
        size: { width: 20n, height: 10n },
        commands: [
          {
            type: "fill_rectangle",
            brush_argb: 0xffff0000n,
            rectangle: { x: 0n, y: 0n, width: 20n, height: 10n },
          },
        ],
      },
    ];
    mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 4,
          size: { width: 40n, height: 40n },
          commands: [
            {
              type: "draw_canvas",
              source_canvas_id: 2,
              source: { x: 0, y: 0, width: 20, height: 10 },
              destination: { x: 6, y: 7, width: 20, height: 10 },
              rotation_millidegrees: 0,
            },
          ],
        },
      },
    });
    await settleReplay();

    expect(contexts.some((context) => context.fillRect.mock.calls.length > 0)).toBe(true);
    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) => call[0] instanceof HTMLCanvasElement && call[5] === 6 && call[6] === 7,
        ),
      ),
    ).toBe(true);
  });

  it("hides its stable surface stack when its owner switches to a final image", async () => {
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: { canvas_id: 1, revision: 1, size: { width: 40, height: 40 }, commands: [] },
        visible: false,
      },
    });
    await settleReplay();
    expect(wrapper.get(".canvas-replay-stack").attributes("style")).toContain("display: none");

    await wrapper.setProps({ visible: true });
    expect(wrapper.get(".canvas-replay-stack").attributes("style") ?? "").not.toContain(
      "display: none",
    );
  });

  it("paints only the hidden surface before swapping at a frame boundary", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const replay = (revision: number): CanvasReplayData => ({
      canvas_id: 1,
      revision,
      size: { width: 40, height: 40 },
      commands: [
        {
          type: "fill_rectangle",
          brush_argb: 0xffff0000n,
          rectangle: { x: revision, y: 0, width: 20, height: 20 },
        },
      ],
    });
    const wrapper = mount(CanvasReplay, { props: { replay: replay(1) } });
    await waitFor(() => animationFrames.length === 1);
    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(false);

    animationFrames.shift()?.(0);
    await settleReplay();
    const firstVisible = wrapper.get("canvas.canvas-replay").element;
    const firstContext = contexts.find((context) => context.canvas === firstVisible);
    expect(firstContext.fillRect).toHaveBeenCalledOnce();
    expect(firstContext.drawnImages).toHaveLength(0);

    await wrapper.setProps({ replay: replay(2) });
    await waitFor(() => animationFrames.length === 1);
    expect(wrapper.get("canvas.canvas-replay").element).toBe(firstVisible);
    expect(firstContext.fillRect).toHaveBeenCalledOnce();
    const hidden = wrapper.findAll("canvas").find((surface) => surface.element !== firstVisible)!;
    const hiddenContext = contexts.find((context) => context.canvas === hidden.element);
    expect(hiddenContext.fillRect).toHaveBeenCalledOnce();

    animationFrames.shift()?.(16);
    await settleReplay();
    expect(wrapper.get("canvas.canvas-replay").element).toBe(hidden.element);
  });

  it("does not expose a prepared surface after the project generation changes", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 1,
          size: { width: 40, height: 40 },
          commands: [],
        },
      },
    });
    await waitFor(() => animationFrames.length === 1);
    store.projectResourceGeneration = 2;

    animationFrames.shift()?.(0);
    await settleReplay();

    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(false);
  });

  it("keeps the current surface visible when committing the back surface fails", async () => {
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 1,
          size: { width: 40, height: 40 },
          commands: [],
        },
      },
    });
    await settleReplay();
    const firstVisible = wrapper.get("canvas.canvas-replay").element;
    const hidden = wrapper.findAll("canvas").find((surface) => surface.element !== firstVisible)!;
    const hiddenContext = hidden.element.getContext("2d") as any;
    hiddenContext.fillRect.mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await wrapper.setProps({
      replay: {
        canvas_id: 1,
        revision: 2,
        size: { width: 40, height: 40 },
        commands: [
          {
            type: "fill_rectangle",
            brush_argb: 0xffff0000n,
            rectangle: { x: 0, y: 0, width: 40, height: 40 },
          },
        ],
      },
    });
    await settleReplay();

    expect(wrapper.get("canvas.canvas-replay").element).toBe(firstVisible);
  });

  it("serializes decoded frames and coalesces the pending animation backlog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decoders: Array<() => void> = [];
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        width = 100;
        height = 100;
        decode = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              decoders.push(resolve);
            }),
        );
      },
    );
    store.presentation.resources.sprites = [
      {
        name: "layer",
        frames: [
          {
            resource_id: "resources/layer.png",
            source_rectangle: [0, 0, 100, 100],
          },
        ],
      },
    ];
    const replay = (revision: number): CanvasReplayData => ({
      canvas_id: 1,
      revision,
      size: { width: 100, height: 100 },
      commands: [
        {
          type: "draw_sprite",
          name: "layer",
          destination: { x: revision, y: 0, width: 100, height: 100 },
        },
      ],
    });
    const wrapper = mount(CanvasReplay, { props: { replay: replay(1) } });
    await waitFor(() => decoders.length === 1);
    await wrapper.setProps({ replay: replay(2) });
    await wrapper.setProps({ replay: replay(3) });
    expect(decoders).toHaveLength(1);

    decoders[0]();
    await settleReplay();
    expect(decoders).toHaveLength(1);
    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(true);
    await wrapper.setProps({ replay: replay(4) });
    await settleReplay();

    const surfaces = wrapper.findAll("canvas").map((surface) => surface.element);
    const outputContexts = surfaces.map((surface) =>
      contexts.find((context) => context.canvas === surface),
    );
    const committedDestinations = outputContexts.flatMap((outputContext) =>
      outputContext.drawImage.mock.calls
        .filter((call: any[]) => call[0] instanceof Image)
        .map((call: any[]) => call[5]),
    );
    expect(committedDestinations.sort()).toEqual([3, 4]);
    expect(wrapper.get("canvas.canvas-replay").element).toBe(surfaces[1]);
    expect(surfaces[0].width).toBe(100);
    expect(decoders).toHaveLength(1);
    expect(resourceUrl).toHaveBeenCalledTimes(1);
    expect(outputContexts.every((context) => context.dimensionWrites.length >= 2)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("uses native canvas opacity for generated fade frames", async () => {
    store.presentation.resources.sprites = [
      {
        name: "portrait",
        frames: [
          {
            resource_id: "resources/portrait.png",
            source_rectangle: [0, 0, 100, 100],
          },
        ],
      },
    ];
    const matrix: number[] = Array.from({ length: 25 }, (_, index) =>
      [0, 6, 12, 18, 24].includes(index) ? 256 : 0,
    );
    matrix[18] = 128;

    mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 7,
          size: { width: 100, height: 100 },
          commands: [
            {
              type: "draw_sprite",
              name: "portrait",
              destination: { x: 0, y: 0, width: 100, height: 100 },
              color_matrix: matrix,
            },
          ],
        },
      },
    });
    await settleReplay();

    expect(
      contexts.some((context) =>
        context.drawnImages.some((draw: any) => draw.source instanceof Image && draw.alpha === 0.5),
      ),
    ).toBe(true);
    expect(contexts.every((context) => context.getImageData.mock.calls.length === 0)).toBe(true);
  });

  it("keeps the previous frame when decoding fails and retries the newest request", async () => {
    let brokenAttempts = 0;
    resourceUrl.mockImplementation(async (_bridge, resourceId) => `blob:${resourceId}`);
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        width = 100;
        height = 100;
        decode = vi.fn(async () => {
          if (this.src === "blob:broken" && brokenAttempts++ === 0)
            throw new Error("decode failed");
        });
      },
    );
    const replay = (revision: number, name: string): CanvasReplayData => ({
      canvas_id: 1,
      revision,
      size: { width: 100, height: 100 },
      commands: [
        {
          type: "draw_sprite",
          name,
          destination: { x: revision, y: 0, width: 100, height: 100 },
        },
      ],
    });
    store.presentation.resources.sprites = [
      {
        name: "stable",
        frames: [{ resource_id: "stable", source_rectangle: [0, 0, 100, 100] }],
      },
      {
        name: "broken",
        frames: [{ resource_id: "broken", source_rectangle: [0, 0, 100, 100] }],
      },
    ];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(CanvasReplay, { props: { replay: replay(1, "stable") } });
    await settleReplay();
    const committedFrames = () =>
      wrapper
        .findAll("canvas")
        .map((surface) => contexts.find((context) => context.canvas === surface.element))
        .filter(Boolean)
        .flatMap((context) => context.drawnImages);
    expect(committedFrames()).toHaveLength(1);

    await wrapper.setProps({ replay: replay(2, "broken") });
    await settleReplay();
    expect(committedFrames()).toHaveLength(1);

    await wrapper.setProps({ replay: replay(3, "broken") });
    await settleReplay();
    expect(committedFrames()).toHaveLength(2);
    expect(brokenAttempts).toBe(2);
  });

  it("rejects an in-flight frame from an obsolete project resource generation", async () => {
    const decoders: Array<() => void> = [];
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        width = 100;
        height = 100;
        decode = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              decoders.push(resolve);
            }),
        );
      },
    );
    store.presentation.resources.sprites = [
      {
        name: "layer",
        frames: [{ resource_id: "layer", source_rectangle: [0, 0, 100, 100] }],
      },
    ];
    const replay = (revision: number): CanvasReplayData => ({
      canvas_id: 1,
      revision,
      size: { width: 100, height: 100 },
      commands: [
        {
          type: "draw_sprite",
          name: "layer",
          destination: { x: revision, y: 0, width: 100, height: 100 },
        },
      ],
    });
    const wrapper = mount(CanvasReplay, { props: { replay: replay(1) } });
    await waitFor(() => decoders.length === 1);
    store.projectResourceGeneration = 2;
    await wrapper.setProps({ replay: replay(2) });

    decoders[0]();
    await waitFor(() => decoders.length === 2);
    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(false);

    decoders[1]();
    await settleReplay();
    const outputContext = contexts.find(
      (context) => context.canvas === wrapper.find("canvas").element,
    );
    expect(outputContext.drawnImages).toHaveLength(1);
  });

  it("releases both persistent backing surfaces on unmount", async () => {
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: { canvas_id: 1, revision: 1, size: { width: 320, height: 200 }, commands: [] },
      },
    });
    await settleReplay();
    const surfaces = wrapper.findAll("canvas").map((canvas) => canvas.element);

    wrapper.unmount();

    expect(surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
  });

  it("rejects oversized backing dimensions before assigning them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: { canvas_id: 1, revision: 1, size: { width: 8_193, height: 1 }, commands: [] },
      },
    });

    await settleReplay();

    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(false);
    expect(wrapper.findAll("canvas").every((surface) => surface.element.width === 0)).toBe(true);
  });

  it("closes an oversized decoded bitmap when its surface budget rejects it", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 8_193, height: 1, close })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 1,
          size: { width: 10, height: 10 },
          commands: [{ type: "load_encoded_image", encoded: [1, 2, 3] }],
        },
      },
    });

    await settleReplay();

    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects deeply nested canvas replay before allocating unbounded temporary surfaces", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const nested = Array.from({ length: 18 }, (_, index) => ({
      canvas_id: index + 2,
      revision: 1,
      size: { width: 10, height: 10 },
      commands:
        index === 17
          ? []
          : [
              {
                type: "draw_canvas" as const,
                source_canvas_id: index + 3,
                source: { x: 0, y: 0, width: 10, height: 10 },
                destination: { x: 0, y: 0, width: 10, height: 10 },
              },
            ],
    }));
    store.presentation.resources.canvases = nested;
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 1,
          revision: 1,
          size: { width: 10, height: 10 },
          commands: [
            {
              type: "draw_canvas",
              source_canvas_id: 2,
              source: { x: 0, y: 0, width: 10, height: 10 },
              destination: { x: 0, y: 0, width: 10, height: 10 },
            },
          ],
        },
      },
    });

    await settleReplay();

    expect(wrapper.find("canvas.canvas-replay").exists()).toBe(false);
    const temporary = contexts
      .map((context) => context.canvas as HTMLCanvasElement)
      .filter((surface) => !wrapper.findAll("canvas").some((item) => item.element === surface));
    expect(temporary.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
  });
});

describe("independent canvas pixel services", () => {
  const contexts: any[] = [];
  const query: CanvasPixelQuery = {
    context: { presentationRevision: 3, environmentRevision: 4, projectionSpaceRevision: 5 },
    canvasId: 7,
    canvasRevision: 8,
    x: 1,
    y: 1,
  };
  const replay = (): CanvasReplayData => ({
    canvas_id: 7,
    revision: 8,
    size: { width: 2, height: 2 },
    commands: [{ type: "set_pixel", point: { x: 1, y: 1 }, argb: 0x12345678 }],
  });
  const lease = () => {
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    return { requests, lease: requests.begin(1, 1) };
  };

  beforeEach(() => {
    contexts.length = 0;
    resourceUrl.mockReset().mockResolvedValue("blob:sample");
    resourceUrlReleases.length = 0;
    resourceBridge.readImageMetadata.mockReset().mockResolvedValue({ width: 2, height: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const context = pixelContext(this);
      contexts.push(context);
      return context as never;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replays an unmounted revision, returns ARGB and releases its independent backing surface", async () => {
    const sampler = new RuntimeCanvasPixelSampler();
    const { lease: request } = lease();
    expect(await sampler.sample(query, { canvases: [replay()] }, 1, request, () => true)).toBe(
      0x12345678,
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0].putImageData).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1,
        height: 1,
        data: Uint8ClampedArray.of(0x34, 0x56, 0x78, 0x12),
      }),
      1,
      1,
    );
    expect(contexts[0].canvas.isConnected).toBe(false);
    expect(contexts[0].getImageData).toHaveBeenCalledWith(1, 1, 1, 1);
    expect(contexts[0].canvas).toMatchObject({ width: 0, height: 0 });
  });

  it("rejects stale revisions, out-of-bounds pixels and excessive surfaces before allocation", async () => {
    for (const [changedQuery, canvas, category] of [
      [{ ...query, canvasRevision: 9 }, replay(), "stale_projection"],
      [{ ...query, x: 2 }, replay(), "invalid_request"],
      [query, { ...replay(), size: { width: 8193, height: 2 } }, "resource_limit"],
    ] as const) {
      await expect(
        new RuntimeCanvasPixelSampler().sample(
          changedQuery,
          { canvases: [canvas] },
          1,
          lease().lease,
          () => true,
        ),
      ).rejects.toMatchObject({ category });
    }
    expect(contexts).toHaveLength(0);
  });

  it("replaces semi-transparent pixels and clears transparent pixels without touching neighbors", async () => {
    // This is a deterministic Canvas API model, not evidence of browser premultiplication fidelity.
    const context = document.createElement("canvas").getContext("2d")!;
    const renderer = createCanvasReplayRenderer();
    const write = (argb: number, x = 0) => ({
      type: "set_pixel" as const,
      point: { x, y: 0 },
      argb,
    });
    const apply = (commands: NonNullable<CanvasReplayData["commands"]>) =>
      renderer.replay(context, { ...replay(), commands }, new Set([7]), {}, 1);
    await apply([write(0xff0000ff), write(0xff00ff00, 1)]);
    await apply([write(0x80ff0000)]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 128]);
    expect([...context.getImageData(1, 0, 1, 1).data]).toEqual([0, 255, 0, 255]);
    await apply([write(0)]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
    expect([...context.getImageData(1, 0, 1, 1).data]).toEqual([0, 255, 0, 255]);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.globalCompositeOperation).toBe("source-over");
    renderer.clear();
  });

  it.each(["metadata", "url", "bitmap", "image"] as const)(
    "cancel and resource changes release the logical queue while %s work is still pending",
    async (stage) => {
      for (const reason of ["cancel", "resource"] as const) {
        const blocked = blockImageStage(stage);
        const sampler = new RuntimeCanvasPixelSampler();
        const requests = new RuntimeServiceRequests();
        requests.enterEpoch(1);
        const oldContext = contexts.length;
        const pending = sampler.sample(
          query,
          { canvases: [{ ...replay(), commands: [blocked.command] }] },
          1,
          requests.begin(1, 1),
          () => true,
        );
        const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
        await waitFor(blocked.started);
        if (reason === "cancel") requests.cancel(1);
        else sampler.clear();
        // No decoder completion is allowed before these assertions: cancellation itself must settle.
        await rejected;
        expect(blocked.finished()).toBe(false);
        expect(contexts[oldContext].canvas).toMatchObject({ width: 0, height: 0 });
        expect(
          await sampler.sample(
            query,
            { canvases: [replay()] },
            2,
            requests.begin(2, 1),
            () => true,
          ),
        ).toBe(0x12345678);
        expect(contexts[oldContext].getImageData).not.toHaveBeenCalled();
        if (stage === "url" || stage === "image")
          expect(blocked.urlRelease()).not.toHaveBeenCalled();
        blocked.finish();
        await settleReplay();
        expect(blocked.finished()).toBe(true);
        expect(contexts[oldContext].getImageData).not.toHaveBeenCalled();
        expect(contexts[oldContext].drawImage).not.toHaveBeenCalled();
        if (stage === "bitmap") expect(blocked.close).toHaveBeenCalledOnce();
        if (stage === "url" || stage === "image")
          expect(blocked.urlRelease()).toHaveBeenCalledOnce();
        if (stage === "image") expect(blocked.cleared).toHaveBeenCalledOnce();
        sampler.clear();
        if (stage === "image") expect(blocked.cleared).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["bitmap", "image"] as const)(
    "late retired %s completion cannot clear a newer request's surface or renderer",
    async (stage) => {
      const old = blockImageStage(stage);
      const sampler = new RuntimeCanvasPixelSampler();
      const requests = new RuntimeServiceRequests();
      requests.enterEpoch(1);
      const pending = sampler.sample(
        query,
        { canvases: [{ ...replay(), commands: [old.command] }] },
        1,
        requests.begin(1, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(old.started);
      requests.cancel(1);
      await rejected;
      const newer = blockImageStage("bitmap");
      const following = sampler.sample(
        query,
        { canvases: [{ ...replay(), commands: [newer.command, ...replay().commands!] }] },
        2,
        requests.begin(2, 1),
        () => true,
      );
      await waitFor(newer.started);
      old.finish();
      await settleReplay();
      if (stage === "bitmap") expect(old.close).toHaveBeenCalledOnce();
      else {
        expect(old.cleared).toHaveBeenCalledOnce();
        expect(old.urlRelease()).toHaveBeenCalledOnce();
      }
      expect(contexts[1].canvas).toMatchObject({ width: 2, height: 2 });
      expect(newer.close).not.toHaveBeenCalled();
      newer.finish();
      await expect(following).resolves.toBe(0x12345678);
      expect(newer.close).toHaveBeenCalledOnce();
      expect(contexts[0].getImageData).not.toHaveBeenCalled();
      expect(contexts[1].getImageData).toHaveBeenCalledOnce();
    },
  );

  it.each(["url", "bitmap", "image"] as const)(
    "keeps pending %s pixels charged across generations until physical completion",
    async (stage) => {
      const blocked = blockImageStage(stage, 8192, 8191);
      const sampler = new RuntimeCanvasPixelSampler();
      const requests = new RuntimeServiceRequests();
      requests.enterEpoch(1);
      const pending = sampler.sample(
        query,
        { canvases: [{ ...replay(), commands: [blocked.command] }] },
        1,
        requests.begin(1, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(blocked.started);
      sampler.clear();
      await rejected;
      const large = { ...replay(), size: { width: 4096, height: 4096 } };
      await expect(
        sampler.sample(query, { canvases: [large] }, 2, requests.begin(2, 1), () => true),
      ).rejects.toMatchObject({ category: "resource_limit" });
      expect(
        await sampler.sample(query, { canvases: [replay()] }, 2, requests.begin(3, 1), () => true),
      ).toBe(0x12345678);
      blocked.finish();
      await settleReplay();
      await expect(
        sampler.sample(query, { canvases: [large] }, 3, requests.begin(4, 1), () => true),
      ).resolves.toBe(0x12345678);
    },
  );

  it("caps unfinished metadata operations across cancellation and generation changes", async () => {
    const sampler = new RuntimeCanvasPixelSampler();
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    const pendingMetadata: Array<ReturnType<typeof blockImageStage>> = [];
    for (let id = 1; id <= 32; id += 1) {
      const blocked = blockImageStage("metadata");
      pendingMetadata.push(blocked);
      const pending = sampler.sample(
        query,
        { canvases: [{ ...replay(), commands: [blocked.command] }] },
        id,
        requests.begin(id, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(blocked.started);
      sampler.clear();
      await rejected;
      requests.cancel(id);
    }
    const overflow = blockImageStage("metadata");
    await expect(
      sampler.sample(
        query,
        { canvases: [{ ...replay(), commands: [overflow.command] }] },
        33,
        requests.begin(33, 1),
        () => true,
      ),
    ).rejects.toMatchObject({ category: "resource_limit" });
    expect(overflow.started()).toBe(false);
    // Unknown image sizes charge decoder count without inventing a pixel estimate.
    await expect(
      sampler.sample(query, { canvases: [replay()] }, 33, requests.begin(34, 1), () => true),
    ).resolves.toBe(0x12345678);
    pendingMetadata.forEach((blocked) => blocked.finish());
    await settleReplay();
    const recovered = blockImageStage("metadata");
    const pending = sampler.sample(
      query,
      { canvases: [{ ...replay(), commands: [recovered.command] }] },
      34,
      requests.begin(35, 1),
      () => true,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(recovered.started);
    requests.cancel(35);
    await rejected;
    recovered.finish();
    await settleReplay();
  });

  it("bounds logical decoder waits but retains their pixels until late completion", async () => {
    vi.useFakeTimers();
    const blocked = blockImageStage("bitmap", 8192, 8191);
    const sampler = new RuntimeCanvasPixelSampler();
    const pending = sampler.sample(
      query,
      { canvases: [{ ...replay(), commands: [blocked.command] }] },
      1,
      lease().lease,
      () => true,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "backend_failure" });
    await waitFor(blocked.started);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(blocked.finished()).toBe(false);
    await expect(
      sampler.sample(
        query,
        { canvases: [{ ...replay(), size: { width: 4096, height: 4096 } }] },
        2,
        lease().lease,
        () => true,
      ),
    ).rejects.toMatchObject({ category: "resource_limit" });
    blocked.finish();
    await waitFor(() => blocked.close.mock.calls.length === 1);
    await expect(
      sampler.sample(query, { canvases: [replay()] }, 2, lease().lease, () => true),
    ).resolves.toBe(0x12345678);
  });

  it("rejects changed projections after asynchronous decoding without reading stale pixels", async () => {
    const blocked = blockImageStage("bitmap");
    let current = true;
    const sampler = new RuntimeCanvasPixelSampler();
    const pending = sampler.sample(
      query,
      { canvases: [{ ...replay(), commands: [blocked.command] }] },
      1,
      lease().lease,
      () => current,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(blocked.started);
    current = false;
    blocked.finish();
    await rejected;
    expect(blocked.close).toHaveBeenCalledOnce();
    expect(contexts[0].getImageData).not.toHaveBeenCalled();
  });

  it("reports unavailable contexts as backend failure", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    await expect(
      new RuntimeCanvasPixelSampler().sample(
        query,
        { canvases: [replay()] },
        1,
        lease().lease,
        () => true,
      ),
    ).rejects.toMatchObject({ category: "backend_failure" });
  });
});

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
