import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCompleteSnapshotMonitor } from "../scripts/tauri-test-support.mjs";
import { finalizeBrowserGameRun } from "../scripts/web-test-lifecycle.mjs";

afterEach(() => vi.useRealTimers());

describe("browser game runner progress policy", () => {
  it("uses the shared five-second complete snapshot monitor", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");

    expect(runner).toContain(
      'import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs"',
    );
    expect(runner).toContain('eventType: "browser-game-snapshot"');
    expect(runner).toContain("snapshotMonitor.failure");
    expect(runner).not.toContain("OBSERVATION_REPORT_MS");
    expect(runner).not.toContain("OBSERVATION_STALL_MS");
  });

  it("sets the repository browser path before importing Playwright", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");

    expect(runner.indexOf("process.env.PLAYWRIGHT_BROWSERS_PATH")).toBeGreaterThan(-1);
    expect(runner.indexOf("process.env.PLAYWRIGHT_BROWSERS_PATH")).toBeLessThan(
      runner.indexOf('import("@playwright/test")'),
    );
  });

  it("starts delayed captures on an absolute five-second cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const captureStarts: number[] = [];
    let capture = 0;
    const browser = {
      execute: vi.fn(
        () =>
          new Promise((resolveSnapshot) => {
            captureStarts.push(Date.now());
            const current = ++capture;
            setTimeout(
              () =>
                resolveSnapshot({
                  document: [{ tag: "main", text: String(current) }],
                  runtime: { phase: String(current) },
                }),
              2_000,
            );
          }),
      ),
    };
    const monitor = startCompleteSnapshotMonitor(browser, {
      interval: 5_000,
      output: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await monitor.stop();

    expect(captureStarts).toEqual([0, 5_000, 10_000]);
  });

  it("records one monitor failure result, closes trace last, and attempts every cleanup", async () => {
    const events: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    const originalMonitorError = new Error("identical complete snapshots");
    const cleanups = [
      vi.fn(() => order.push("cleanup-1")),
      vi.fn(() => {
        order.push("cleanup-2");
        throw new Error("secondary cleanup failure");
      }),
      vi.fn(() => order.push("cleanup-3")),
    ];
    const trace = {
      emit: vi.fn((event) => {
        events.push(event);
        order.push(event.type);
      }),
      close: vi.fn(async () => {
        order.push("close");
      }),
    };

    const exitCode = await finalizeBrowserGameRun({
      outcome: { exitCode: 0, result: { status: "passed" } },
      runError: new Error("page closed after monitor failure"),
      monitor: { stop: vi.fn(async () => Promise.reject(new Error("secondary stop failure"))) },
      monitorError: () => originalMonitorError,
      cleanups,
      trace,
      classifyError: () => ({ exitCode: 3, result: { status: "infrastructure_failure" } }),
    });

    expect(exitCode).toBe(3);
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", status: "infrastructure_failure" },
    ]);
    expect(events.find((event) => event.type === "error")?.message).toContain(
      "identical complete snapshots",
    );
    expect(events.find((event) => event.type === "error")?.message).not.toContain(
      "page closed after monitor failure",
    );
    expect(order.at(-1)).toBe("close");
    expect(order.indexOf("result")).toBeLessThan(order.indexOf("close"));
  });
});
