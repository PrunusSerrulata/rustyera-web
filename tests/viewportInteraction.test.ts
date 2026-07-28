import { describe, expect, it } from "vitest";

import { isViewportContinuationClick } from "@/core/viewportInteraction";

describe("viewport Enter continuation", () => {
  it("accepts a primary click on game text but not a game button", () => {
    const viewport = document.createElement("main");
    const text = document.createElement("span");
    const button = document.createElement("button");
    viewport.append(text, button);

    expect(isViewportContinuationClick(click(text), viewport)).toBe(true);
    expect(isViewportContinuationClick(click(button), viewport)).toBe(false);
  });
});

function click(target: Element): MouseEvent {
  return { button: 0, target } as unknown as MouseEvent;
}
