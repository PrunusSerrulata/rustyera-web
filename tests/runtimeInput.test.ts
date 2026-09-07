import { describe, expect, it, vi } from "vitest";

import { emptyPresentation } from "@/core/presentation";
import { RuntimeInputState } from "@/stores/runtimeInput";

describe("runtime input presentation boundary", () => {
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
