import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { describe, expect, it, vi } from "vitest";

type ResourceUrl = (bridge: unknown, resourceId: string, revision?: number) => Promise<string>;

const resourceUrl = vi.hoisted(() => vi.fn<ResourceUrl>(async () => "blob:era-image"));
const store = reactive({
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
      ],
      canvases: [],
    },
  },
  effectivePreferences: { imageScale: 1 },
  gameTextStyle: { fontSizePx: 12 },
});

vi.mock("@/core/resources", () => ({ resourceUrl }));
vi.mock("@/platform", () => ({ platformBridge: () => ({}) }));
vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import MediaImage from "@/components/MediaImage.vue";

describe("Era sprite images", () => {
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

    const sprite = wrapper.get<HTMLElement>(".media-sprite");
    const image = sprite.get<HTMLImageElement>("img");
    expect(resourceUrl).toHaveBeenCalledWith({}, "resources/title.webp", 3);
    expect(sprite.attributes("style")).toContain("width: 1041px");
    expect(sprite.attributes("style")).toContain("height: 16px");
    expect(image.attributes("style")).toContain("top: -16px");
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
    expect(slot.attributes("style")).toContain("height: 12px");
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

    expect(resourceUrl).toHaveBeenLastCalledWith({}, "hover.webp", 6);
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
});
