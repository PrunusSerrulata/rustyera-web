import { describe, expect, it } from "vitest";

import { projectSceneLayer } from "@/core/sceneProjection";
import { compactSceneDepthRanks, sceneDepthKey } from "@/core/sceneStacking";
import type { SceneLayerV1 } from "@/core/scene";

function layer(scrollPolicy: SceneLayerV1["scroll_policy"]): SceneLayerV1 {
  return {
    layer_id: 1,
    sequence: 1,
    source: { type: "resource", resource_id: "a.png", resource_revision: 1 },
    depth: 0,
    anchor: { type: "viewport" },
    offset: { x: 0, y: 0 },
    size: { width: 10_000, height: 10_000 },
    opacity: 255,
    color_matrix: null,
    scroll_policy: scrollPolicy,
    interaction: null,
    scene_revision: 1,
    document_origin_y: scrollPolicy === "follow_content" ? 19_000 : 0,
  };
}

describe("scene coordinate and stack projection", () => {
  it("keeps fixed layers viewport-bound and uses document origin for representable follow content", () => {
    const space = {
      lineTops: new Map<string, number>(),
      scrollTop: 40,
      viewportWidth: 100,
      viewportHeight: 100,
    };
    expect(projectSceneLayer(layer("fixed"), space)?.top).toBe(140);
    expect(projectSceneLayer(layer("follow_content"), space)?.top).toBe(19);
  });

  it("culls known offscreen boxes without losing exact i64 depth ordering", () => {
    const offscreen = { ...layer("fixed"), offset: { x: 200_000, y: 0 } };
    expect(
      projectSceneLayer(offscreen, {
        lineTops: new Map(),
        scrollTop: 0,
        viewportWidth: 100,
        viewportHeight: 100,
      })?.visible,
    ).toBe(false);
    const ranks = compactSceneDepthRanks([9223372036854775807n, 0, -9223372036854775808n]);
    expect(ranks.get(sceneDepthKey(9223372036854775807n))).toBe(-1);
    expect(ranks.get(sceneDepthKey(0))).toBe(0);
    expect(ranks.get(sceneDepthKey(-9223372036854775808n))).toBe(1);
  });
});
