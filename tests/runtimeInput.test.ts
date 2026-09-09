import { describe, expect, it, vi } from "vitest";

import { applySnapshot, emptyPresentation, hasEnabledButton } from "@/core/presentation";
import { RuntimeInputState } from "@/stores/runtimeInput";

describe("runtime input presentation boundary", () => {
  function menuInput(kind: string) {
    const presentation = emptyPresentation();
    const send = vi.fn().mockResolvedValue(11);
    const input = new RuntimeInputState({
      presentation: () => presentation,
      mutableInteractions: () => presentation,
      send,
      sampleMonotonic: () => 12,
      phase: () => "waiting_input",
      beginPresentationTransition: vi.fn(),
      cancelPresentationTransition: vi.fn(),
      logWarning: vi.fn(),
      signalMessageSkip: vi.fn(),
    });
    function showMenu(waitId: number, waitKind: string, buttonIds: number[]) {
      const wait = {
        kind: waitKind,
        wait_id: waitId,
        submission_token: { epoch: 2, id: 100 + waitId },
      };
      applySnapshot(presentation, {
        revision: waitId,
        title: "menu across a message wait",
        input_wait: wait,
        history: {
          logical_lines: buttonIds.map((id) => ({
            line_id: id,
            temporary: false,
            logical_line_start: true,
            line_end: true,
            alignment: "left",
            runs: [
              {
                type: "button",
                runs: [{ type: "text", text: id === 1 ? "Status" : "Command", style: {} }],
                token: { epoch: 2, id },
                enabled: true,
                generation: 0,
              },
            ],
          })),
        },
      });
      input.updateWait(wait);
    }
    showMenu(1, kind, [1]);
    return { input, presentation, send, showMenu };
  }

  it.each(["enter_key", "any_key"])(
    "keeps header buttons available when %s continues into newly printed choices",
    async (kind) => {
      const { input, presentation, showMenu } = menuInput(kind);
      await input.submit(
        kind === "enter_key" ? { type: "enter" } : { type: "any_key", value: " " },
        false,
      );
      showMenu(2, "integer_value", [1, 2]);
      await input.settle();

      expect(input.pending.value).toBeUndefined();
      expect(hasEnabledButton(presentation, { epoch: 2, id: 1 })).toBe(true);
      expect(hasEnabledButton(presentation, { epoch: 2, id: 2 })).toBe(true);
    },
  );

  it("preserves header buttons while message skip crosses consecutive waits and appends choices", async () => {
    const { input, presentation, send, showMenu } = menuInput("enter_key");
    await input.requestMessageSkip();
    showMenu(2, "enter_key", [1, 2]);
    await input.settle();
    showMenu(3, "integer_value", [1, 2, 3]);
    await input.settle();

    expect(send.mock.calls.map(([message]) => message.value.wait_id)).toEqual([1, 2]);
    expect(input.pending.value).toBeUndefined();
    for (const id of [1, 2, 3]) expect(hasEnabledButton(presentation, { epoch: 2, id })).toBe(true);
  });

  it("still retires a submitted value menu when the runtime prints replacement choices", async () => {
    const { input, presentation, showMenu } = menuInput("integer_value");
    await input.submit({ type: "activate", value: { epoch: 2, id: 1 } }, false);
    expect(hasEnabledButton(presentation, { epoch: 2, id: 1 })).toBe(false);
    showMenu(2, "integer_value", [1, 2]);
    await input.settle();

    expect(hasEnabledButton(presentation, { epoch: 2, id: 1 })).toBe(false);
    expect(hasEnabledButton(presentation, { epoch: 2, id: 2 })).toBe(true);
  });

  it("arms an atomic presentation transition after submitting an input", async () => {
    const presentation = emptyPresentation();
    presentation.inputWait = {
      kind: "integer_value",
      wait_id: 7,
      submission_token: { epoch: 2, id: 9 },
    };
    const beginPresentationTransition = vi.fn();
    const cancelPresentationTransition = vi.fn();
    const send = vi.fn().mockImplementation(async () => {
      expect(beginPresentationTransition).toHaveBeenCalledOnce();
      return 11;
    });
    const input = new RuntimeInputState({
      presentation: () => presentation,
      mutableInteractions: () => presentation,
      send,
      sampleMonotonic: () => 12,
      phase: () => "waiting_input",
      beginPresentationTransition,
      cancelPresentationTransition,
      logWarning: vi.fn(),
      signalMessageSkip: vi.fn(),
    });

    await expect(input.submit({ type: "commit_text", value: "120" }, false)).resolves.toBe(true);
    expect(beginPresentationTransition).toHaveBeenCalledOnce();
    expect(cancelPresentationTransition).not.toHaveBeenCalled();
  });

  it("does not stage presentation when transport submission fails", async () => {
    const presentation = emptyPresentation();
    presentation.inputWait = {
      kind: "integer_value",
      wait_id: 7,
      submission_token: { epoch: 2, id: 9 },
    };
    const beginPresentationTransition = vi.fn();
    const cancelPresentationTransition = vi.fn();
    const input = new RuntimeInputState({
      presentation: () => presentation,
      mutableInteractions: () => presentation,
      send: vi.fn().mockRejectedValue(new Error("transport failed")),
      sampleMonotonic: () => 12,
      phase: () => "waiting_input",
      beginPresentationTransition,
      cancelPresentationTransition,
      logWarning: vi.fn(),
      signalMessageSkip: vi.fn(),
    });

    await expect(input.submit({ type: "commit_text", value: "120" }, false)).rejects.toThrow(
      "transport failed",
    );
    expect(beginPresentationTransition).toHaveBeenCalledOnce();
    expect(cancelPresentationTransition).toHaveBeenCalledOnce();
  });
});
