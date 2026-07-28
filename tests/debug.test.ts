import { describe, expect, it } from "vitest";

import {
  debugStopToken,
  debugVariableKey,
  formatDebugValue,
  refreshDebugStop,
  selectedDebugFiber,
  sourceLineStepCommand,
} from "@/core/debug";

describe("debug protocol projection", () => {
  const stopped = {
    stop: { session_epoch: 1n, pause_epoch: 2n, program_generation: 3n, runtime_revision: 4n },
    selected_fiber: 9n,
  };

  it("uses the public DebugStop field names for reads and source-line stepping", () => {
    expect(debugStopToken(stopped)).toBe(stopped.stop);
    expect(selectedDebugFiber(stopped)).toBe(9n);
    expect(sourceLineStepCommand(stopped)).toEqual({
      type: "step",
      stop: stopped.stop,
      fiber_id: 9n,
      kind: "source_line",
    });
  });

  it("formats tagged and bigint debugger values and keys", () => {
    expect(formatDebugValue({ type: "integer", value: 42n })).toBe("42");
    expect(debugVariableKey({ symbol_key: [1n, 2n] })).toBe('["1","2"]');
  });

  it("accepts the refreshed stop returned after a debug mutation", () => {
    const refreshed = { ...stopped.stop, runtime_revision: 5n };
    expect(refreshDebugStop(stopped, { stop: refreshed })).toEqual({
      ...stopped,
      stop: refreshed,
    });
  });
});
