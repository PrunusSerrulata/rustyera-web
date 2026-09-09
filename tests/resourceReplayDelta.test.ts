import { expect, it } from "vitest";
import { isReactive } from "vue";
import { applyResourceReplayDelta } from "@/core/resourceReplayDelta";
import { applyDelta, applySnapshot, emptyPresentation } from "@/core/presentation";
import { RuntimePresentationProjection } from "@/stores/runtimePresentation";

const sprite = (name: string, revision = 1) => ({ name, revision, frames: [] });
const canvas = (canvas_id: number, revision = 1, commands: any[] = []) => ({
  canvas_id,
  revision,
  commands,
});
const baseline = () => ({
  sprites: [sprite("A"), sprite("B"), sprite("C")],
  canvases: [],
  animation_timer_ms: 0,
});
const change = (sprite_edits: any[] = [], canvas_edits: any[] = []) => ({
  sprite_edits,
  canvas_edits,
  animation_timer_ms: 20,
});

it("applies original-baseline offsets without changing retained resource objects", () => {
  const before = baseline();
  const next = applyResourceReplayDelta(
    before,
    change([
      { start: 0, delete_count: 1, insert: [] },
      { start: 2, delete_count: 1, insert: [sprite("D"), sprite("E")] },
    ]),
  );
  expect(next.sprites.map((entry: any) => entry.name)).toEqual(["B", "D", "E"]);
  expect(next.sprites[0]).toBe(before.sprites[1]);
  expect(next.canvases).toBe(before.canvases);
  expect(next.animation_timer_ms).toBe(20);
  expect(before).toEqual(baseline());
});

it("preserves historical exact revisions and validates dependencies across both edited lists", () => {
  const before = { ...baseline(), sprites: [sprite("A", 1), sprite("A", 2)] };
  const next = applyResourceReplayDelta(
    before,
    change(
      [{ start: 0, delete_count: 1, insert: [] }],
      [
        {
          start: 0,
          delete_count: 0,
          insert: [canvas(7, 1, [{ type: "draw_sprite", name: "a", resource_revision: 2 }])],
        },
      ],
    ),
  );
  expect(next.sprites).toEqual([sprite("A", 2)]);
  expect(next.canvases[0].canvas_id).toBe(7);
  expect(() =>
    applyResourceReplayDelta(next, change([{ start: 0, delete_count: 1, insert: [] }])),
  ).toThrow("missing exact sprite");
});

it.each(
  [
    [{ start: 4, delete_count: 0, insert: [sprite("D")] }],
    [{ start: 0, delete_count: 4, insert: [] }],
    [{ start: 0, delete_count: 0, insert: [] }],
    [{ start: -1, delete_count: 0, insert: [sprite("D")] }],
    [{ start: 0.5, delete_count: 0, insert: [sprite("D")] }],
    [
      { start: 0, delete_count: 2, insert: [] },
      { start: 1, delete_count: 1, insert: [] },
    ],
    [
      { start: 0, delete_count: 0, insert: [sprite("D")] },
      { start: 0, delete_count: 0, insert: [sprite("E")] },
    ],
    [{ start: 3, delete_count: 0, insert: [sprite("a")] }],
  ].map((edits) => [edits]),
)("rejects malformed edits without partially publishing the enclosing delta: %j", (edits) => {
  const state = emptyPresentation();
  applySnapshot(state, {
    revision: 1,
    title: "unchanged",
    history: { logical_lines: [] },
    resources: baseline(),
  });
  const before = structuredClone(state);
  expect(() =>
    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "set_title", title: "must not publish" },
        { type: "apply_resource_delta", delta: change(edits) },
      ],
    }),
  ).toThrow();
  expect(state).toEqual(before);
});

it("applies a resource delta against the latest complete baseline in operation order", () => {
  const state = emptyPresentation();
  applySnapshot(state, { revision: 1, history: { logical_lines: [] }, resources: baseline() });
  const replacement = { ...baseline(), sprites: [sprite("X")] };
  applyDelta(state, {
    base_revision: 1,
    new_revision: 2,
    operations: [
      { type: "set_resources", resources: replacement },
      {
        type: "apply_resource_delta",
        delta: change([{ start: 1, delete_count: 0, insert: [sprite("Y")] }]),
      },
    ],
  });
  expect(state.resources.sprites.map((entry: any) => entry.name)).toEqual(["X", "Y"]);
  expect(state.resources.sprites[0]).toEqual(replacement.sprites[0]);
  const final = baseline();
  applyDelta(state, {
    base_revision: 2,
    new_revision: 3,
    operations: [
      { type: "apply_resource_delta", delta: change([{ start: 0, delete_count: 1, insert: [] }]) },
      { type: "set_resources", resources: final },
    ],
  });
  expect(state.resources).toEqual(final);
});

it("uses ASCII case identity and rejects invalid references and numeric ranges", () => {
  const before = { ...baseline(), sprites: [sprite("é"), sprite("É")] };
  expect(applyResourceReplayDelta(before, change()).sprites).toHaveLength(2);
  for (const insert of [
    { ...sprite("D"), canvas_id: 7 },
    { ...sprite("D"), canvas_id: 7, canvas_revision: 1 },
    sprite("D", -1),
  ])
    expect(() =>
      applyResourceReplayDelta(
        baseline(),
        change([{ start: 3, delete_count: 0, insert: [insert] }]),
      ),
    ).toThrow();
  expect(() =>
    applyResourceReplayDelta(before, { ...change(), animation_timer_ms: 2 ** 31 }),
  ).toThrow();
  expect(() =>
    applyResourceReplayDelta(
      before,
      change([], [{ start: 0, delete_count: 0, insert: [canvas(7), canvas(7)] }]),
    ),
  ).toThrow("duplicate");
});

