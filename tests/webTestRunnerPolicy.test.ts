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
    expect(runner).toContain("action.settle_auto_enter ?? action.auto_enter !== false");
    expect(runner).toContain("action.observe !== false");
  });

  it("sets the repository browser path before importing Playwright", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");

    expect(runner.indexOf("process.env.PLAYWRIGHT_BROWSERS_PATH")).toBeGreaterThan(-1);
    expect(runner.indexOf("process.env.PLAYWRIGHT_BROWSERS_PATH")).toBeLessThan(
      runner.indexOf('import("@playwright/test")'),
    );
  });

  it("forces native-browser startup measurements to use empty OPFS and cold telemetry", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('compatibilityStage = "clearing OPFS for cold startup"');
    expect(runner).toContain("await root.removeEntry(name, { recursive: true })");
    expect(runner).toContain("opfsReset.remaining?.length");
    expect(runner).toContain('entry.name === ".rustyera"');
    expect(runner).toContain("assertColdStartup(observed.startupTelemetry)");
    expect(runner).toContain('telemetry?.scenario !== "cold"');
    expect(runner).toContain("telemetry.cacheHit !== false");
    expect(runner).toContain('telemetry.outcome !== "success"');
  });

  it("materializes portable browser files without joining large base64 payloads", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain("chunks.push(Uint8Array.from(raw");
    expect(runner).toContain("new File(chunks");
    expect(runner).not.toContain('atob(chunks.join(""))');
  });

  it("provides a native-browser game-log input smoke flow", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('process.argv.includes("--log-input-smoke")');
    expect(runner).toContain("await runLogInputSmoke(browser, browserName)");
    expect(runner).toContain("state.wait?.stop_message_skip === true");
    expect(runner).toContain('String(line).includes("暗之公会")');
  });

  it("keeps the compiled-cache input smoke independent of game-specific opening text", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");
    const cacheSmoke = runner.slice(
      runner.indexOf("async function runCacheInputSmoke"),
      runner.indexOf("async function runLogInputSmoke"),
    );

    expect(cacheSmoke).toContain("game input was blocked by compiled cache generation");
    expect(cacheSmoke).not.toContain("亚兰德");
    expect(cacheSmoke).not.toContain("亚斯特丽德的工房");
  });

  it("provides a native-browser font hot-apply flow", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('process.argv.includes("--settings-hot-apply")');
    expect(runner).toContain('gameFont.setValue("monospace")');
    expect(runner).toContain('settingsDialog.$("#setting-FontSize").setValue("19")');
    expect(runner).toContain('style.fontFamily === "monospace"');
    expect(runner).toContain('style.fontSize === "19px"');
  });

  it("uses the requested mouse button for visible UI click actions", () => {
    const runner = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const fullProjectExport = readFileSync(
      resolve("tools/runtime-tester/scenarios/full-project-export.json"),
      "utf8",
    );

    expect(runner).toContain('locator.click({ button: action.button ?? "left" })');
    expect(runner).toContain("action.settle_ms");
    expect(fullProjectExport).toContain('"observe": false');
  });

  it("can assert computed game-font styles after applying settings", () => {
    const runner = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/settings-hot-apply.json"),
      "utf8",
    );

    expect(runner).toContain('fields.includes("computed_style")');
    expect(runner).toContain("font_family: style.fontFamily");
    expect(scenario).toContain('"value": "monospace"');
    expect(scenario).toContain('"font_family": "monospace"');
    expect(scenario).toContain('"font_size": "19px"');
  });

  it("measures real map and dialogue glyph coordinates for text-layout regressions", () => {
    const runner = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const mapScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/eratw-dynamic-map.json"),
      "utf8",
    );
    const dialogueScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erarorona-log-inputs.json"),
      "utf8",
    );

    expect(runner).toContain('fields.includes("square_grid")');
    expect(runner).toContain('const SHRINE_INTERIOR_EDGE = "║"');
    expect(runner).toContain('fields.includes("dialog_border")');
    expect(runner).toContain('action.type === "click_until_text"');
    expect(mapScenario).toContain('"square_grid"');
    expect(mapScenario).toContain('"interior_rows": 5');
    expect(mapScenario).toContain('"interior_counts": [1, 1, 1, 1, 1]');
    expect(dialogueScenario).toContain('"dialog_border"');
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
