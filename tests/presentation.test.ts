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
    expect(state.lines.map(plainLine)).toEqual(["new", "next"]);
  });

  it("rejects a revision gap so the caller can resynchronize", () => {
    const state = emptyPresentation();
    expect(() => applyDelta(state, { base_revision: 9, new_revision: 10, operations: [] })).toThrow(
      "revision 不连续",
    );
  });
});
