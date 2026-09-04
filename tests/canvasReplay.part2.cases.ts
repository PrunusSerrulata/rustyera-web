import {
  CanvasReplay,
  afterEach,
  beforeEach,
  createCanvasReplayRenderer,
  describe,
  expect,
  it,
  mount,
  resourceUrl,
  settleReplay,
  store,
  vi,
  waitFor,
} from "./canvasReplay.testHarness";
import type { CanvasReplayData } from "./canvasReplay.testHarness";

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
        closePath: vi.fn(),
        fill: vi.fn(),
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

  it("retains the old frame when an exact draw_canvas source revision is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(CanvasReplay, {
      props: {
        replay: { canvas_id: 1, revision: 1, size: { width: 10, height: 10 }, commands: [] },
      },
    });
    await settleReplay();
    const firstVisible = wrapper.get("canvas.canvas-replay").element;
    store.presentation.resources.canvases = [
      { canvas_id: 2, revision: 1, size: { width: 10, height: 10 }, commands: [] },
    ];
    await wrapper.setProps({
      replay: {
        canvas_id: 1,
        revision: 2,
        size: { width: 10, height: 10 },
        commands: [
          {
            type: "draw_canvas",
            source_canvas_id: 2,
            source_revision: 2,
            source: { x: 0, y: 0, width: 10, height: 10 },
            destination: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      },
    });
    await settleReplay();
    expect(wrapper.get("canvas.canvas-replay").element).toBe(firstVisible);
  });

  it("requires an exact mask revision whenever draw_canvas names a mask", async () => {
    const renderer = createCanvasReplayRenderer();
    const context = document.createElement("canvas").getContext("2d")!;
    await expect(
      renderer.replay(
        context,
        {
          canvas_id: 1,
          revision: 2,
          size: { width: 10, height: 10 },
          commands: [
            {
              type: "draw_canvas",
              source_canvas_id: 2,
              source_revision: 1,
              mask_canvas_id: 3,
              source: { x: 0, y: 0, width: 10, height: 10 },
              destination: { x: 0, y: 0, width: 10, height: 10 },
            },
          ],
        },
        new Set([1]),
        {
          canvases: [
            { canvas_id: 2, revision: 1, size: { width: 10, height: 10 }, commands: [] },
            { canvas_id: 3, revision: 4, size: { width: 10, height: 10 }, commands: [] },
          ],
        },
        1,
      ),
    ).rejects.toMatchObject({ category: "invalid_request" });
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
        revision: 1,
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
          resource_revision: 1,
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
        revision: 7,
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
              resource_revision: 7,
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
          resource_revision: 1,
          destination: { x: revision, y: 0, width: 100, height: 100 },
        },
      ],
    });
    store.presentation.resources.sprites = [
      {
        name: "stable",
        revision: 1,
        frames: [{ resource_id: "stable", source_rectangle: [0, 0, 100, 100] }],
      },
      {
        name: "broken",
        revision: 1,
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
        revision: 1,
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
          resource_revision: 1,
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
                source_revision: 1,
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
              source_revision: 1,
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
