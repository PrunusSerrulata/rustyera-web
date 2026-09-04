import { describe, expect, it } from "vitest";

import { applySceneDelta, emptyScene, validateScene, type SceneLayerV1 } from "@/core/scene";
import {
  applySnapshot,
  emptyPresentation,
  hasEnabledButton,
  retirePresentedButtons,
} from "@/core/presentation";

function layer(id: number, sequence: number, depth: number, lineId?: number): SceneLayerV1 {
  return {
    layer_id: id,
    sequence,
    source: { type: "resource", resource_id: `${id}.png`, resource_revision: 1 },
    depth,
    anchor: lineId == null ? { type: "viewport" } : { type: "display_line", line_id: lineId },
    offset: { x: 0, y: 0 },
    size: { width: 10_000, height: 20_000 },
    opacity: 255,
    color_matrix: null,
    scroll_policy: "fixed",
    interaction: null,
    scene_revision: 1,
    document_origin_y: 0,
  };
}

describe("scene v1 replay", () => {
  it("replays every operation atomically in runtime visual order", () => {
    const first = applySceneDelta(emptyScene(), {
      base_revision: 0,
      new_revision: 1,
      operations: [
        { type: "upsert_layer", layer: layer(1, 1, -1) },
        { type: "upsert_layer", layer: layer(2, 2, 3, 9) },
        { type: "upsert_layer", layer: layer(3, 3, 3, 9) },
      ],
    });
    expect(first.layers.map((item) => item.layer_id)).toEqual([2, 3, 1]);

    const updated = { ...first.layers[0], depth: 4, scene_revision: 2 };
    const second = applySceneDelta(first, {
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "upsert_layer", layer: updated },
        { type: "clear_anchored_line", line_id: 9 },
        { type: "remove_layer", layer_id: 99 },
      ],
    });
    expect(second.layers.map((item) => item.layer_id)).toEqual([1]);
  });

  it("leaves the previous snapshot untouched when a later operation is invalid", () => {
    const current = applySceneDelta(emptyScene(), {
      base_revision: 0,
      new_revision: 1,
      operations: [{ type: "upsert_layer", layer: layer(1, 1, 0) }],
    });
    const before = [...current.layers];
    expect(() =>
      applySceneDelta(current, {
        base_revision: 1,
        new_revision: 2,
        operations: [{ type: "upsert_layer", layer: { ...layer(1, 2, 1), scene_revision: 2 } }],
      }),
    ).toThrow("sequence changed");
    expect(current.revision).toBe(1);
    expect(current.layers).toEqual(before);
  });

  it("rejects a snapshot outside the runtime-owned visual order", () => {
    const scene = { revision: 1, layers: [layer(1, 1, -1), layer(2, 2, 3)] };
    expect(() => validateScene(scene)).toThrow("outside runtime order");
    expect(scene.layers.map((item) => item.layer_id)).toEqual([1, 2]);
  });

  it("rejects non-u64 tokens and non-i64 interaction values before scene commit", () => {
    const invalidToken = {
      ...layer(1, 1, 0),
      interaction: {
        token: { epoch: -1, id: 1 },
        value: { type: "integer", value: 1 } as const,
        enabled: true,
      },
    };
    expect(() => validateScene({ revision: 1, layers: [invalidToken] })).toThrow("unsigned");
    const invalidValue = {
      ...invalidToken,
      interaction: {
        ...invalidToken.interaction,
        token: { epoch: 1, id: 1 },
        value: { type: "integer", value: 1n << 63n } as const,
      },
    };
    expect(() => validateScene({ revision: 1, layers: [invalidValue] })).toThrow("signed");
  });

  it("replaces and clears a complete scene without leaking the previous state", () => {
    const current = applySceneDelta(emptyScene(), {
      base_revision: 0,
      new_revision: 1,
      operations: [{ type: "upsert_layer", layer: layer(1, 1, 0) }],
    });
    const replacement = { ...layer(2, 2, 4), scene_revision: 2 };
    const replaced = applySceneDelta(current, {
      base_revision: 1,
      new_revision: 2,
      operations: [{ type: "replace_scene", scene: { revision: 2, layers: [replacement] } }],
    });
    expect(replaced.layers.map((item) => item.layer_id)).toEqual([2]);
    const cleared = applySceneDelta(replaced, {
      base_revision: 2,
      new_revision: 3,
      operations: [{ type: "clear_depth", depth: 4 }],
    });
    expect(cleared.layers).toEqual([]);
  });

  it("includes scene tokens in the canonical interaction retirement boundary", () => {
    const state = emptyPresentation();
    const interactive = {
      ...layer(4, 4, 1),
      interaction: {
        token: { epoch: 7, id: 8 },
        value: { type: "integer", value: 12 },
        enabled: true,
        hover_source: null,
        hit_map: null,
        title: null,
      },
    };
    applySnapshot(state, {
      revision: 1,
      title: "scene",
      history: { logical_lines: [] },
      scene: { revision: 1, layers: [interactive] },
    });
    expect(hasEnabledButton(state, { epoch: 7, id: 8 })).toBe(true);
    retirePresentedButtons(state);
    expect(hasEnabledButton(state, { epoch: 7, id: 8 })).toBe(false);
  });
});
