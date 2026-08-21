import { describe, expect, it } from "vitest";

import {
  CONSTRAINED_MOBILE_USER_AGENT,
  browserBenchmarkCommandArgs,
  compareDirectoryAndProjectFile,
  latestSuccessfulStartupTelemetry,
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
      scenario: "cold",
      wasmMode: "single",
      wasmMemory: { constrained: true, peakBytes: 128 * 1024 * 1024, stages: {} },
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

  it("accepts a packaged-project cache baseline with WASM memory telemetry", () => {
    expect(() =>
      validateStartupSample(
        completeSample({
          cacheHit: true,
          scenario: "project_file",
          durations: {
            ...completeSample().telemetry.durations,
            cacheParseMs: 1,
            cacheDecodeMs: 1,
            cacheValidateMs: 1,
          },
        }),
        "browser-project-file",
      ),
    ).not.toThrow();
  });

  it("builds constrained mobile commands against an explicit matching project file", () => {
    expect(
      browserBenchmarkCommandArgs({
        scenario: "project-file.json",
        project: "/games/custom",
        projectFile: "/games/custom/custom.reraproj",
        trace: "/tmp/trace.ndjson",
      }),
    ).toEqual([
      "scripts/web-test.mjs",
      "run",
      "--scenario",
      "project-file.json",
      "--project",
      "/games/custom",
      "--trace",
      "/tmp/trace.ndjson",
      "--user-agent",
      CONSTRAINED_MOBILE_USER_AGENT,
      "--project-file",
      "/games/custom/custom.reraproj",
    ]);
    expect(
      browserBenchmarkCommandArgs({
        scenario: "warm.json",
        project: "/games/custom",
        trace: "/tmp/warm.ndjson",
        constrained: false,
      }),
    ).not.toContain("--user-agent");
  });

  it("reports equal-sample directory overhead against the packaged baseline", () => {
    const report = compareDirectoryAndProjectFile(
      {
        samples: [completeSample(), completeSample()],
        metrics: {
          peakRssBytes: { p50: 150, p95: 200 },
          "telemetry.wasmMemory.peakBytes": { p50: 120, p95: 180 },
        },
      },
      {
        samples: [completeSample(), completeSample()],
        metrics: {
          peakRssBytes: { p50: 100, p95: 160 },
          "telemetry.wasmMemory.peakBytes": { p50: 100, p95: 150 },
        },
      },
    );

    expect(report).toMatchObject({
      sampleCount: 2,
      wasmMemoryPeakBytes: {
        p50: { directory: 120, projectFile: 100, delta: 20, ratio: 1.2 },
        p95: { directory: 180, projectFile: 150, delta: 30, ratio: 1.2 },
      },
      peakRssBytes: { p50: { delta: 50, ratio: 1.5 }, p95: { delta: 40, ratio: 1.25 } },
    });
    expect(() =>
      compareDirectoryAndProjectFile(
        { samples: [completeSample()], metrics: {} },
        { samples: [completeSample(), completeSample()], metrics: {} },
      ),
    ).toThrow("same sample count");
  });

  it("extracts successful telemetry from complete browser observations", () => {
    const telemetry = completeSample().telemetry;
    expect(
      latestSuccessfulStartupTelemetry([
        { rust: { frontend: { startupTelemetry: { outcome: "loading" } } } },
        { rust: { frontend: { startupTelemetry: telemetry } } },
      ]),
    ).toBe(telemetry);
  });
});
