import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resourceUrl, store } = vi.hoisted(() => ({
  resourceUrl: vi.fn(),
  store: {
    projectResourceGeneration: 1,
    presentation: {
      resources: { sprites: [] as any[], canvases: [] as any[] },
    },
  },
}));

vi.mock("@/core/resources", () => ({ resourceUrl }));
vi.mock("@/platform", () => ({ platformBridge: () => ({}) }));
vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import CanvasReplay from "@/components/CanvasReplay.vue";

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

    expect(resourceUrl).toHaveBeenCalledWith({}, "resources/face-layer.png", 7, 1);
    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) =>
            call[0] instanceof Image && call.slice(1).join(",") === "10,20,30,40,0,0,60,80",
        ),
      ),
    ).toBe(true);
    expect(
      contexts.some((context) =>
        context.drawImage.mock.calls.some(
          (call: any[]) => call[0] instanceof HTMLCanvasElement && call[1] === 4 && call[2] === 5,
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
          (call: any[]) => call[0] instanceof HTMLCanvasElement && call[1] === 6 && call[2] === 7,
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
    const replay = (revision: number) => ({
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
    expect(firstContext.drawnImages).toHaveLength(1);

    await wrapper.setProps({ replay: replay(2) });
    await waitFor(() => animationFrames.length === 1);
    expect(wrapper.get("canvas.canvas-replay").element).toBe(firstVisible);
    expect(firstContext.drawnImages).toHaveLength(1);
    const hidden = wrapper.findAll("canvas").find((surface) => surface.element !== firstVisible)!;
    const hiddenContext = contexts.find((context) => context.canvas === hidden.element);
    expect(hiddenContext.drawnImages).toHaveLength(1);

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
    hiddenContext.drawImage.mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await wrapper.setProps({
      replay: {
        canvas_id: 1,
        revision: 2,
        size: { width: 40, height: 40 },
        commands: [],
      },
    });
    await settleReplay();

    expect(wrapper.get("canvas.canvas-replay").element).toBe(firstVisible);
  });

  it("serializes decoded frames and coalesces the pending animation backlog", async () => {
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
    const replay = (revision: number) => ({
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
    await wrapper.setProps({ replay: replay(4) });
    await settleReplay();

    const surfaces = wrapper.findAll("canvas").map((surface) => surface.element);
    const outputContexts = surfaces.map((surface) =>
      contexts.find((context) => context.canvas === surface),
    );
    const committedDestinations = outputContexts.map((outputContext) =>
      outputContext.drawnImages.map((draw: any) => {
        const projected = contexts.find((context) => context.canvas === draw.source);
        return projected.drawImage.mock.calls.find(
          (call: any[]) => call[0] instanceof HTMLCanvasElement,
        )[1];
      }),
    );
    expect(committedDestinations).toEqual([[1, 3], [4]]);
    expect(wrapper.get("canvas.canvas-replay").element).toBe(surfaces[1]);
    expect(surfaces[0].width).toBe(100);
    expect(decoders).toHaveLength(1);
    expect(resourceUrl).toHaveBeenCalledTimes(1);
    expect(outputContexts.every((context) => context.dimensionWrites.length === 0)).toBe(true);
    expect(
      outputContexts.every((context) =>
        context.drawnImages.every((draw: any) => draw.compositeOperation === "copy"),
      ),
    ).toBe(true);
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
    const replay = (revision: number, name: string) => ({
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
    const replay = (revision: number) => ({
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
    expect(contexts.some((context) => context.canvas === wrapper.find("canvas").element)).toBe(
      false,
    );

    decoders[1]();
    await settleReplay();
    const outputContext = contexts.find(
      (context) => context.canvas === wrapper.find("canvas").element,
    );
    expect(outputContext.drawnImages).toHaveLength(1);
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
