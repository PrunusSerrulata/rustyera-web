import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ResourceUrl = (
  bridge: unknown,
  resourceId: string,
  revision?: number,
  generation?: number,
) => Promise<string>;

const resourceUrl = vi.hoisted(() => vi.fn<ResourceUrl>(async () => "blob:era-image"));
const releaseResourceUrl = vi.hoisted(() => vi.fn());
const store = reactive({
  projectResourceGeneration: 0,
  presentation: {
    resources: {
      sprites: [
        {
          name: "TW_TITLE000",
          size: [1041, 16],
          frames: [
            {
              resource_id: "resources/title.webp",
              source_rectangle: [0, 16, 1041, 16],
            },
          ],
        },
      ] as any[],
      canvases: [] as any[],
    },
  },
  effectivePreferences: { imageScale: 1 },
  gameTextStyle: { fontSizePx: 12 },
});

vi.mock("@/core/resources", () => ({
  acquireResourceUrl: (...parameters: Parameters<ResourceUrl>) => ({
    url: resourceUrl(...parameters),
    release: releaseResourceUrl,
  }),
}));
vi.mock("@/platform", () => ({ platformBridge: () => ({}) }));
vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import MediaImage from "@/components/MediaImage.vue";

const canvasReplayStub = {
  props: ["visible"],
  template: '<canvas class="canvas-replay-test" :data-visible="String(visible)" />',
};

