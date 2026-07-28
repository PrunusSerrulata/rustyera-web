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
});
