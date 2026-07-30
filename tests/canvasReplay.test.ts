import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resourceUrl, store } = vi.hoisted(() => ({
  resourceUrl: vi.fn(),
  store: {
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

  beforeEach(() => {
    contexts.length = 0;
    store.presentation.resources = { sprites: [], canvases: [] };
    resourceUrl.mockReset();
    resourceUrl.mockResolvedValue("blob:layer");
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
      const context = {
        canvas: this,
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
      };
      contexts.push(context);
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

    expect(resourceUrl).toHaveBeenCalledWith({}, "resources/face-layer.png", 7);
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

  it("commits a decoded frame while a newer replay is still loading", async () => {
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
          destination: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    });
    const wrapper = mount(CanvasReplay, { props: { replay: replay(1) } });
    await waitFor(() => decoders.length === 1);
    await wrapper.setProps({ replay: replay(2) });
    await waitFor(() => decoders.length === 2);

    decoders[0]();
    await settleReplay();

    const output = wrapper.find("canvas").element;
    expect(
      contexts.some(
        (context) => context.canvas === output && context.drawImage.mock.calls.length > 0,
      ),
    ).toBe(true);

    decoders[1]();
    await settleReplay();
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
