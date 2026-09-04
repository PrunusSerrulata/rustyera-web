import { shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activate = vi.hoisted(() => vi.fn());
const store = reactive({
  presentation: {
    resources: {
      animation_timer_ms: 10,
      sprites: [
        {
          name: "BASE",
          revision: 1,
          size: [10, 10],
          frames: [
            { resource_id: "base-0.png", delay_ms: 10 },
            { resource_id: "base-1.png", delay_ms: 10 },
          ],
        },
        { name: "HOVER", revision: 2, size: [10, 10], frames: [] },
      ],
      canvases: [],
    },
  },
  canInteract: true,
  useMouse: true,
  interactionEnabled: (interaction: any) => interaction.enabled === true,
  activate,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import SceneLayer from "@/components/SceneLayer.vue";

describe("scene layer projection", () => {
  beforeEach(() => activate.mockReset());

  it("uses the canonical hover source and submits one opaque interaction token", async () => {
    const wrapper = shallowMount(SceneLayer, {
      props: {
        layer: {
          layer_id: 7,
          sequence: 3,
          source: { type: "sprite", sprite_name: "BASE", resource_revision: 1 },
          depth: 2,
          anchor: { type: "viewport" },
          offset: { x: 0, y: 0 },
          size: { width: 10_000, height: 10_000 },
          opacity: 128,
          color_matrix: Array.from({ length: 25 }, (_, index) => (index % 6 === 0 ? 256 : 0)),
          scroll_policy: "fixed",
          interaction: {
            token: { epoch: 4, id: 5 },
            value: { type: "integer", value: 12 },
            enabled: true,
            hover_source: { type: "sprite", sprite_name: "HOVER", resource_revision: 2 },
            hit_map: null,
            title: "map",
          },
          scene_revision: 1,
          document_origin_y: 0,
        },
        top: 3,
        left: 2,
        stackOrder: -2,
        animationTimeMs: 15,
        hoverAnimationTimeMs: 0,
        activationScope: "7:1",
      },
      global: {
        stubs: {
          CanvasReplay: true,
          MediaImage: {
            props: ["placement", "frameIndex"],
            template: '<i :data-source="placement.resource_id" :data-frame="frameIndex" />',
          },
        },
      },
    });
    expect(wrapper.get("i").attributes("data-source")).toBe("BASE");
    expect(wrapper.get("i").attributes("data-frame")).toBe("1");
    await wrapper.get(".scene-layer").trigger("pointerenter");
    expect(wrapper.get("i").attributes("data-source")).toBe("HOVER");
    await wrapper.get(".scene-layer").trigger("click");
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith({ epoch: 4, id: 5 });
    expect(wrapper.get("feColorMatrix").attributes("values")?.split(" ")).toHaveLength(20);
    expect(wrapper.get(".scene-layer").attributes("style")).toContain("opacity: 1");
    wrapper.unmount();
  });
});