it("rejects missing frame and canvas source/mask revisions atomically", () => {
  const state = emptyPresentation();
  const resources = {
    sprites: [{ ...sprite("A"), frames: [{ canvas_id: 7, canvas_revision: 1 }] }],
    canvases: [
      canvas(7, 1),
      canvas(7, 2),
      canvas(8, 1, [
        {
          type: "draw_canvas",
          source_canvas_id: 7,
          source_revision: 1,
          mask_canvas_id: 7,
          mask_revision: 2,
        },
      ]),
    ],
    animation_timer_ms: 0,
  };
  applySnapshot(state, { revision: 1, history: { logical_lines: [] }, resources });
  const invalid = [
    change([], [{ start: 0, delete_count: 1, insert: [] }]),
    change([], [{ start: 1, delete_count: 1, insert: [] }]),
    ...[{ canvas_id: 7 }, { canvas_revision: 1 }, { canvas_id: 9, canvas_revision: 1 }].map(
      (frame) =>
        change([{ start: 0, delete_count: 1, insert: [{ ...sprite("A"), frames: [frame] }] }]),
    ),
    ...[
      { source_canvas_id: 7 },
      { source_revision: 1 },
      { source_canvas_id: 9, source_revision: 1 },
      { source_canvas_id: 7, source_revision: 1, mask_canvas_id: 7 },
      { source_canvas_id: 7, source_revision: 1, mask_revision: 2 },
      { source_canvas_id: 7, source_revision: 1, mask_canvas_id: 9, mask_revision: 2 },
    ].map((command) =>
      change(
        [],
        [
          {
            start: 2,
            delete_count: 1,
            insert: [canvas(8, 1, [{ type: "draw_canvas", ...command }])],
          },
        ],
      ),
    ),
  ];
  for (const delta of invalid) {
    const before = structuredClone(state);
    expect(() =>
      applyDelta(state, {
        base_revision: 1,
        new_revision: 2,
        operations: [
          { type: "set_title", title: "must not publish" },
          { type: "apply_resource_delta", delta },
        ],
      }),
    ).toThrow();
    expect(state).toEqual(before);
  }
  applyDelta(state, {
    base_revision: 1,
    new_revision: 2,
    operations: [
      {
        type: "apply_resource_delta",
        delta: change(
          [
            {
              start: 0,
              delete_count: 1,
              insert: [{ ...sprite("A"), frames: [{ canvas_id: 9, canvas_revision: 1 }] }],
            },
          ],
          [{ start: 0, delete_count: 3, insert: [canvas(9, 1)] }],
        ),
      },
    ],
  });
  expect(state.resources.canvases[0].canvas_id).toBe(9);
});

it("rejects revision gaps and resumes resource edits from a new snapshot baseline", () => {
  const projection = new RuntimePresentationProjection();
  projection.projectSnapshot({
    revision: 1,
    history: { logical_lines: [] },
    resources: baseline(),
  });
  const before = projection.current().resources;
  expect(() =>
    projection.projectDelta({
      base_revision: 2,
      new_revision: 3,
      operations: [
        {
          type: "apply_resource_delta",
          delta: change([{ start: 0, delete_count: 1, insert: [] }]),
        },
      ],
    }),
  ).toThrow();
  expect(projection.current().revision).toBe(1);
  expect(projection.current().resources).toBe(before);
  const fresh = { ...baseline(), sprites: [sprite("X")] };
  projection.projectSnapshot({ revision: 8, history: { logical_lines: [] }, resources: fresh });
  projection.projectDelta({
    base_revision: 8,
    new_revision: 9,
    operations: [
      {
        type: "apply_resource_delta",
        delta: change([{ start: 1, delete_count: 0, insert: [sprite("Y")] }]),
      },
    ],
  });
  expect(projection.current().resources.sprites.map((entry: any) => entry.name)).toEqual([
    "X",
    "Y",
  ]);
  expect(projection.current().resources.sprites[0]).toBe(fresh.sprites[0]);
});

it("retains a large unchanged catalog instead of rebuilding every sprite payload", () => {
  const before = {
    ...baseline(),
    sprites: Array.from({ length: 28_000 }, (_, i) => sprite(String(i))),
  };
  const next = applyResourceReplayDelta(
    before,
    change([{ start: 28_000, delete_count: 0, insert: [sprite("new")] }]),
  );
  expect(next.sprites).toHaveLength(28_001);
  expect(
    next.sprites.slice(0, 28_000).every((entry: any, i: number) => entry === before.sprites[i]),
  ).toBe(true);
});

it("keeps resource changes raw and staged until the existing redraw boundary", () => {
  const projection = new RuntimePresentationProjection();
  const resources = baseline();
  projection.projectSnapshot({
    revision: 1,
    title: "staging",
    history: { logical_lines: [] },
    resources,
  });
  projection.projectDelta({
    base_revision: 1,
    new_revision: 2,
    operations: [
      { type: "set_redraw", redraw: { enabled: false } },
      {
        type: "apply_resource_delta",
        delta: change([{ start: 3, delete_count: 0, insert: [sprite("D")] }]),
      },
    ],
  });
  expect(projection.presentation.resources).toBe(resources);
  expect(projection.current().resources.sprites).toHaveLength(4);
  expect(projection.current().resources.sprites[0]).toBe(resources.sprites[0]);
  expect(isReactive(projection.current().resources)).toBe(false);
  projection.projectDelta({
    base_revision: 2,
    new_revision: 3,
    operations: [{ type: "set_redraw", redraw: { enabled: true } }],
  });
  expect(projection.shouldPublish("output_ready")).toBe(true);
  projection.publish();
  expect(projection.presentation.resources.sprites).toHaveLength(4);
  expect(isReactive(projection.presentation.resources.sprites)).toBe(false);
});
