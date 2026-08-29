import type { CompatibilityIdentity } from "@/core/compatibility";

/** Captured public compatibility policy fixtures, not a frontend policy implementation. */
export function referenceCompatibility(): CompatibilityIdentity {
  return {
    profile: "emuera.em",
    semantic_version: 1,
    policy_version: 1,
    arithmetic: "wrapping_i64_v1",
    rng_algorithm: "sfmt19937",
    rng_state_version: 1,
    layout: "unicode_column_v1",
    save_codec: "emuera1808",
    services: [],
  };
}

export function snakeCompatibility(): CompatibilityIdentity {
  return {
    ...referenceCompatibility(),
    profile: "emuera.skia.snake",
    semantic_version: 8,
    policy_version: 8,
    arithmetic: "snake_saturating_i64_v1",
    save_codec: "rustyera_envelope_v1:emuera1808",
  };
}
