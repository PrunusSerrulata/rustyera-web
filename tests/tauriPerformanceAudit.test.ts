import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  classifyWindowCalibration,
  performanceAuditOptions,
} from "../scripts/tauri-performance-audit.mjs";
import { readPerformanceTrace, summarizeSamples } from "../scripts/tauri-performance-trace.mjs";
import { PerformanceAuditRingBuffer } from "../src/testing/performanceAudit";

describe("Tauri performance audit runner policy", () => {
  const valid = [
    "--perf-audit",
    "--background-dom",
    "--release",
    "--project",
    "/isolated/snake-tw",
    "--spec",
    "tests/tauri/snake-runtime-performance.spec.mjs",
    "--window-mode",
    "minimized",
  ];

  it("accepts only the release background single-spec profile", () => {
    expect(performanceAuditOptions(valid, "snake-runtime-performance.spec.mjs")).toEqual({
      enabled: true,
      windowMode: "minimized",
    });
    for (const required of ["--background-dom", "--release", "--project", "--window-mode"]) {
      const index = valid.indexOf(required);
      const length = required === "--project" || required === "--window-mode" ? 2 : 1;
      expect(() =>
        performanceAuditOptions(
          [...valid.slice(0, index), ...valid.slice(index + length)],
          "snake-runtime-performance.spec.mjs",
        ),
      ).toThrow();
    }
    expect(() => performanceAuditOptions(valid, "snake-profile.spec.mjs")).toThrow("single");
  });

  it("selects offscreen evidence when minimized WebKit is throttled", () => {
    expect(
      classifyWindowCalibration(
        {
          medianIntervalMs: 21,
          medianPaintCheckpointMs: 21,
          nonBusinessStallsOver100Ms: 0,
          timedOut: false,
        },
        {
          medianIntervalMs: 16,
          medianPaintCheckpointMs: 16,
          nonBusinessStallsOver100Ms: 0,
          timedOut: false,
        },
      ),
    ).toMatchObject({ selectedMode: "offscreen", minimizedThrottled: true });
    expect(
      classifyWindowCalibration(
        {
          medianIntervalMs: 16.5,
          medianPaintCheckpointMs: 16.5,
          nonBusinessStallsOver100Ms: 0,
          timedOut: false,
        },
        {
          medianIntervalMs: 16,
          medianPaintCheckpointMs: 16,
          nonBusinessStallsOver100Ms: 0,
          timedOut: false,
        },
      ),
    ).toMatchObject({ selectedMode: "minimized", minimizedThrottled: false });
  });

  it("rejects duplicate values, injected state, and incomplete options", () => {
    expect(() => performanceAuditOptions([...valid, "--project", "/other"], "snake-runtime-performance.spec.mjs")).toThrow("exactly");
    expect(() => performanceAuditOptions([...valid, "--state", "/save"], "snake-runtime-performance.spec.mjs")).toThrow("forbidden");
    const mode = valid.indexOf("minimized");
    expect(() => performanceAuditOptions([...valid.slice(0, mode)], "snake-runtime-performance.spec.mjs")).toThrow("value");
  });

  it("reports input percentiles and coefficient of variation", () => {
    expect(summarizeSamples([10, 20, 30, 40, 50])).toMatchObject({
      count: 5,
      p50: 30,
      p95: 40,
      p99: 40,
      minimum: 10,
      maximum: 50,
    });
  });

  it("bounds frontend telemetry with a constant-time ring and reports drops", () => {
    const buffer = new PerformanceAuditRingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    expect(buffer.values()).toEqual([3, 4, 5]);
    expect(buffer.dropped).toBe(2);
    buffer.clear();
    expect(buffer.values()).toEqual([]);
    expect(buffer.dropped).toBe(0);
  });

  it("refuses the honest capture-required trace template", async () => {
    await expect(
      readPerformanceTrace(
        new URL("fixtures/snake-runtime-performance-trace.v1.json", import.meta.url),
      ),
    ).rejects.toThrow("requires autonomous capture");
  });

  it("allows one prepared build and requires the identical artifact thereafter", () => {
    const runner = readFileSync(
      new URL("../scripts/tauri-performance-runner.mjs", import.meta.url),
      "utf8",
    );
    expect(runner).toContain('buildPrepared ? "--require-reuse-build" : "--reuse-build"');
    expect(runner).toContain("buildPrepared = true");
    expect(runner).toContain("for (let index = 0; index < 5; index += 1)");
    expect(runner).toContain("RUSTYERA_TEST_WALL_CLOCK_DEADLINE_MS");
  });

  it("keeps capture self-contained and foreground checks bound to the exact process tree", () => {
    const capture = readFileSync(
      new URL("../scripts/tauri-performance-capture.mjs", import.meta.url),
      "utf8",
    );
    const audit = readFileSync(
      new URL("../scripts/tauri-performance-audit.mjs", import.meta.url),
      "utf8",
    );
    expect(capture).not.toContain('"--reuse-build"');
    expect(audit).toContain("processTree.some((process) => process.pid === foreground?.pid)");
    expect(audit).not.toContain('foreground?.bundleIdentifier === "org.rustyera.web"');
  });

  it("uses one epoch and JSONL sample schema for loading and runtime", () => {
    const repository = new URL("..", import.meta.url);
    const packageJson = JSON.parse(readFileSync(new URL("package.json", repository), "utf8"));
    const telemetry = readFileSync(
      new URL("src/testing/performanceAudit.ts", repository),
      "utf8",
    );
    const startupProjection = readFileSync(
      new URL("src/stores/runtimeStartupTelemetry.ts", repository),
      "utf8",
    );
    const spec = readFileSync(
      new URL("tests/tauri/snake-runtime-performance.spec.mjs", repository),
      "utf8",
    );
    expect(packageJson.scripts["benchmark:startup"]).toBe(
      packageJson.scripts["audit:tauri-performance"],
    );
    expect(existsSync(new URL("scripts/startup-benchmark.mjs", repository))).toBe(false);
    expect(telemetry).toContain('| "loading"');
    expect(startupProjection).toContain('recordPerformanceElapsed("loading"');
    expect(spec).toContain('type: "tauri-performance-sample"');
    expect(spec).toContain('segment: sample.phase === "loading" ? "loading" : "runtime"');
  });
});
