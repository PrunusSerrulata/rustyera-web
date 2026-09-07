import { TIME_ADVANCE_INTERVAL_NS } from "@/stores/runtimeState";

export const MAXIMUM_NF_FRAME_RECOVERY_NS = 250_000_000;

/** Keep an overdue NF frame interactable in proportion to the work that produced it. */
export function nfFrameRecoveryNs(elapsedSinceAdvanceNs: number | undefined): number {
  if (elapsedSinceAdvanceNs == null || !Number.isFinite(elapsedSinceAdvanceNs))
    return TIME_ADVANCE_INTERVAL_NS;
  return Math.min(
    MAXIMUM_NF_FRAME_RECOVERY_NS,
    Math.max(TIME_ADVANCE_INTERVAL_NS, elapsedSinceAdvanceNs),
  );
}
