import { describe, expect, it } from "vitest";
import { isReactive, toRaw } from "vue";

import {
  presentationInteractionEnabled,
  restoreButtonBoundary,
  retirePresentedButtons,
} from "@/core/presentation";
import { RuntimePresentationProjection } from "@/stores/runtimePresentation";

function line(lineId: number, enabled = false): any {
  return {
    line_id: lineId,
    alignment: "left",
    runs: enabled
      ? [
          {
            type: "button",
            enabled: true,
            generation: 1,
            token: { epoch: 1, id: lineId },
            runs: [],
          },
        ]
      : [],
  };
}

describe("runtime presentation staging", () => {
  it("keeps immutable runtime payloads out of the retained Vue proxy graph", () => {
    const projection = new RuntimePresentationProjection();
    const first = line(1, true);
    const island = { nodes: [{ type: "text", text: "island" }] };
    const resources = { sprites: [{ name: "sprite" }], canvases: [] };

    projection.projectSnapshot({
      revision: 1,
      title: "raw payloads",
      history: { logical_lines: [first] },
      html_island: [island],
      resources,
    });

    expect(isReactive(projection.presentation.lines)).toBe(true);
    expect(isReactive(projection.presentation.lines[0])).toBe(false);
    expect(isReactive((projection.presentation.lines[0] as any).runs[0])).toBe(false);
    expect(isReactive(projection.presentation.htmlIsland)).toBe(true);
    expect(isReactive(projection.presentation.htmlIsland[0])).toBe(false);
    expect(isReactive(projection.presentation.resources)).toBe(false);

    const appended = line(2, true);
    const replacement = line(2, false);
    const nextIsland = { nodes: [{ type: "text", text: "next" }] };
    const nextResources = { sprites: [], canvases: [{ canvas_id: 1 }] };
    projection.projectDelta({
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "append_line", line: appended },
        { type: "replace_line", line_id: 2, line: replacement },
        { type: "set_html_island", html_island: [nextIsland] },
        { type: "set_resources", resources: nextResources },
      ],
    });

    expect(projection.presentation.lines).toHaveLength(2);
    expect(isReactive(projection.presentation.lines[1])).toBe(false);
    expect(toRaw(projection.presentation.lines[1])).toBe(replacement);
    expect(isReactive(projection.presentation.htmlIsland[0])).toBe(false);
    expect(toRaw(projection.presentation.htmlIsland[0])).toBe(nextIsland);
    expect(isReactive(projection.presentation.resources)).toBe(false);
    expect(toRaw(projection.presentation.resources)).toBe(nextResources);
  });

  it("shares unchanged accumulated lines while staging an automatic tail refresh", () => {
    const projection = new RuntimePresentationProjection();
    projection.presentation.revision = 1;
    projection.presentation.lines = Array.from({ length: 5_000 }, (_, index) => line(index));
    const publishedFirstLine = toRaw(projection.presentation.lines[0]);

    expect(
      projection.projectDelta({
        base_revision: 1,
        new_revision: 2,
        operations: [{ type: "delete_lines", count: 1 }],
      }),
    ).toBe(false);

    expect(projection.current().lines).not.toBe(projection.presentation.lines);
    expect(projection.current().lines[0]).toBe(publishedFirstLine);
    expect(projection.presentation.lines).toHaveLength(5_000);
  });

  it("applies a complete redraw-disabled input frame without cloning accumulated history", () => {
    const projection = new RuntimePresentationProjection();
    projection.presentation.revision = 1;
    projection.presentation.redraw = { enabled: false };
    projection.presentation.lines = Array.from({ length: 5_000 }, (_, index) => line(index));
    const publishedLines = toRaw(projection.presentation.lines);

    expect(
      projection.projectDelta({
        base_revision: 1,
        new_revision: 2,
        operations: [
          { type: "delete_lines", count: 1 },
          { type: "append_line", line: line(5_001, true) },
          { type: "set_input_wait", input_wait: { wait_id: 9 } },
        ],
      }),
    ).toBe(true);

    expect(toRaw(projection.presentation.lines)).toBe(publishedLines);
    expect(projection.staged.value).toBe(false);
    expect(projection.presentation.lines).toHaveLength(5_000);
  });

  it("applies a staged generation update without cloning accumulated interactions", () => {
    const projection = new RuntimePresentationProjection();
    projection.presentation.revision = 1;
    projection.presentation.lines = [line(1, true)];
    const publishedInteraction = toRaw((projection.presentation.lines[0] as any).runs[0]);

    projection.projectDelta({
      base_revision: 1,
      new_revision: 2,
      operations: [
        { type: "set_redraw", redraw: { enabled: false } },
        { type: "set_button_generation", generation: 2 },
      ],
    });

    expect(publishedInteraction.enabled).toBe(true);
    expect(toRaw((projection.current().lines[0] as any).runs[0])).toBe(publishedInteraction);
    expect(presentationInteractionEnabled(projection.current(), publishedInteraction)).toBe(false);
  });

  it("stages and restores the constant-size retirement boundary", () => {
    const projection = new RuntimePresentationProjection();
    projection.projectSnapshot({
      revision: 1,
      title: "menu",
      history: { logical_lines: [line(1, true)] },
      redraw: { enabled: true },
    });
    const publishedInteraction = (projection.presentation.lines[0] as any).runs[0];
    projection.projectDelta({
      base_revision: 1,
      new_revision: 2,
      operations: [{ type: "delete_lines", count: 0 }],
    });

    const retired = retirePresentedButtons(projection.mutableInteractions());
    expect(publishedInteraction.enabled).toBe(true);
    expect(projection.presentation.retiredInteractionSequence).toBe(0);
    expect(presentationInteractionEnabled(projection.current(), publishedInteraction)).toBe(false);

    restoreButtonBoundary(projection.mutableInteractions(), retired);
    expect(publishedInteraction.enabled).toBe(true);
    expect(presentationInteractionEnabled(projection.current(), publishedInteraction)).toBe(true);
  });

  it("resets client interaction sequencing with the projection", () => {
    const projection = new RuntimePresentationProjection();
    projection.projectSnapshot({
      revision: 1,
      title: "menu",
      history: { logical_lines: [line(1, true)] },
      redraw: { enabled: true },
    });
    retirePresentedButtons(projection.mutableInteractions());
    expect(
      presentationInteractionEnabled(
        projection.current(),
        (projection.current().lines[0] as any).runs[0],
      ),
    ).toBe(false);

    projection.reset();
    expect(projection.presentation.nextInteractionSequence).toBe(1);
    expect(projection.presentation.retiredInteractionSequence).toBe(0);
  });
});
