import { describe, expect, it } from "vitest";

import {
  MAXIMUM_DEBUG_CONSOLE_BYTES,
  MAXIMUM_DEBUG_CONSOLE_ENTRIES,
  RuntimeDebugState,
} from "@/stores/runtimeDebugState";

describe("runtime debug console memory budgets", () => {
  it("retains only the newest configured number of console entries", () => {
    const state = new RuntimeDebugState();
    const output = Array.from({ length: MAXIMUM_DEBUG_CONSOLE_ENTRIES + 1 }, (_, index) =>
      String(index),
    );

    state.applyResponse({ type: "console", value: { output } });

    expect(state.output.value).toHaveLength(MAXIMUM_DEBUG_CONSOLE_ENTRIES);
    expect(state.output.value[0]).toBe("1");
  });

  it("bounds retained UTF-16 console text independently of the entry count", () => {
    const state = new RuntimeDebugState();
    const line = "x".repeat(MAXIMUM_DEBUG_CONSOLE_BYTES / 4);

    state.applyResponse({ type: "console", value: { output: [line, line, line] } });

    expect(state.output.value).toEqual([line, line]);
  });
});
