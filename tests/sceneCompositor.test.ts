import { shallowMount, type ComponentMountingOptions } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

const activate = vi.hoisted(() => vi.fn());
const sampleArgb = vi.hoisted(() => vi.fn());

vi.mock("@/components/CanvasReplay.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "CanvasReplay",
      setup(_props, { expose }) {
        expose({ sampleArgb });
        return () => h("span", { class: "canvas-replay-test-double" });
      },
    }),
  };
});

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    presentation: {
      resources: {
        animation_timer_ms: 0,
        canvases: [
          {
            canvas_id: 90,
            revision: 3,
            size: { width: 40, height: 20 },
            commands: [],
          },
        ],
      },
    },
    interactionEnabled: () => true,
    canInteract: true,
    useMouse: true,
    runtimeEpoch: 7,
    projectResourceGeneration: 1,
    activate,
  }),
}));

import SceneCompositor from "@/components/SceneCompositor.vue";
import type { SceneLayerV1 } from "@/core/scene";
import { compactSceneDepthRanks } from "@/core/sceneStacking";
import { activateScenePointer, scenePointerButton } from "@/platform/scenePointerObservation";

function mountCompositor(options: ComponentMountingOptions<typeof SceneCompositor>) {
  return shallowMount(SceneCompositor, {
    ...options,
    global: { stubs: { CanvasReplay: false } },
  });
}

function layer(id: number, depth: number, anchor: SceneLayerV1["anchor"]): SceneLayerV1 {
  return {
    layer_id: id,
    sequence: id,
    source: { type: "resource", resource_id: `${id}.png`, resource_revision: 1 },
    depth,
    anchor,
    offset: { x: 2_000, y: 3_000 },
    size: { width: 10_000, height: 10_000 },
    opacity: 255,
    color_matrix: null,
    scroll_policy: "fixed",
    interaction: null,
    scene_revision: 1,
    document_origin_y: 0,
  };
}

describe("scene compositor", () => {
  it("keeps runtime order while projecting viewport and stable line anchors", () => {
    const wrapper = mountCompositor({
      props: {
        scene: {
          revision: 1,
          layers: [
            layer(1, 3, { type: "viewport" }),
            layer(2, -1, { type: "display_line", line_id: 9 }),
          ],
        },
        lineTops: new Map([["9", 80]]),
        scrollTop: 20,
        viewportWidth: 100,
        viewportHeight: 100,
        depthRanks: compactSceneDepthRanks([3, -1]),
      },
    });
    const projected = wrapper.findAllComponents({ name: "SceneLayer" });
    expect(projected.map((item) => item.props("layer").layer_id)).toEqual([1, 2]);
    expect(projected[0].props()).toMatchObject({
      top: 123,
      left: 2,
      stackOrder: -1,
      bottomAligned: true,
    });
    expect(projected[1].props()).toMatchObject({
      top: 83,
      left: 2,
      stackOrder: 1,
      bottomAligned: false,
    });
    wrapper.unmount();
  });

  it("omits a line-relative layer after its stable anchor is trimmed", () => {
    const wrapper = mountCompositor({
      props: {
        scene: { revision: 1, layers: [layer(2, 0, { type: "display_line", line_id: 9 })] },
        lineTops: new Map(),
        scrollTop: 0,
        viewportWidth: 100,
        viewportHeight: 100,
        depthRanks: compactSceneDepthRanks([0]),
      },
    });
    expect(wrapper.findAllComponents({ name: "SceneLayer" })).toHaveLength(0);
    wrapper.unmount();
  });

  it("samples the opaque bottom-aligned CBG map for hover, MOUSEB, and activation", async () => {
    activate.mockReset();
    sampleArgb.mockReturnValue(0xff00000c);
    const host = document.createElement("div");
    host.className = "game-viewport";
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 100 },
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
    });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    document.body.append(host);
    const interactive = {
      ...layer(4, 0, { type: "viewport" }),
      interaction: {
        token: { epoch: 7, id: 8 },
        value: { type: "integer", value: 12 } as const,
        enabled: true,
        hover_source: null,
        hit_map: { type: "canvas", canvas_id: 90, resource_revision: 3 } as const,
        title: null,
      },
    };
    const wrapper = mountCompositor({
      attachTo: host,
      props: {
        scene: { revision: 1, layers: [interactive] },
        lineTops: new Map(),
        scrollTop: 0,
        viewportWidth: 100,
        viewportHeight: 100,
        depthRanks: compactSceneDepthRanks([0]),
      },
    });

    expect(scenePointerButton(7, 5, 95)).toBe("12");
    expect(sampleArgb).toHaveBeenCalledWith(5, 15);
    expect(activateScenePointer(5, 95)).toBe(true);
    expect(activateScenePointer(5, 95)).toBe(false);
    expect(activate).toHaveBeenCalledWith({ epoch: 7, id: 8 });
    sampleArgb.mockReturnValue(0x8000000c);
    await wrapper.get(".scene-compositor").trigger("pointerleave");
    expect(scenePointerButton(7, 5, 95)).toBeUndefined();
    sampleArgb.mockReturnValue(0xff00000c);
    await wrapper.get(".scene-compositor").trigger("pointerleave");
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 120 });
    expect(scenePointerButton(7, 5, 115)).toBe("12");
    expect(sampleArgb).toHaveBeenLastCalledWith(5, 15);

    wrapper.unmount();
    host.remove();
  });
});
