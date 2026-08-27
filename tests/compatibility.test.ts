import { describe, expect, it } from "vitest";
import {
  compatibilityCbor,
  formatCompatibilityContext,
  requireCompatibilityIdentity,
} from "@/core/compatibility";
import { formatDiagnostic } from "@/core/runtimeSupport";
import { parseProjectConfiguration } from "@/core/configuration";
import { snakeCompatibility } from "./compatibilityTestSupport";

describe("compatibility protocol projection", () => {
  it("preserves actual snake policies and rejects missing or unknown identity", () => {
    const identity = snakeCompatibility();
    expect(requireCompatibilityIdentity(identity)).toEqual(identity);
    expect(compatibilityCbor(identity).get(0)).toBe(1);
    expect(compatibilityCbor(identity).get(3)).toBe("wrapping_i64_v1");
    expect(() => requireCompatibilityIdentity(undefined)).toThrow();
    expect(() => requireCompatibilityIdentity({ ...identity, profile: "snake" })).toThrow();
    expect(() => requireCompatibilityIdentity({ ...identity, policy_version: 0 })).toThrow();
  });

  it("shows profile, stage, API and required capability in existing diagnostics", () => {
    const context = {
      identity: snakeCompatibility(),
      stage: "service",
      api: "GCREATE",
      required_capability: {
        kind: "graphics",
        operation: "create",
        version: { major: 1, minor: 0 },
      },
    };
    const formatted = formatCompatibilityContext(context);
    expect(formatted).toContain("emuera.skia.snake@1/1");
    expect(formatted).toContain("stage=service api=GCREATE requires=graphics.create@1.0");
    expect(
      formatDiagnostic({
        code: "compatibility.experimental_profile",
        message: "experimental",
        context,
      }),
    ).toContain(formatted);
  });

  it("normalizes lossless WASM version integers in configuration and diagnostics", () => {
    const identity = {
      ...snakeCompatibility(),
      semantic_version: 1n,
      policy_version: 1n,
      rng_state_version: 1n,
      services: [{ name: "example", version: 0xffff_ffffn }],
    };
    const expected = {
      ...snakeCompatibility(),
      services: [{ name: "example", version: 0xffff_ffff }],
    };
    expect(requireCompatibilityIdentity(identity)).toEqual(expected);
    expect(
      parseProjectConfiguration({
        project_revision: 1n,
        source_digest: new Uint8Array(32),
        entries: [],
        restart_pending: false,
        generated_source: null,
        compatibility: identity,
      }).compatibility,
    ).toEqual(expected);
    expect(formatCompatibilityContext({ identity, stage: "configuration" })).toBe(
      "profile=emuera.skia.snake@1/1 stage=configuration",
    );
    for (const value of [0n, -1n, 0x1_0000_0000n, "1", Number.NaN]) {
      expect(() => requireCompatibilityIdentity({ ...identity, policy_version: value })).toThrow();
    }
  });
});