describe("Era sprite images", () => {
  beforeEach(() => {
    releaseResourceUrl.mockClear();
    store.projectResourceGeneration = 0;
    store.effectivePreferences.imageScale = 1;
    store.presentation.resources.sprites = [
      {
        name: "TW_TITLE000",
        size: [1041, 16],
        frames: [
          {
            resource_id: "resources/title.webp",
            source_rectangle: [0, 16, 1041, 16],
          },
        ],
      },
    ];
    store.presentation.resources.canvases = [];
    resourceUrl.mockReset();
    resourceUrl.mockResolvedValue("blob:era-image");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads a file-backed image when the project resource generation changes", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "TW_TITLE000",
          width: 0,
          height: 16_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 3,
        },
      },
    });
    await flushPromises();

    store.projectResourceGeneration = 1;
    await flushPromises();

    expect(resourceUrl).toHaveBeenNthCalledWith(1, {}, "resources/title.webp", 3, 0);
    expect(resourceUrl).toHaveBeenNthCalledWith(2, {}, "resources/title.webp", 3, 1);
    expect(releaseResourceUrl).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(releaseResourceUrl).toHaveBeenCalledTimes(2);
  });

  it("builds a stable resource identity from WebAssembly bigint coordinates", async () => {
    store.presentation.resources.sprites = [
      {
        name: "TW_TITLE000",
        size: [1041, 16],
        frames: [
          {
            resource_id: "resources/title.webp",
            source_rectangle: [0n, 16n, 1041n, 16n],
          },
        ],
      },
    ];
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "TW_TITLE000",
          width: 0n,
          height: 16_000n,
          depth: 0n,
          opacity: { numerator: 1n, denominator: 1n },
          revision: 3n,
        },
      },
    });

    await flushPromises();

    expect(resourceUrl).toHaveBeenCalledWith({}, "resources/title.webp", 3n, 0);
    expect(wrapper.get<HTMLElement>(".media-sprite").attributes("style")).toContain(
      "width: 1041px",
    );
  });

  it("matches sprite names case-insensitively and crops the source sheet", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "TW_title000",
          width: 0,
          height: 16_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 3,
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const sprite = slot.get<HTMLElement>(".media-sprite");
    const image = sprite.get<HTMLImageElement>("img");
    expect(resourceUrl).toHaveBeenCalledWith({}, "resources/title.webp", 3, 0);
    expect(slot.attributes("style")).toContain("height: 16px");
    expect(sprite.attributes("style")).toContain("width: 1041px");
    expect(sprite.attributes("style")).toContain("height: 16px");
    expect(sprite.attributes("style")).toContain("top: 0px");
    expect(image.attributes("style")).toContain("top: -16px");
  });

  it("scales PRINT_IMG sprites to the runtime line height while preserving aspect ratio", async () => {
    store.presentation.resources.sprites = [
      {
        name: "女性",
        size: [64, 64],
        frames: [
          {
            resource_id: "resources/female.png",
            source_rectangle: [0, 0, 64, 64],
          },
        ],
      },
    ];
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "女性",
          width: 0,
          height: 12_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 4,
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const visual = slot.get<HTMLElement>(".media-visual");
    expect(slot.attributes("style")).toContain("width: 12px");
    expect(slot.attributes("style")).toContain("height: 12px");
    expect(visual.attributes("style")).toContain("width: 12px");
    expect(visual.attributes("style")).toContain("height: 12px");
    expect(visual.attributes("style")).toContain("top: 0px");
  });

  it("keeps ypos images on one console row while drawing beyond it", async () => {
    store.presentation.resources.sprites = [
      {
        name: "钟表_09_00",
        size: [100, 100],
        frames: [
          {
            resource_id: "resources/tokei.webp",
            source_rectangle: [0, 900, 100, 100],
          },
        ],
      },
    ];
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "钟表_09_00",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 4,
          requested_height: { unit: "font_height_hundredths", value: 500 },
          requested_y: { unit: "font_height_hundredths", value: 201 },
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const visual = slot.get<HTMLElement>(".media-visual");
    expect(slot.attributes("style")).toContain("width: 60px");
    expect(slot.attributes("style")).toContain("height: 20px");
    expect(visual.attributes("style")).toContain("height: 60px");
    expect(visual.attributes("style")).toContain("top: 24.12px");
  });

  it("preserves a negative ypos offset", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "钟表_09_00",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_height: { unit: "pixels", value: 100 },
          requested_y: { unit: "pixels", value: -4 },
        },
      },
    });
    await flushPromises();

    expect(wrapper.get<HTMLElement>(".media-visual").attributes("style")).toContain("top: -4px");
  });

  it("flips a negative requested width inside its positive-width line slot", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_width: { unit: "pixels", value: -64 },
          requested_height: { unit: "pixels", value: 48 },
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    expect(slot.attributes("style")).toContain("width: 64px");
    expect(getComputedStyle(slot.element).transform).toBe("scaleX(-1)");
    expect(wrapper.get<HTMLElement>(".media-visual").attributes("style")).toContain("width: 64px");
  });

  it("does not flip a positive requested width", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_width: { unit: "pixels", value: 64 },
          requested_height: { unit: "pixels", value: 48 },
        },
      },
    });
    await flushPromises();

    expect(getComputedStyle(wrapper.get(".media-positioned").element).transform).toBe("");
  });

  it("flips a negative requested height without moving its positioned line slot", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_width: { unit: "pixels", value: 64 },
          requested_height: { unit: "pixels", value: -48 },
          requested_y: { unit: "pixels", value: 12 },
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const visual = wrapper.get<HTMLElement>(".media-visual");
    expect(getComputedStyle(slot.element).transform).toBe("");
    expect(visual.attributes("style")).toContain("height: 48px");
    expect(visual.attributes("style")).toContain("top: 12px");
    expect(getComputedStyle(visual.element).transform).toBe("scaleY(-1)");
  });

  it("keeps sprite cropping transforms separate from combined axis flips", async () => {
    store.presentation.resources.sprites = [
      {
        name: "portrait",
        size: [100, 100],
        frames: [{ resource_id: "portrait.webp", source_rectangle: [10, 20, 100, 100] }],
      },
    ];
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 20_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_width: { unit: "pixels", value: -64 },
          requested_height: { unit: "pixels", value: -48 },
        },
      },
    });
    await flushPromises();

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const visual = wrapper.get<HTMLElement>(".media-visual");
    const image = visual.get<HTMLElement>("img");
    expect(getComputedStyle(slot.element).transform).toBe("scaleX(-1)");
    expect(getComputedStyle(visual.element).transform).toBe("scaleY(-1)");
    expect(image.attributes("style")).toContain("transform: scale(0.64, 0.48)");
  });

  it("marks ypos=-height images for Emuera bottom-row anchoring", async () => {
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 12_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_height: { unit: "font_height_hundredths", value: 3000 },
          requested_y: { unit: "font_height_hundredths", value: -3000 },
        },
      },
    });
    await flushPromises();

    expect(wrapper.get(".media-positioned").attributes("style")).toContain(
      "--media-row-offset: -12px",
    );
    expect(wrapper.get(".media-visual").classes()).toContain("media-bottom-anchored");
  });

  it("does not scale the console-row slot reserved by an escaped image", async () => {
    store.effectivePreferences.imageScale = 2;
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 12_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_height: { unit: "pixels", value: 48 },
          requested_y: { unit: "pixels", value: -48 },
        },
      },
    });
    await flushPromises();

    expect(wrapper.get(".media-positioned").attributes("style")).toContain("height: 12px");
    expect(wrapper.get(".media-positioned").attributes("style")).toContain(
      "--media-row-offset: -12px",
    );
    expect(wrapper.get(".media-visual").attributes("style")).toContain("height: 96px");
  });

  it("keeps scaling the layout slot of an ordinary positioned image", async () => {
    store.effectivePreferences.imageScale = 2;
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 12_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 5,
          requested_height: { unit: "pixels", value: 48 },
        },
      },
    });
    await flushPromises();

    expect(wrapper.get(".media-positioned").attributes("style")).toContain("height: 24px");
    expect(wrapper.get(".media-positioned").attributes("style")).toContain(
      "--media-row-offset: -24px",
    );
    expect(wrapper.get(".media-visual").attributes("style")).toContain("height: 96px");
  });

  it("keeps the full positioned visual mounted while loading its hover image", async () => {
    store.presentation.resources.sprites = [
      {
        name: "portrait",
        size: [100, 100],
        frames: [{ resource_id: "base.webp", source_rectangle: [0, 0, 100, 100] }],
      },
      {
        name: "portrait_hover",
        size: [100, 100],
        frames: [{ resource_id: "hover.webp", source_rectangle: [0, 0, 100, 100] }],
      },
    ];
    let resolveHover!: (value: string) => void;
    resourceUrl.mockImplementation(async (...parameters: Parameters<ResourceUrl>) => {
      const resourceId = parameters[1];
      if (resourceId === "hover.webp") {
        return new Promise<string>((resolve) => {
          resolveHover = resolve;
        });
      }
      return `blob:${resourceId}`;
    });
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          hover_resource_id: "portrait_hover",
          width: 0,
          height: 100_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 6,
          requested_height: { unit: "pixels", value: 100 },
          requested_y: { unit: "pixels", value: 12 },
        },
      },
    });
    await flushPromises();

    await wrapper.get(".media-visual").trigger("mouseenter");
    await nextTick();

    expect(resourceUrl).toHaveBeenLastCalledWith({}, "hover.webp", 6, 0);
    expect(wrapper.find(".media-visual").exists()).toBe(true);
    expect(wrapper.get(".media-visual").classes()).toContain("media-hovered");
    expect(wrapper.get("img").attributes("src")).toBe("blob:base.webp");

    resolveHover("blob:hover.webp");
    await flushPromises();
    expect(wrapper.get("img").attributes("src")).toBe("blob:hover.webp");

    await wrapper.get(".media-visual").trigger("mouseleave");
    await flushPromises();
    expect(wrapper.get(".media-visual").classes()).not.toContain("media-hovered");
    expect(wrapper.get("img").attributes("src")).toBe("blob:base.webp");
  });

  it("applies the requested line slot, dimensions, and ypos to canvas-backed sprites", async () => {
    store.presentation.resources.sprites = [
      {
        name: "颜绘3000",
        size: [150, 150],
        frames: [],
        canvas_id: 42,
      },
    ];
    store.presentation.resources.canvases = [
      {
        canvas_id: 42,
        size: { width: 150, height: 150 },
        commands: [],
      },
    ];
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "颜绘3000",
          width: 0,
          height: 21_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 8,
          requested_width: { unit: "font_height_hundredths", value: 900 },
          requested_height: { unit: "font_height_hundredths", value: 900 },
          requested_y: { unit: "font_height_hundredths", value: -800 },
        },
      },
      global: { stubs: { CanvasReplay: true } },
    });

    const slot = wrapper.get<HTMLElement>(".media-positioned");
    const visual = slot.get<HTMLElement>(".media-visual");
    const canvas = visual.get("canvas-replay-stub");
    expect(slot.attributes("style")).toContain("width: 108px");
    expect(slot.attributes("style")).toContain("height: 21px");
    expect(visual.attributes("style")).toContain("width: 108px");
    expect(visual.attributes("style")).toContain("height: 108px");
    expect(visual.attributes("style")).toContain("top: -96px");
    expect(canvas.attributes("displaywidth")).toBe("108");
    expect(canvas.attributes("displayheight")).toBe("108");
  });

  it("retains the generated canvas until its final sprite has painted", async () => {
    const animation = {
      canvas_id: 42,
      size: { width: 100, height: 100 },
      commands: [],
    };
    store.presentation.resources.sprites = [
      { name: "portrait", size: [100, 100], frames: [], canvas_id: 42 },
    ];
    store.presentation.resources.canvases = [animation];
    let resolveFinal!: (value: string) => void;
    resourceUrl.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveFinal = resolve;
        }),
    );
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const wrapper = mount(MediaImage, {
      props: {
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 100_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 9,
        },
      },
      global: { stubs: { CanvasReplay: canvasReplayStub } },
    });
    expect(wrapper.find(".canvas-replay-test").exists()).toBe(true);

    store.presentation.resources.sprites = [
      {
        name: "portrait",
        size: [100, 100],
        frames: [{ resource_id: "portrait.webp", source_rectangle: [0, 0, 100, 100] }],
      },
    ];
    store.presentation.resources.canvases = [];
    await nextTick();
    expect(wrapper.find(".canvas-replay-test").exists()).toBe(true);
    expect(wrapper.find("img").exists()).toBe(true);
    expect(wrapper.get("img").classes()).not.toContain("media-canvas-handoff-image-visible");

    resolveFinal("blob:portrait.webp");
    await flushPromises();
    expect(wrapper.find(".canvas-replay-test").exists()).toBe(true);
    const image = wrapper.get("img");
    expect(image.attributes("src")).toBe("blob:portrait.webp");
    Object.defineProperties(image.element, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });

    await image.trigger("load");
    expect(wrapper.find(".canvas-replay-test").exists()).toBe(true);
    animationFrames.shift()?.(0);
    await nextTick();
    expect(wrapper.find(".canvas-replay-test").exists()).toBe(true);
    expect(wrapper.get(".canvas-replay-test").attributes("data-visible")).toBe("false");
    expect(wrapper.get("img").element).toBe(image.element);
    expect(wrapper.get("img").classes()).toContain("media-canvas-handoff-image-visible");
  });

  it("cancels stale non-line handoffs and keeps the canvas on image failure or unmount", async () => {
    const animation = {
      canvas_id: 42,
      size: { width: 100, height: 100 },
      commands: [],
    };
    store.presentation.resources.sprites = [
      { name: "portrait", size: [100, 100], frames: [], canvas_id: 42 },
    ];
    store.presentation.resources.canvases = [animation];
    const animationFrames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const wrapper = mount(MediaImage, {
      props: {
        lineSlot: false,
        placement: {
          resource_id: "portrait",
          width: 0,
          height: 100_000,
          depth: 0,
          opacity: { numerator: 1, denominator: 1 },
          revision: 9,
        },
      },
      global: { stubs: { CanvasReplay: canvasReplayStub } },
    });
    store.presentation.resources.sprites = [
      {
        name: "portrait",
        size: [100, 100],
        frames: [{ resource_id: "portrait.webp", source_rectangle: [0, 0, 100, 100] }],
      },
    ];
    store.presentation.resources.canvases = [];
    await flushPromises();
    const image = wrapper.get("img");
    Object.defineProperties(image.element, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });
    await image.trigger("load");
    const staleHandoff = animationFrames.shift()!;

    store.projectResourceGeneration = 1;
    await flushPromises();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    staleHandoff(0);
    await nextTick();
    expect(wrapper.get("img").element).toBe(image.element);
    expect(image.classes()).not.toContain("media-canvas-handoff-image-visible");
    expect(wrapper.get(".canvas-replay-test").attributes("data-visible")).toBe("true");

    await image.trigger("error");
    expect(image.classes()).not.toContain("media-canvas-handoff-image-visible");
    await image.trigger("load");
    expect(animationFrames).toHaveLength(1);
    wrapper.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
  });
});
