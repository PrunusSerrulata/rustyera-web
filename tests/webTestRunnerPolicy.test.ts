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

  it("covers cold and incremental compiled-cache handoff in both directions", () => {
    const runner = readFileSync(resolve("scripts/cache-handoff-test.mjs"), "utf8");

    expect(runner).toContain('"tui_cold_to_web"');
    expect(runner).toContain('"web_cold_to_tui"');
    expect(runner).toContain('"tui_incremental_to_web"');
    expect(runner).toContain('"web_incremental_to_tui"');
    expect(runner).toContain('assertSameFile(tuiColdCache, webColdCache, "cold")');
    expect(runner).toContain(
      'assertSameFile(tuiIncrementalCache, webIncrementalCache, "incremental")',
    );
  });

  it("provides a native-browser font hot-apply flow", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('process.argv.includes("--settings-hot-apply")');
    expect(runner).toContain('gameFont.setValue("monospace")');
    expect(runner).toContain('settingsDialog.$("#setting-FontSize").setValue("19")');
    expect(runner).toContain('style.fontFamily === "monospace"');
    expect(runner).toContain('style.fontSize === "19px"');
    expect(runner).toContain('state.status === "游戏运行中"');
    expect(runner).toContain('snapshot().status === "项目设置已应用"');
    expect(runner).toContain("cacheUpdate =");
    expect(runner).toContain("cache.prefixDigest !== cacheBeforeSettings.prefixDigest");
  });

  it("covers cache-hit and settings status restoration in a visible browser flow", () => {
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/status-lifecycle.json"),
      "utf8",
    );

    expect(scenario).toContain('"scenario": "warm"');
    expect(scenario).toContain('"cacheHit": true');
    expect(scenario).toContain('"export": null');
    expect(scenario).toContain('"status": "项目设置已应用"');
    expect(scenario).toContain('"status": "游戏运行中"');
  });

  it("covers erarorona cache-hit settings without rebuilding a sparse cache", () => {
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erarorona-cache-status.json"),
      "utf8",
    );

    expect(scenario).toContain('"compiled_cache": true');
    expect(scenario).toContain('"scenario": "warm"');
    expect(scenario).toContain('"projectLoading": false');
    expect(scenario).toContain('"status": "游戏运行中"');
    expect(scenario).toContain('"css": ".project-load-progress"');
    expect(scenario).toContain('"css": "#setting-FontSize"');
    expect(scenario).toContain('"css": "#settings-tab-display"');
    expect(scenario).toContain('"logNotifications": []');
    expect(scenario).toContain('"css": ".log-notification"');
    expect(scenario).toContain('"count": 0');
  });

  it("uses a deterministic source fixture for fatal diagnosis exports", () => {
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/fault-diagnosis.json"),
      "utf8",
    );
    const fixture = readFileSync(
      resolve("tests/fixtures/fault-diagnosis-project/erb/fault.erb"),
      "utf8",
    );

    expect(scenario).toContain('"project": "../../../tests/fixtures/fault-diagnosis-project"');
    expect(scenario).not.toContain('"type": "vm_snapshot"');
    expect(scenario).toContain('"logNotifications": []');
    expect(scenario).toContain('"css": ".log-notification"');
    expect(fixture).toContain("THROW INTENTIONAL_FATAL_DIAGNOSIS_FIXTURE");
  });

  it("keeps the runtime-accepted project generation after a failed browser reload", () => {
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/failed-reload-diagnosis.json"),
      "utf8",
    );

    expect(scenario).toContain('"expect_success": false');
    expect(scenario).toContain('"projectRevision": "1"');
    expect(scenario).toContain('"type": "assert_diagnosis_project_manifest"');
    expect(scenario).toContain("UNSELECTED_ACTIVE");
    expect(scenario).not.toContain("UNSELECTED_DISK_ONLY");
  });

  it("checks cross-host cache acceptance from the serialized frontend telemetry", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");

    expect(runner).toContain("current.rust.frontend.startupTelemetry?.cacheHit !== true");
    expect(runner).not.toContain("current.rust.startupTelemetry?.cacheHit !== true");
  });

  it("runs the cache-hit settings regression through the native Tauri host", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const spec = readFileSync(resolve("tests/tauri/cache-settings.spec.mjs"), "utf8");

    expect(runner).toContain('"cache-settings.spec.mjs"');
    expect(runner).toContain('environmentFlag: "VITE_RUSTYERA_TAURI_CACHE_SETTINGS"');
    expect(spec).toContain("startupTelemetry?.cacheHit === true");
    expect(spec).toContain('entry.message).includes("runtime.compiled_cache_failed")');
    expect(spec).toContain('state.status, "游戏运行中"');
  });

  it("runs the eraFL COLOR_LINE regression through the visible native Tauri host", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const support = readFileSync(resolve("scripts/tauri-test-support.mjs"), "utf8");
    const spec = readFileSync(resolve("tests/tauri/erafl-save-load-shapes.spec.mjs"), "utf8");

    expect(runner).toContain('"erafl-save-load-shapes.spec.mjs"');
    expect(runner).toContain('environmentFlag: "VITE_RUSTYERA_TAURI_ERAFL_SAVE_LOAD_SHAPES"');
    expect(runner).toContain("startTauriSessionMonitor(browser");
    expect(support).toContain("const SNAPSHOT_INTERVAL_MS = 5_000");
    expect(spec).toContain('assert.equal((await snapshot()).bridgeKind, "tauri")');
    expect(spec).toContain('await input.setValue("1")');
    expect(spec).toContain("assert.deepEqual(row.slotWidths, [992, 16, 16])");
    expect(spec).toMatch(/assert\.ok\(\s*row\.borderWidths\.every\(\(width\) => width === "0px"\)/);
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
    const characterScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erarorona-character-layout.json"),
      "utf8",
    );
    const titleScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erafl-title-layout.json"),
      "utf8",
    );

    expect(runner).toContain('fields.includes("square_grid")');
    expect(runner).toContain('const SHRINE_INTERIOR_EDGE = "║"');
    expect(runner).toContain('fields.includes("dialog_border")');
    expect(runner).toContain('fields.includes("footer_corner")');
    expect(runner).toContain('action.type === "click_until_text"');
    expect(mapScenario).toContain('"square_grid"');
    expect(mapScenario).toContain('"interior_rows": 5');
    expect(mapScenario).toContain('"interior_counts": [1, 1, 1, 1, 1]');
    expect(dialogueScenario).toContain('"dialog_border"');
    expect(characterScenario).toContain('button:has-text(\\"[*] 友人\\")');
    expect(characterScenario).toContain('button:has-text(\\"[能]\\")');
    expect(characterScenario).toContain('"text": "特质"');
    expect(characterScenario).toContain('"count": 128');
    expect(characterScenario).toContain('"font_family": "\\"等距时代黑体 SC\\""');
    expect(characterScenario).toContain('"value": "Explex"');
    expect(characterScenario).toContain('"font_family": "Explex"');
    expect(runner).toContain("expected.horizontal_centered_within");
    expect(titleScenario).toContain('"image_loaded": true');
    expect(titleScenario).toContain('"horizontal_centered_within": 16');
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
