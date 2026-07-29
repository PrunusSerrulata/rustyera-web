import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import { describe, expect, it, vi } from "vitest";

const resourceUrl = vi.hoisted(() => vi.fn(async () => "blob:era-image"));
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
});
