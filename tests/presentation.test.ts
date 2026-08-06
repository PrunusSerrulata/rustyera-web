import { describe, expect, it } from "vitest";

import {
  applyDelta,
  applySnapshot,
  emptyPresentation,
  plainLine,
  printedHtmlLine,
} from "@/core/presentation";
import type { DisplayLine } from "@/core/types";

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

  it("keeps an equal-length dynamic tail replacement at its current scroll position", () => {
    const state = emptyPresentation();
    const line = (lineId: number, text: string) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [{ type: "text", text, style: {} }],
    });
    applySnapshot(state, {
      revision: 1,
      title: "map",
      history: { logical_lines: [line(1, "before"), line(2, "map frame 1")] },
    });
    const historyRevision = state.historyRevision;

    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "set_redraw", redraw: { enabled: false } },
        { type: "delete_lines", count: 1 },
        { type: "append_line", line: line(3, "map frame 2") },
      ],
    });

    expect(state.lines.map(plainLine)).toEqual(["before", "map frame 2"]);
    expect(state.historyRevision).toBe(historyRevision);
  });

  it("keeps a same-length resynchronized tail replacement at its scroll position", () => {
    const state = emptyPresentation();
    const snapshot = (revision: number, lineId: number, text: string) => ({
      revision,
      title: "snapshot",
      history: {
        logical_lines: [
          {
            line_id: lineId,
            temporary: false,
            logical_line_start: true,
            line_end: true,
            alignment: "left",
            runs: [{ type: "text", text, style: {} }],
          },
        ],
      },
    });
    applySnapshot(state, snapshot(1, 1, "frame 1"));
    const historyRevision = state.historyRevision;

    applySnapshot(state, snapshot(2, 2, "frame 2"));

    expect(state.lines.map(plainLine)).toEqual(["frame 2"]);
    expect(state.historyRevision).toBe(historyRevision);
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

  it("preserves positioned images when HTML_GETPRINTEDSTR serializes an HTML line", () => {
    const line: DisplayLine = {
      line_id: 1,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "html_document",
          document: {
            nodes: [
              {
                type: "element",
                kind: "no_break",
                attributes: [],
                children: [
                  {
                    type: "element",
                    kind: "non_button",
                    attributes: [{ name: "pos", value: "0" }],
                    children: [
                      {
                        type: "element",
                        kind: "image",
                        attributes: [
                          { name: "src", value: "颜绘3000" },
                          { name: "height", value: "900" },
                          { name: "width", value: "900" },
                          { name: "ypos", value: "0" },
                        ],
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    expect(printedHtmlLine(line)).toBe(
      "<p align='left'><nobr><nonbutton pos='0'><img src='颜绘3000' height='900' width='900' ypos='0'></nonbutton></nobr></p>",
    );
  });
});
