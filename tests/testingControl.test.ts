import { describe, expect, it } from "vitest";

import { inputReplaySummary, isStableObservationCandidate } from "@/testing/control";

describe("Web test observation boundaries", () => {
  it("keeps waiting while the runtime is running without an input boundary", () => {
    expect(isStableObservationCandidate("running", false, null)).toBe(false);
    expect(isStableObservationCandidate("waiting_external", false, null)).toBe(false);
  });

  it("accepts interactive, paused, terminal, and fault boundaries", () => {
    expect(isStableObservationCandidate("waiting_input", true, null)).toBe(true);
    expect(isStableObservationCandidate("debug_paused", false, null)).toBe(true);
    expect(isStableObservationCandidate("stopped", false, null)).toBe(true);
    expect(isStableObservationCandidate("running", false, { message: "fault" })).toBe(true);
    expect(isStableObservationCandidate("waiting_input", false, null, true)).toBe(true);
  });

  it("keeps waiting for diagnosis export even at a fault boundary", () => {
    expect(isStableObservationCandidate("faulted", false, { message: "fault" }, false, true)).toBe(
      false,
    );
  });

  it("reports malformed operation-sequence downloads without breaking snapshots", () => {
    expect(inputReplaySummary(new TextEncoder().encode("not-json\n"))).toEqual({
      replayParseError: "input replay line 1 is not valid JSON",
    });
    expect(inputReplaySummary(Uint8Array.of(0xff))).toEqual({
      replayParseError: "input replay is not valid UTF-8",
    });
  });
});
