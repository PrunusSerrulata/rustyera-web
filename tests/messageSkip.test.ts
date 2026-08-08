import { describe, expect, it } from "vitest";

import { isMessageSkipWait } from "@/core/messageSkip";

describe("runtime-owned continuous message skipping", () => {
  it("only starts from an Enter wait outside a skip barrier", () => {
    const wait = (wait_id: number, stop_message_skip = false) => ({
      wait_id,
      kind: "enter_key",
      stop_message_skip,
    });

    expect(isMessageSkipWait(wait(1))).toBe(true);
    expect(isMessageSkipWait(wait(2, true))).toBe(false);
    expect(isMessageSkipWait(undefined)).toBe(false);
  });
});
