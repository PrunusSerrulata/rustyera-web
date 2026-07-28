import { describe, expect, it } from "vitest";

import { applyDelta, applySnapshot, emptyPresentation, plainLine } from "@/core/presentation";

describe("presentation projection", () => {
  it("applies snapshots and ordered deltas without losing line identity", () => {
    const state = emptyPresentation();
    applySnapshot(state, {
      revision: 4,
      title: "fixture",
      history: {
        logical_lines: [
          {
            line_id: 10,
            temporary: false,
            logical_line_start: true,
            line_end: true,
            alignment: "left",
            runs: [{ type: "text", text: "old", style: {} }],
          },
        ],
      },
    });
    expect(state.historyRevision).toBe(1);
    applyDelta(state, {
      base_revision: 4,
      new_revision: 5,
      operations: [
        {
          type: "replace_line",
          line_id: 10,
          line: { ...state.lines[0], runs: [{ type: "text", text: "new", style: {} }] },
        },
        {
          type: "append_line",
          line: {
            ...state.lines[0],
            line_id: 11,
            runs: [{ type: "text", text: "next", style: {} }],
          },
        },
      ],
    });
    expect(state.revision).toBe(5);
    expect(state.historyRevision).toBe(2);
    expect(state.lines.map(plainLine)).toEqual(["new", "next"]);
  });

  it("does not mark settings-only deltas as new game output", () => {
    const state = emptyPresentation();
    applyDelta(state, {
      base_revision: 0,
      new_revision: 1,
      operations: [{ type: "set_title", title: "changed" }],
    });
    expect(state.historyRevision).toBe(0);
  });

  it("marks an image replacement as output even when both images have empty alt text", () => {
    const state = emptyPresentation();
    const imageLine = (resourceId: string) => ({
      line_id: 1,
      temporary: true,
      logical_line_start: true,
      line_end: false,
      alignment: "left",
      runs: [
        {
          type: "image",
          placement: { resource_id: resourceId, revision: 1 },
        },
      ],
    });
    applySnapshot(state, {
      revision: 1,
      title: "images",
      history: { logical_lines: [imageLine("first")] },
    });
    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [{ type: "replace_line", line_id: 1, line: imageLine("second") }],
    });
    expect(state.historyRevision).toBe(2);
  });

  it("rejects a revision gap so the caller can resynchronize", () => {
    const state = emptyPresentation();
    expect(() => applyDelta(state, { base_revision: 9, new_revision: 10, operations: [] })).toThrow(
      "revision 不连续",
    );
  });
});
