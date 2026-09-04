import { describe, expect, it } from "vitest";

import { snapshotProgressSignature } from "../scripts/tauri-test-support.mjs";

describe("Tauri complete snapshot policy", () => {
  it("ignores timestamps and the elapsed-time-only loading suffix", () => {
    const first = {
      capturedAt: "2026-08-07T00:00:00Z",
      document: [{ text: "正在准备 Runtime 资源：661/661（100%） · 已等待 5 秒" }],
      runtime: {
        projectLoadProgressLabel: "正在准备 Runtime 资源：661/661（100%） · 已等待 5 秒",
        timestamp: "first",
      },
    };
    const second = {
      capturedAt: "2026-08-07T00:00:05Z",
      document: [{ text: "正在准备 Runtime 资源：661/661（100%） · 已等待 10 秒" }],
      runtime: {
        projectLoadProgressLabel: "正在准备 Runtime 资源：661/661（100%） · 已等待 10 秒",
        timestamp: "second",
      },
    };

    expect(snapshotProgressSignature(first)).toBe(snapshotProgressSignature(second));
  });

  it("does not treat audit, profiler, or process observations as game progress", () => {
    const first = {
      document: [{ text: "stable" }],
      runtime: {
        phase: "waiting_input",
        performanceAudit: { timingSamples: 1 },
        startupTelemetry: { elapsedMs: 1 },
        memory: { residentBytes: 1 },
      },
      windowSafety: { processTree: [{ pid: 1, cpuPercent: 1 }] },
      profiler: { samples: 1 },
    };
    const second = {
      document: [{ text: "stable" }],
      runtime: {
        phase: "waiting_input",
        performanceAudit: { timingSamples: 200 },
        startupTelemetry: { elapsedMs: 200 },
        memory: { residentBytes: 999 },
      },
      windowSafety: { processTree: [{ pid: 1, cpuPercent: 99 }] },
      profiler: { samples: 50 },
    };

    expect(snapshotProgressSignature(first)).toBe(snapshotProgressSignature(second));
  });
});
