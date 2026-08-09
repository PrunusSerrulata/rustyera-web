import { describe, expect, it } from "vitest";

import { nextOpeningAction, OPENING_INTRO_TIMEOUT } from "./tauri/rorona-flow.mjs";

describe("Erarorona opening flow", () => {
  it("uses the original three-second introduction limit", () => {
    expect(OPENING_INTRO_TIMEOUT).toBe(3_000);
  });

  it("requires one right/left pair for each scripted FADE_ALL boundary", () => {
    const states = [
      openingState("亚兰德――", false),
      openingState("开一间炼金术的工房。", true),
      openingState("之后时光流逝，直到现在――", false),
      openingState("萝乐娜――", true),
    ];

    expect(states.map((state, index) => nextOpeningAction(state, index)?.button)).toEqual([
      "right",
      "left",
      "right",
      "left",
    ]);
  });

  it("accepts only the workshop script boundary as completion", () => {
    expect(nextOpeningAction(openingState("萝乐娜――", true), 4)).toBeNull();
    expect(nextOpeningAction(openingState("亚斯特丽德的工房", false), 4)).toEqual({
      done: true,
    });
  });

  it("does not click an incompatible or non-interactive wait", () => {
    expect(nextOpeningAction(openingState("亚兰德――", true), 0)).toBeNull();
    expect(nextOpeningAction(openingState("亚兰德――\n开一间炼金术的工房。", false), 0)).toBeNull();
    const missingSkipBoundary = openingState("亚兰德――", false);
    delete missingSkipBoundary.wait.stop_message_skip;
    expect(nextOpeningAction(missingSkipBoundary, 0)).toBeNull();
    expect(
      nextOpeningAction(
        {
          ...openingState("亚兰德――", false),
          wait: { kind: "any_key", stop_message_skip: false },
        },
        0,
      ),
    ).toBeNull();
    expect(
      nextOpeningAction(
        {
          ...openingState("亚兰德――", false),
          canInteract: false,
        },
        0,
      ),
    ).toBeNull();
  });
});

function openingState(text, stopMessageSkip) {
  return {
    canInteract: true,
    wait: { kind: "enter_key", stop_message_skip: stopMessageSkip },
    output: [text],
  };
}
