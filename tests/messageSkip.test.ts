import { describe, expect, it } from "vitest";

import {
  isMessageContinuationWait,
  isMessageSkipWait,
  messageWaitIntent,
} from "@/core/messageSkip";

describe("runtime-owned continuous message skipping", () => {
  it("starts from Enter and AnyKey waits outside a skip barrier", () => {
    const wait = (wait_id: number, kind: string, stop_message_skip = false) => ({
      wait_id,
      kind,
      stop_message_skip,
    });

    expect(isMessageSkipWait(wait(1, "enter_key"))).toBe(true);
    expect(isMessageSkipWait(wait(2, "any_key"))).toBe(true);
    expect(isMessageSkipWait(wait(3, "any_key", true))).toBe(false);
    expect(isMessageSkipWait(wait(4, "integer_value"))).toBe(false);
    expect(isMessageSkipWait(undefined)).toBe(false);
  });

  it("creates the protocol intent required by each message wait", () => {
    const enter = { wait_id: 1, kind: "enter_key" as const };
    const anyKey = { wait_id: 2, kind: "any_key" as const };

    expect(isMessageContinuationWait(enter)).toBe(true);
    expect(isMessageContinuationWait(anyKey)).toBe(true);
    expect(messageWaitIntent(enter)).toEqual({ type: "enter" });
    expect(messageWaitIntent(anyKey)).toEqual({ type: "any_key", value: "\n" });
  });
});
