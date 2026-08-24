import { describe, expect, it } from "vitest";

import {
  applyDelta,
  applySnapshot,
  emptyPresentation,
  hasEnabledButton,
  plainLine,
  printedHtmlLine,
  restoreButtonBoundary,
  retirePresentedButtons,
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

  it("keeps runtime text advances out of plain and HTML service text", () => {
    const line = {
      line_id: 1,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "button",
          runs: [{ type: "text_layout", text: "■", columns: 2, style: {} }],
          value: { type: "integer", value: 1 },
          enabled: true,
        },
        { type: "text_layout", text: "……", columns: 4, style: {} },
      ],
    } as unknown as DisplayLine;

    expect(plainLine(line)).toBe("■……");
    expect(printedHtmlLine(line)).toContain("<button value='1'>■</button>……");
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

  it("retires regular and HTML history buttons without disabling current partial updates", () => {
    const state = emptyPresentation();
    const button = (id: number, generation: number) => ({
      type: "button",
      runs: [{ type: "text", text: String(id), style: {} }],
      token: { epoch: 1, id },
      enabled: true,
      generation,
    });
    const htmlButton = (id: number, generation: number) => ({
      type: "html_document",
      document: {
        nodes: [
          {
            type: "element",
            kind: "button",
            interaction: { epoch: 1, id, enabled: true, generation },
            children: [{ type: "text", text: String(id) }],
          },
        ],
      },
    });
    const line = (lineId: number, runs: any[]) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs,
    });
    applySnapshot(state, {
      revision: 1,
      title: "buttons",
      history: {
        logical_lines: [
          line(1, [button(1, 0), htmlButton(2, 0)]),
          line(2, [button(20, 0), htmlButton(21, 0)]),
        ],
      },
    });

    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "set_button_generation", generation: 1 },
        {
          type: "replace_line",
          line_id: 2,
          line: line(2, [button(3, 1), htmlButton(4, 1)]),
        },
        { type: "append_line", line: line(3, [button(5, 0), htmlButton(6, 0)]) },
      ],
    });

    expect(hasEnabledButton(state, { epoch: 1, id: 1 })).toBe(false);
    expect(hasEnabledButton(state, { epoch: 1, id: 2 })).toBe(false);
    expect(hasEnabledButton(state, { epoch: 1, id: 3 })).toBe(true);
    expect(hasEnabledButton(state, { epoch: 1, id: 4 })).toBe(true);
    expect(hasEnabledButton(state, { epoch: 1, id: 5 })).toBe(false);
    expect(hasEnabledButton(state, { epoch: 1, id: 6 })).toBe(false);
  });

  it("forgets local button generation after an authoritative snapshot", () => {
    const state = emptyPresentation();
    const line = (lineId: number, id: number, generation: number) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "button",
          runs: [{ type: "text", text: String(id), style: {} }],
          token: { epoch: 1, id },
          enabled: true,
          generation,
        },
      ],
    });
    applyDelta(state, {
      base_revision: 0,
      new_revision: 1,
      operations: [{ type: "set_button_generation", generation: 1 }],
    });
    applySnapshot(state, {
      revision: 2,
      title: "resynchronized",
      history: { logical_lines: [line(1, 7, 2)] },
    });

    applyDelta(state, {
      base_revision: 2,
      new_revision: 3,
      operations: [
        { type: "replace_line", line_id: 1, line: line(1, 8, 2) },
        { type: "append_line", line: line(2, 9, 2) },
      ],
    });

    expect(state.buttonGeneration).toBeNull();
    expect(hasEnabledButton(state, { epoch: 1, id: 8 })).toBe(true);
    expect(hasEnabledButton(state, { epoch: 1, id: 9 })).toBe(true);
  });

  it("retires submitted history while allowing later dynamic partial updates", () => {
    const state = emptyPresentation();
    const line = (lineId: number, id: number) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "button",
          runs: [{ type: "text", text: String(id), style: {} }],
          token: { epoch: 1, id },
          enabled: true,
          generation: 0,
        },
      ],
    });
    applySnapshot(state, {
      revision: 1,
      title: "menu",
      history: { logical_lines: [line(1, 1)] },
    });

    const retired = retirePresentedButtons(state);
    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [{ type: "append_line", line: line(2, 0) }],
    });

    expect(hasEnabledButton(state, { epoch: 1, id: 1 })).toBe(false);
    expect(hasEnabledButton(state, { epoch: 1, id: 0 })).toBe(true);

    applySnapshot(state, {
      revision: 3,
      title: "resynchronized",
      history: { logical_lines: [line(1, 1), line(2, 0)] },
    });
    expect(hasEnabledButton(state, { epoch: 1, id: 1 })).toBe(false);
    expect(hasEnabledButton(state, { epoch: 1, id: 0 })).toBe(true);

    restoreButtonBoundary(state, retired);
    expect(hasEnabledButton(state, { epoch: 1, id: 1 })).toBe(true);
  });

  it("validates and retires the current tail without revisiting accumulated history", () => {
    const state = emptyPresentation();
    const line = (lineId: number, id: number) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "button",
          runs: [{ type: "text", text: String(id), style: {} }],
          token: { epoch: 3, id },
          enabled: true,
          generation: 0,
        },
      ],
    });
    const history = Array.from({ length: 5_000 }, (_, index) => line(index, index + 1));
    applySnapshot(state, {
      revision: 1,
      title: "long history",
      history: { logical_lines: history },
    });
    for (const old of state.lines.slice(0, -1))
      Object.defineProperty(old, "runs", {
        get() {
          throw new Error("current-tail input must not revisit old history");
        },
      });

    expect(hasEnabledButton(state, { epoch: 3, id: 5_000 })).toBe(true);
    retirePresentedButtons(state);
    expect(hasEnabledButton(state, { epoch: 3, id: 5_000 })).toBe(false);
  });

  it("validates, retires, restores, and generation-filters HTML island interactions", () => {
    const state = emptyPresentation();
    const island = (id: number, generation: number) => [
      {
        nodes: [
          {
            type: "element",
            kind: "button",
            semantic: { type: "button", title: "island" },
            interaction: { epoch: 2, id, enabled: true, generation },
            children: [{ type: "text", text: "island action" }],
          },
        ],
      },
    ];
    applySnapshot(state, {
      revision: 1,
      title: "island",
      history: { logical_lines: [] },
      html_island: island(9, 0),
    });
    expect(hasEnabledButton(state, { epoch: 2, id: 9 })).toBe(true);

    const retired = retirePresentedButtons(state);
    expect(retired).toBe(0);
    expect(hasEnabledButton(state, { epoch: 2, id: 9 })).toBe(false);
    restoreButtonBoundary(state, retired);
    expect(hasEnabledButton(state, { epoch: 2, id: 9 })).toBe(true);

    applyDelta(state, {
      base_revision: 1,
      new_revision: 2,
      operations: [{ type: "set_button_generation", generation: 1 }],
    });
    expect(hasEnabledButton(state, { epoch: 2, id: 9 })).toBe(false);
    applyDelta(state, {
      base_revision: 2,
      new_revision: 3,
      operations: [{ type: "set_html_island", html_island: island(10, 1) }],
    });
    expect(hasEnabledButton(state, { epoch: 2, id: 10 })).toBe(true);
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
