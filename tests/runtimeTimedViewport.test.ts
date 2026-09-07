import { describe, expect, it } from "vitest";

import { MAXIMUM_NF_FRAME_RECOVERY_NS, nfFrameRecoveryNs } from "@/stores/runtimeTimedViewport";
import { TIME_ADVANCE_INTERVAL_NS } from "@/stores/runtimeState";

describe("timed NF viewport recovery", () => {
  it("gives the first frame one scheduler interval", () => {
    expect(nfFrameRecoveryNs(undefined)).toBe(TIME_ADVANCE_INTERVAL_NS);
  });

  it("matches a subsequent frame's actual build time", () => {
    expect(nfFrameRecoveryNs(120_000_000)).toBe(120_000_000);
  });

  it("caps even an extremely long frame instead of falling back to immediate refresh", () => {
    expect(nfFrameRecoveryNs(1_500_000_000)).toBe(MAXIMUM_NF_FRAME_RECOVERY_NS);
  });
});
