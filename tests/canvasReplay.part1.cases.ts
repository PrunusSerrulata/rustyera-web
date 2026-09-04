import {
  CanvasReplay,
  CanvasReplayBudget,
  HtmlMeasurementScope,
  afterEach,
  beforeEach,
  createCanvasReplayRenderer,
  describe,
  expect,
  htmlMeasurementProjectionKey,
  it,
  mount,
  resourceBridge,
  resourceUrl,
  settleReplay,
  store,
  vi,
  waitFor,
} from "./canvasReplay.testHarness";
import type { CanvasReplayData, FrontendBridge } from "./canvasReplay.testHarness";

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

  it("replays the canonical polygon point list for draw, fill and clear", async () => {
    const renderer = createCanvasReplayRenderer();
    const context = document.createElement("canvas").getContext("2d")!;
    await renderer.replay(
      context,
      {
        canvas_id: 1,
        revision: 1,
        size: { width: 20, height: 20 },
        commands: [
          { type: "set_pen", argb: 0xff112233, width: 1_000 },
          { type: "set_brush", argb: 0xff445566 },
          { type: "polygon_point_add", point: { x: 1, y: 2 } },
          { type: "polygon_point_add", point: { x: 3, y: 4 } },
          { type: "draw_polygon" },
          { type: "fill_polygon" },
          { type: "polygon_point_clear" },
          { type: "draw_polygon" },
        ],
      },
      new Set([1]),
      {},
      1,
    );
    const projected = contexts[0];
    expect(projected.moveTo).toHaveBeenCalledWith(1, 2);
    expect(projected.lineTo).toHaveBeenCalledWith(3, 4);
    expect(projected.closePath).toHaveBeenCalledTimes(2);
    expect(projected.stroke).toHaveBeenCalledTimes(2);
    expect(projected.fill).toHaveBeenCalledOnce();
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
              resource_revision: 7,
              destination: { x: 0, y: 0, width: 10, height: 10 },
            },
          ],
        },
        new Set([1]),
        { sprites: [{ name: "frozen", revision: 7, frames: [{ resource_id: "fixed.png" }] }] },
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
            resource_revision: 7,
            destination: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      },
      new Set([1]),
      { sprites: [{ name: "fixed.png", revision: 7, frames: [{ resource_id: "fixed.png" }] }] },
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
                resource_revision: 7,
                destination: { x: 0, y: 0, width: 10, height: 10 },
              },
            ],
          },
          new Set([1]),
          { sprites: [{ name: "fixed.png", revision: 7, frames: [{ resource_id: "fixed.png" }] }] },
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

  it.each([false, true])(
    "holds pending bitmap pixels across late cancellation with bigint=%s",
    async (wasm) => {
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
          commands: [
            {
              type: "load_encoded_image",
              encoded: wasm ? Array.from(encoded, BigInt) : [...encoded],
            },
          ],
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
    },
  );

  it.each([-1n, 256n, "1"])("rejects encoded canvas byte %s before decoding", async (byte) => {
    const renderer = createCanvasReplayRenderer();
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const context = document.createElement("canvas").getContext("2d")!;
    try {
      await expect(
        renderer.replay(
          context,
          {
            canvas_id: 1,
            revision: 1,
            size: { width: 2, height: 2 },
            commands: [{ type: "load_encoded_image", encoded: [byte] as any }],
          },
          new Set([1]),
          {},
          1,
          { budget: new CanvasReplayBudget(), active: () => true, strict: true },
        ),
      ).rejects.toMatchObject({ category: "invalid_request" });
      expect(decode).not.toHaveBeenCalled();
    } finally {
      renderer.clear();
    }
  });

  it("accounts retained HTML canvas surfaces together until the measurement is disposed", async () => {
    const viewport = document.createElement("section");
    Object.defineProperties(viewport, {
      clientWidth: { value: 320 },
      clientHeight: { value: 200 },
    });
    document.body.append(viewport);
    const base = {
      foreground: { red: 0, green: 0, blue: 0, alpha: 255 },
      bold: false,
      italic: false,
      underline: false,
      strikeout: false,
      font_millipixels: 16000,
    };
    const scope = new HtmlMeasurementScope(
      {
        viewport,
        viewportSize: { width: 320, height: 200 },
        context: { presentationRevision: 1, environmentRevision: 2, projectionSpaceRevision: 3 },
        resources: { sprites: [], canvases: [] },
        resourceGeneration: 7,
        preferences: { fontFamilyOverride: null, fontSizeOverridePx: null, imageScale: 1 },
        replaceFullWidthSpaces: false,
        resourceBridge: {} as FrontendBridge,
      },
      { current: base, base, settings: { line_height: 17000 } },
      { signal: new AbortController().signal, assertCurrent() {} },
    );
    const wrappers = Array.from({ length: 3 }, (_, index) =>
      mount(CanvasReplay, {
        props: {
          replay: {
            canvas_id: index + 1,
            revision: 1,
            size: { width: 5000, height: 5000 },
            commands: [],
          },
        },
        global: { provide: { [htmlMeasurementProjectionKey as symbol]: scope } },
      }),
    );
    try {
      await expect(scope.settle()).rejects.toMatchObject({ category: "resource_limit" });
    } finally {
      wrappers.forEach((wrapper) => wrapper.unmount());
      scope.dispose();
      viewport.remove();
    }
    expect(
      contexts.every((context) => context.canvas.width === 0 && context.canvas.height === 0),
    ).toBe(true);
  });

  it("resolves GDRAWSPRITE names through sprite frames and crops their source", async () => {
    store.presentation.resources.sprites = [
      {
        name: "face-layer",
        revision: 6,
        frames: [{ resource_id: "resources/stale-face.png" }],
      },
      {
        name: "face-layer",
        revision: 7,
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
              resource_revision: 7,
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

  it("applies Snake sprite frame offsets when replaying GDRAWSPRITE", async () => {
    store.presentation.resources.sprites = [
      {
        name: "30_FACEPARTS_01",
        revision: 9,
        size: [77, 51],
        position: [0, 0],
        frames: [
          {
            resource_id: "resources/eiki-parts.webp",
            source_rectangle: [470, 55, 77, 51],
            offset: [99, 76],
          },
        ],
      },
    ];
    mount(CanvasReplay, {
      props: {
        replay: {
          canvas_id: 320,
          revision: 2,
          size: { width: 270, height: 270 },
          commands: [
            {
              type: "draw_sprite",
              name: "30_FACEPARTS_01",
              resource_revision: 9,
              destination: { x: 0, y: 0, width: 77, height: 51 },
            },
            {
              type: "draw_sprite",
              name: "30_FACEPARTS_01",
              resource_revision: 9,
              destination: { x: 4, y: 5, width: 154, height: 102 },
            },
          ],
        },
      },
    });
    await settleReplay();

    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) =>
            call[0] instanceof Image && call.slice(1).join(",") === "470,55,77,51,99,76,77,51",
        ),
      ),
    ).toBe(true);
    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) =>
            call[0] instanceof Image && call.slice(1).join(",") === "470,55,77,51,202,157,154,102",
        ),
      ),
    ).toBe(true);
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
              source_revision: 3,
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
});
