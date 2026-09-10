import { describe, expect, it } from "vitest";
import {
  parseWindowsPerformanceProcesses,
  selectPerformanceProcessTree,
  selectWindowsPerformanceRootPid,
  performanceProfilerMode,
} from "../scripts/tauri-performance-audit.mjs";

const inventory = [
  {
    ProcessId: 10,
    ParentProcessId: 1,
    WorkingSetSize: "100",
    ExecutablePath: "C:\\node.exe",
    CommandLine: "node runner",
  },
  {
    ProcessId: 12,
    ParentProcessId: 11,
    WorkingSetSize: "300",
    ExecutablePath: "C:\\WebView.exe",
    CommandLine: null,
  },
  {
    ProcessId: 11,
    ParentProcessId: 10,
    WorkingSetSize: "200",
    ExecutablePath: "C:\\任务 空格\\app.exe",
    CommandLine: '"C:\\任务 空格\\app.exe"',
  },
  {
    ProcessId: 20,
    ParentProcessId: 1,
    WorkingSetSize: "400",
    ExecutablePath: "C:\\任务 空格\\app.exe",
    CommandLine: null,
  },
];

describe("Windows performance process ownership", () => {
  it("requires an explicit supported profiler mode", () => {
    expect(performanceProfilerMode(["--profilers", "none"], "win32")).toBe("none");
    expect(performanceProfilerMode([], "darwin")).toBe("native");
    expect(() => performanceProfilerMode([], "win32")).toThrow("require macOS");
    for (const args of [
      ["--profilers"],
      ["--profilers", "bad"],
      ["--profilers", "none", "--profilers", "native"],
    ])
      expect(() => performanceProfilerMode(args, "win32")).toThrow();
  });
  it("rejects malformed RSS instead of reporting fabricated zero bytes", () => {
    for (const rss of [undefined, null, "", false, [], -1, 1.5, "-1", "1.5", "9007199254740992"])
      expect(() =>
        parseWindowsPerformanceProcesses(
          JSON.stringify([{ ...inventory[0], WorkingSetSize: rss }]),
        ),
      ).toThrow();
    expect(() => parseWindowsPerformanceProcesses("[null]")).toThrow("inventory row");
  });
  it("resolves the runner-owned binary and includes its WebView children only", () => {
    const rows = parseWindowsPerformanceProcesses(`\uFEFF${JSON.stringify(inventory)}`);
    const owned = selectPerformanceProcessTree(rows, 10);
    expect(selectWindowsPerformanceRootPid(owned, "c:/任务 空格/APP.exe")).toBe(11);
    expect(selectPerformanceProcessTree(rows, 11).map((row) => row.pid)).toEqual([12, 11]);
    expect(rows[1]).toMatchObject({ rssBytes: 300, cpuPercent: null, command: "" });
  });

  it("rejects missing or ambiguous identity instead of selecting another session", () => {
    const rows = parseWindowsPerformanceProcesses(JSON.stringify(inventory));
    expect(() => selectWindowsPerformanceRootPid(rows, "C:\\任务 空格\\app.exe")).toThrow(
      "found 2",
    );
    expect(() => selectWindowsPerformanceRootPid(rows, "C:\\missing.exe")).toThrow("found 0");
    expect(() => selectPerformanceProcessTree(rows, 99)).toThrow("absent");
  });

  it("allows inaccessible system paths but rejects malformed inventory", () => {
    expect(
      parseWindowsPerformanceProcesses(
        JSON.stringify([{ ...inventory[0], ExecutablePath: null }]),
      )[0].executable,
    ).toBeNull();
    for (const value of [
      null,
      {},
      [inventory[0], inventory[0]],
      [{ ...inventory[0], ProcessId: -1 }],
      [{ ...inventory[0], WorkingSetSize: "bad" }],
    ])
      expect(() => parseWindowsPerformanceProcesses(JSON.stringify(value))).toThrow();
  });
});
