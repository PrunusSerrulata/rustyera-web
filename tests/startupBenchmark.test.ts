import { describe, expect, it } from "vitest";

import {
  percentile,
  summarizeStartupSamples,
  validateStartupSample,
} from "../scripts/startup-benchmark-lib.mjs";

function completeSample(overrides: Record<string, unknown> = {}) {
  return {
    peakRssBytes: 100,
    telemetry: {
      outcome: "success",
      cacheHit: false,
      wasmMode: "single",
      milestones: {
        runtimeValidationReportedMs: 1,
        frontendReadyToStartMs: 2,
        startSubmittedMs: 3,
        firstGamePhaseMs: 4,
      },
      durations: {
        enumerateMs: 1,
        indexReadMs: 1,
        indexWriteMs: 1,
        statMs: 1,
        sourceReadDecodeHashMs: 1,
        cacheReadMs: 1,
        submissionTransferMs: 1,
        normalizeMs: 1,
        csvMs: 1,
        parseMs: 1,
        analyzeMs: 1,
        compileMs: 1,
        finalizeMs: 1,
        validateMs: 1,
        prepareMs: 1,
      },
      sourceIndex: { present: false, trusted: false, reusedFiles: 0, hashedFiles: 1 },
      ...overrides,
    },
  };
}

describe("startup benchmark reports", () => {
  it("uses nearest-rank p50 and p95", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it("keeps raw samples and numeric summaries", () => {
    const report = summarizeStartupSamples([
      { peakRssBytes: 10, telemetry: { milestones: { firstGamePhaseMs: 20 } } },
      { peakRssBytes: 30, telemetry: { milestones: { firstGamePhaseMs: 40 } } },
    ]);
    expect(report.samples).toHaveLength(2);
    expect(report.metrics["peakRssBytes"]).toEqual({ p50: 10, p95: 30 });
  });

  it("rejects missing phases, memory, mode, and cache/index proof", () => {
    expect(() => validateStartupSample(completeSample(), "browser-exact-cold")).not.toThrow();
    expect(() =>
      validateStartupSample(
        completeSample({ durations: { enumerateMs: 1 } }),
        "browser-exact-cold",
      ),
    ).toThrow("incomplete");
    expect(() =>
      validateStartupSample({ ...completeSample(), peakRssBytes: 0 / 0 }, "browser-exact-cold"),
    ).toThrow("peakRssBytes");
  });
});
