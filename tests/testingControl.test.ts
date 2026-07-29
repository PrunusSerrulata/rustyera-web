import { describe, expect, it } from "vitest";

import { isStableObservationCandidate } from "@/testing/control";

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
  });
});
