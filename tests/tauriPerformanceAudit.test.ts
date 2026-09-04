import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyWindowCalibration,
  instrumentedPerformanceWindowMode,
  performanceAuditOptions,
  performanceWindowArguments,
  performanceWindowMode,
} from "../scripts/tauri-performance-audit.mjs";
import { readPerformanceTrace, summarizeSamples } from "../scripts/tauri-performance-trace.mjs";
import { PerformanceAuditRingBuffer } from "../src/testing/performanceAudit";

describe("Tauri performance audit runner policy", () => {
  const valid = [
    "--perf-audit",
    "--release",
    "--project",
    "/isolated/snake-tw",
    "--spec",
    "tests/tauri/snake-runtime-performance.spec.mjs",
  ];

  it("defaults to an ordinary visible window for the release single-spec profile", () => {
    expect(performanceAuditOptions(valid, "snake-runtime-performance.spec.mjs")).toEqual({
      enabled: true,
      background: false,
      windowMode: "visible",
    });
    for (const required of ["--release", "--project"]) {
      const index = valid.indexOf(required);
      const length = required === "--project" ? 2 : 1;
      expect(() =>
        performanceAuditOptions(
          [...valid.slice(0, index), ...valid.slice(index + length)],
          "snake-runtime-performance.spec.mjs",
        ),
      ).toThrow();
    }
    expect(() => performanceAuditOptions(valid, "snake-profile.spec.mjs")).toThrow("single");
  });

  it("gives profile-enabled instrumentation a valid native window mode", () => {
    const ordinary = { enabled: false, background: false, windowMode: undefined };
    expect(instrumentedPerformanceWindowMode(ordinary, false)).toBeUndefined();
    expect(instrumentedPerformanceWindowMode(ordinary, true)).toBe("visible");
    expect(
      instrumentedPerformanceWindowMode(
        { enabled: true, background: true, windowMode: "offscreen" },
        true,
      ),
    ).toBe("offscreen");
  });

  it("enables hidden-window safeguards only when explicitly requested", () => {
    const minimized = [...valid, "--background-dom", "--window-mode", "minimized"];
    expect(performanceAuditOptions(minimized, "snake-runtime-performance.spec.mjs")).toEqual({
      enabled: true,
      background: true,
      windowMode: "minimized",
    });
    expect(() =>
      performanceAuditOptions(
        [...valid, "--window-mode", "offscreen"],
        "snake-runtime-performance.spec.mjs",
      ),
    ).toThrow("requires --background-dom");
    expect(() =>
      performanceAuditOptions([...valid, "--background-dom"], "snake-runtime-performance.spec.mjs"),
    ).toThrow("requires minimized or offscreen");
  });

  it("parses one shared window policy for capture and replay child processes", () => {
    expect(performanceWindowMode([])).toBe("visible");
    expect(performanceWindowMode(["--window-mode", "visible"])).toBe("visible");
    expect(performanceWindowArguments("visible")).toEqual(["--window-mode", "visible"]);
    expect(performanceWindowArguments("minimized")).toEqual([
      "--background-dom",
      "--window-mode",
      "minimized",
    ]);
    expect(performanceWindowArguments("offscreen")).toEqual([
      "--background-dom",
      "--window-mode",
      "offscreen",
    ]);
    expect(() => performanceWindowMode(["--window-mode", "hidden"])).toThrow("must be visible");
    expect(() =>
      performanceWindowMode(["--window-mode", "visible", "--window-mode", "offscreen"]),
    ).toThrow("only once");
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
    expect(() =>
      performanceAuditOptions(
        [...valid, "--project", "/other"],
        "snake-runtime-performance.spec.mjs",
      ),
    ).toThrow("exactly");
    expect(() =>
      performanceAuditOptions([...valid, "--state", "/save"], "snake-runtime-performance.spec.mjs"),
    ).toThrow("forbidden");
    expect(() =>
      performanceAuditOptions([...valid, "--window-mode"], "snake-runtime-performance.spec.mjs"),
    ).toThrow("value");
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
      readPerformanceTrace(resolve("tests/fixtures/snake-runtime-performance-trace.v1.json")),
    ).rejects.toThrow("requires autonomous capture");
  });

  it("allows one prepared build and requires the identical artifact thereafter", () => {
    const runner = readFileSync(resolve("scripts/tauri-performance-runner.mjs"), "utf8");
    expect(runner).toContain('buildPrepared ? "--require-reuse-build" : "--reuse-build"');
    expect(runner).toContain("buildPrepared = true");
    expect(runner).toContain("for (let index = 0; index < 5; index += 1)");
    expect(runner).toContain("RUSTYERA_TEST_WALL_CLOCK_DEADLINE_MS");
  });

  it("keeps capture self-contained and foreground checks bound to the exact process tree", () => {
    const capture = readFileSync(resolve("scripts/tauri-performance-capture.mjs"), "utf8");
    const audit = readFileSync(resolve("scripts/tauri-performance-audit.mjs"), "utf8");
    expect(capture).not.toContain('"--reuse-build"');
    expect(audit).toContain("processTree.some((process) => process.pid === foreground?.pid)");
    expect(audit).not.toContain('foreground?.bundleIdentifier === "org.rustyera.web"');
  });

  it("uses one epoch and JSONL sample schema for loading and runtime", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const telemetry = readFileSync(resolve("src/testing/performanceAudit.ts"), "utf8");
    const startupProjection = readFileSync(
      resolve("src/stores/runtimeStartupTelemetry.ts"),
      "utf8",
    );
    const spec = readFileSync(resolve("tests/tauri/snake-runtime-performance.spec.mjs"), "utf8");
    expect(packageJson.scripts["benchmark:startup"]).toBe(
      packageJson.scripts["audit:tauri-performance"],
    );
    expect(existsSync(resolve("scripts/startup-benchmark.mjs"))).toBe(false);
    expect(telemetry).toContain('| "loading"');
    expect(startupProjection).toContain('recordPerformanceElapsed("loading"');
    expect(spec).toContain('type: "tauri-performance-sample"');
    expect(spec).toContain('segment: sample.phase === "loading" ? "loading" : "runtime"');
  });
});
