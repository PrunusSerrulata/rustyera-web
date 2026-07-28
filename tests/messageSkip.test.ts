import { describe, expect, it } from "vitest";

import { MessageSkipController } from "@/core/messageSkip";

describe("continuous Enter-wait message skipping", () => {
  it("submits each consecutive Enter wait once and stops at a skip barrier", () => {
    const controller = new MessageSkipController();
    const wait = (wait_id: number, stop_message_skip = false) => ({
      wait_id,
      kind: "enter_key",
      stop_message_skip,
    });

    expect(controller.start(wait(1))).toBe(true);
    expect(controller.continue(wait(1))).toBe(false);
    expect(controller.continue(undefined)).toBe(false);
    expect(controller.continue(wait(2))).toBe(true);
    expect(controller.continue(wait(3, true))).toBe(false);
    expect(controller.continue(wait(4))).toBe(false);
  });

  it("is cancelled by ordinary input", () => {
    const controller = new MessageSkipController();
    expect(controller.start({ wait_id: 1, kind: "enter_key" })).toBe(true);
    controller.cancel();
    expect(controller.continue({ wait_id: 2, kind: "enter_key" })).toBe(false);
  });
});
