import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCompleteSnapshotMonitor } from "../scripts/tauri-test-support.mjs";
import {
  installRemoteFileSystem,
  isolatedProject,
  projectRuntimeStorageRoot,
  publishCrossHostArtifacts,
} from "../scripts/web-test-lib.mjs";
import { finalizeBrowserGameRun } from "../scripts/web-test-lifecycle.mjs";

afterEach(() => vi.useRealTimers());

describe("browser game runner progress policy", () => {
  it("hands Snake-profile caches through their profile-scoped runtime storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-snake-cache-handoff-test-"));
    const source = path.join(root, "source");
    const input = path.join(root, "input.reracache");
    const output = path.join(root, "output.reracache");
    let isolated: Awaited<ReturnType<typeof isolatedProject>> | undefined;
    try {
      await mkdir(source, { recursive: true });
      await Promise.all([
        writeFile(input, new Uint8Array([9, 8, 7, 6])),
        writeFile(
          path.join(source, "reraconfig.toml"),
          '[compatibility]\nprofile = "emuera.skia.snake"\n',
        ),
      ]);
      isolated = await isolatedProject(source, { compiledCacheInput: input });
      const runtimeRoot = await projectRuntimeStorageRoot(isolated.project);
      const cache = path.join(runtimeRoot, ".rustyera", "cache", "compiled-project.reracache");
      expect([...new Uint8Array(await readFile(cache))]).toEqual([9, 8, 7, 6]);

      await publishCrossHostArtifacts({
        source,
        isolated: isolated.project,
        cacheInput: input,
        cacheOutput: output,
        succeeded: true,
        cacheSaved: true,
      });
      expect([...new Uint8Array(await readFile(output))]).toEqual([9, 8, 7, 6]);
    } finally {
      await isolated?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams every remote filesystem write chunk into one atomically committed file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-remote-fs-test-"));
    const installedBindings: string[] = [];
    const page = {
      async exposeBinding(name: string, callback: (source: unknown, request: unknown) => unknown) {
        installedBindings.push(name);
        Reflect.set(window, name, (request: unknown) => callback({}, request));
      },
      async addInitScript(script: () => void) {
        script();
      },
    };
    try {
      await installRemoteFileSystem(page, root);
      const directory = await window.showDirectoryPicker?.({ mode: "readwrite" });
      const file = await directory?.getFileHandle("cache.reracache", { create: true });
      const writer = await file?.createWritable({ keepExistingData: false });
      await writer?.write(new Uint8Array([1, 2, 3]));
      await writer?.write(new Uint8Array([4, 5]));
      await writer?.close();

      expect([...new Uint8Array(await readFile(path.join(root, "cache.reracache")))]).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(await readFile(path.join(root, "cache.reracache"))).toHaveLength(5);
    } finally {
      for (const name of installedBindings) Reflect.deleteProperty(window, name);
      Reflect.deleteProperty(window, "showDirectoryPicker");
      Reflect.deleteProperty(window, "__RUSTYERA_TEST_FS_REPLACE__");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows the first scenario action to assert an expected startup fault", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");
    const scenario = JSON.parse(
      readFileSync(resolve("tools/runtime-tester/scenarios/snake-sql-invalid-seed.json"), "utf8"),
    );

    expect(runner).toContain("scenario.actions[0]?.allow_fault !== true");
    expect(scenario.actions[0]).toMatchObject({
      type: "assert_state",
      allow_fault: true,
      expect: {
        fault: {
          code: "vm_fault",
          context: { api: "sql_connect", stage: "runtime" },
        },
      },
      expect_prefix: {
        fault: { message: "rustyera.sql/open/invalid_source:" },
      },
    });
  });

  it("uses the shared five-second complete snapshot monitor", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");
    const library = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const snapshots = readFileSync(resolve("scripts/tauri-test-support.mjs"), "utf8");

    expect(runner).toContain(
      'import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs"',
    );
    expect(runner).toContain('eventType: "browser-game-snapshot"');
    expect(runner).toContain("snapshotMonitor.failure");
    expect(library).toContain("snapshotSummary()");
    expect(snapshots).toContain("snapshotSummary?.()");
    expect(runner).not.toContain("OBSERVATION_REPORT_MS");
    expect(runner).not.toContain("OBSERVATION_STALL_MS");
    expect(runner).toContain("action.settle_auto_enter ?? action.auto_enter !== false");
    expect(runner).toContain("action.observe !== false");
  });

  it("lets timed Enter waits expire before submitting an automatic Enter", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");
    const observationLoop = runner.slice(
      runner.indexOf("async function observe"),
      runner.indexOf("async function act"),
    );
    const timedWaitBranch = observationLoop.slice(
      observationLoop.indexOf("if (rust.wait.deadline_ns != null)"),
      observationLoop.indexOf('source: "automatic_enter"'),
    );
    const stableEnterBranch = observationLoop.slice(
      observationLoop.indexOf('source: "automatic_enter"'),
    );

    expect(runner).toContain("waitForAutomaticWaitChange");
    expect(timedWaitBranch).toContain("await waitForAutomaticWaitChange(page, rust.wait.wait_id)");
    expect(timedWaitBranch).toContain("continue;");
    expect(timedWaitBranch).not.toContain("runAction");
    expect(stableEnterBranch).toContain('source: "automatic_enter"');
    expect(stableEnterBranch).toContain(
      'await runAction(page, { type: "input", value: "", keyboard_submit: true })',
    );
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

  it("uses non-blocking Firefox navigation and bounds complete snapshots", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");
    const library = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const snapshots = readFileSync(resolve("scripts/tauri-test-support.mjs"), "utf8");

    expect(library).not.toContain("webSocketUrl: true");
    expect(library).toContain('pageLoadStrategy: "none"');
    expect(library).toContain('geckoDriverVersion: "0.37.1"');
    expect(library).toContain('cacheDir: path.resolve(".rustyera", "webdriver")');
    expect(library).toContain('"wdio:enforceWebDriverClassic": true');
    expect(runner).toContain("connectionRetryTimeout: 20_000");
    expect(runner).not.toContain("browser.isBidi !== true");
    const navigation = runner.indexOf("await browser.url(targetUrl)");
    const readiness = runner.indexOf("await waitForWebDriverDocument(browser, targetUrl");
    const monitor = runner.indexOf("snapshotMonitor = startCompleteSnapshotMonitor");
    const firstAsyncScript = runner.indexOf("await browser.executeAsync");
    expect(navigation).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(navigation);
    expect(monitor).toBeGreaterThan(readiness);
    expect(firstAsyncScript).toBeGreaterThan(monitor);
    expect(snapshots).toContain("complete snapshot capture exceeded");
    expect(snapshots).toContain("Promise.race");
    expect(snapshots).toContain('runtime?.transfer?.export?.name === "compiled-project.reracache"');
    expect(library).toContain('includes("runtime.compiled_cache_failed")');
    expect(library).toContain("compiled cache export failed:");
    expect(library).toContain("{ timeout: 0 },");
  });

  it("treats an output-marker compatibility probe as startup-only", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain("Boolean(expectedOutput) ||");
    expect(runner.indexOf("Boolean(expectedOutput) ||")).toBeLessThan(
      runner.indexOf('compatibilityStage = "checking automatic interaction assistance"'),
    );
  });

  it("checks global preferences through the real UI before native-browser project load", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('compatibilityStage = "restoring Safari automation window"');
    expect(runner).toContain(".maximizeWindow()");
    expect(runner.indexOf('compatibilityStage = "waiting for frontend test control"')).toBeLessThan(
      runner.indexOf("verifyGlobalPreferencesBeforeProject(browser)"),
    );
    expect(runner).toContain('typeof window.__RUSTYERA_TEST__?.snapshot === "function"');
    expect(runner).toContain("verifyGlobalPreferencesBeforeProject(browser)");
    expect(runner).toContain('activeBrowser.$("#welcome-preferences")');
    expect(runner).toContain('if (browserName === "safari")');
    expect(runner).toContain("activeBrowser.execute((target) => target.click(), element)");
    expect(runner).toContain('document.querySelector("#welcome-preferences")?.click()');
    expect(runner).toContain("project preferences were enabled without a project");
    expect(runner).toContain('imageScale.setValue("1.25")');
    expect(runner).toContain('snapshot().status === "全局偏好已应用"');
    expect(runner).toContain('setValue("1")');
  });

  it("bounds native file-menu retries below the snapshot stall interval", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain("async function clickFileMenuAction(activeBrowser, label)");
    expect(runner).toContain("attempt <= 2");
    expect(runner).toContain('if (browserName !== "safari")');
    expect(runner).toContain("await menuButton.moveTo()");
    expect(runner).toContain("await activeBrowser.pause(200)");
    expect(runner).toContain("await clickElement(activeBrowser, menuButton)");
    expect(runner).toContain("timeout: 1_000");
    expect(runner).toContain("await clickElement(activeBrowser, action)");
    expect(runner).toContain("await clickFileMenuAction(browser, action.menuLabel)");
    expect(runner).toContain('await clickFileMenuAction(browser, "项目设置…")');
    expect(runner).toContain('await clickFileMenuAction(activeBrowser, "偏好设置…")');
  });

  it("materializes portable browser files without joining large base64 payloads", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain("chunks.push(Uint8Array.from(raw");
    expect(runner).toContain("new File(chunks");
    expect(runner).not.toContain('atob(chunks.join(""))');
  });

  it("drives native Firefox and Safari through a real packaged-project picker", () => {
    const runner = readFileSync(resolve("scripts/browser-compat-test.mjs"), "utf8");

    expect(runner).toContain('process.argv.indexOf("--project-file")');
    expect(runner).toContain('element.accept.includes(".reraproj")');
    expect(runner).toContain('input[type="file"][accept*=".reraproj"]');
    expect(runner).toContain("packagedProjectProgressErrors(projectProgress, !startupOnly)");
    expect(runner).toContain("if (projectFile && !startupOnly)");
    expect(runner).toContain("await input.addValue(projectFile)");
    expect(runner).toContain("safariProjectFilePlugin(projectFile)");
    expect(runner).toContain('browserName === "safari" ? "/__rustyera_compat_project_file"');
    expect(runner).toContain("picker?.injected === true");
    expect(runner).toContain("assertPackagedStartup(observed.startupTelemetry)");
    expect(runner).toContain("source preparation slow path");
    expect(runner).toContain("projectPreferencesDuringLoad");
    expect(runner).toContain("project preferences during loading");
    expect(runner).toContain("verifyProjectPreferencesAfterLoad(browser)");
    expect(runner).toContain("project preferences after loading");
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
    expect(runner).toContain("RUSTYERA_TEST_SOURCE_INDEX_INPUT");
    expect(runner).toContain("RUSTYERA_TEST_SOURCE_INDEX_OUTPUT");
    expect(runner).toContain('assertPortableSourceIndex(tuiIncrementalIndex, "TUI incremental")');
    expect(runner).toContain(
      'assertPortableSourceIndex(webIncrementalIndex, "Browser/WASM incremental")',
    );
    expect(runner).toContain('VITE_RUSTYERA_TEST_TRUST_METADATA: "1"');
    expect(readFileSync(resolve("scripts/web-test.mjs"), "utf8")).toContain(
      '"import.meta.env.VITE_RUSTYERA_TEST_TRUST_METADATA"',
    );
    const library = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    expect(library).toContain("stat.mtimeNs / 1_000_000n");
    expect(library).not.toContain("lastModified: stat.mtimeMs");
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

  it("loads a real packaged project through Chromium and checks responsive overlays", () => {
    const runner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");
    const runnerLibrary = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/packaged-project-responsive.json"),
      "utf8",
    );

    expect(runner).toContain('page.waitForEvent("filechooser")');
    expect(runner).toContain('name: "从项目文件启动…"');
    expect(runner).toContain('includes("runtime.compiled_cache_hit")');
    expect(runner).toContain("packaged project did not use its exact compiled cache");
    expect(runnerLibrary).toContain('fields.includes("scrollable_y")');
    expect(runner).toContain("requires an explicit --project-file artifact");
    expect(scenario).toContain('"requires_project_file": true');
    expect(scenario).not.toContain('"project_file"');
    expect(scenario).toContain('"viewport": { "width": 568, "height": 320 }');
    expect(scenario).toContain('"css": ".menu-popup"');
    expect(scenario).toContain('"css": "#preference-tab-project"');
    expect(scenario).toContain('"css": "#preference-project-UseMouse-override"');
    expect(scenario).toContain('"css": ".dialog-content"');
    expect(scenario).toContain('"scrollable_y": true');
    expect(scenario).toContain('"at_scroll_bottom": true');
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
    const progress = readFileSync(resolve("tests/tauri/runtime-progress.mjs"), "utf8");
    const spec = readFileSync(resolve("tests/tauri/cache-settings.spec.mjs"), "utf8");

    expect(runner).toContain('"cache-settings.spec.mjs"');
    expect(runner).toContain('environmentFlag: "VITE_RUSTYERA_TAURI_CACHE_SETTINGS"');
    expect(runner).toContain("prewarmWithTui: true");
    expect(runner).toContain("RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: cacheOutput");
    expect(runner).toContain("RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: sourceIndexOutput");
    expect(runner).toContain("RUSTYERA_TEST_PROJECT_OUTPUT: projectOutput");
    expect(runner).toContain("__RUSTYERA_TAURI_MONITOR_OBSERVATION__");
    expect(progress).toContain("monitoredRuntimeSnapshot(pollInterval)");
    expect(progress).toContain("pause: monitoredSnapshot ? delay : undefined");
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

    expect(runner).toContain(
      'locator.click({ button: action.button ?? "left", force: action.force === true })',
    );
    expect(runner).toContain("action.settle_ms");
    expect(fullProjectExport).toContain('"observe": false');
  });

  it("runs touch secondary actions through a real Chromium gesture scenario", () => {
    const runner = readFileSync(resolve("scripts/web-test-lib.mjs"), "utf8");
    const scenarioRunner = readFileSync(resolve("scripts/web-test.mjs"), "utf8");
    const scenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/touch-secondary-action.json"),
      "utf8",
    );
    const roronaScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erarorona-touch-skip.json"),
      "utf8",
    );

    expect(runner).toContain('action.type === "touch_gesture"');
    expect(runner).toContain('session.send("Input.dispatchTouchEvent"');
    expect(scenarioRunner).toContain("const OBSERVABLE_STEP_ACTION_TYPES = new Set([");
    expect(scenarioRunner).toContain('  "touch_gesture",');
    expect(scenarioRunner).toContain("isObservableStepAction(action.type)");
    expect(scenario).toContain('"gesture": "two_finger_tap"');
    expect(scenario).toContain('"gesture": "long_press"');
    expect(scenario).toContain('"stop_message_skip": true');
    expect(roronaScenario).toContain('"has_touch": true');
    expect(roronaScenario).toContain('"gesture": "two_finger_tap"');
    expect(roronaScenario).toContain('"gesture": "long_press"');
  });

  it("covers running-animation right click and the February save regression", () => {
    const opening = JSON.parse(
      readFileSync(
        resolve("tools/runtime-tester/scenarios/erarorona-opening-right-skip.json"),
        "utf8",
      ),
    );
    const february = JSON.parse(
      readFileSync(resolve("tools/runtime-tester/scenarios/erarorona-february-first.json"), "utf8"),
    ) as {
      start: { path: string };
      actions: Array<{
        type: string;
        value?: unknown;
        locator?: { css?: string };
        expect?: { count?: number; visible?: boolean };
      }>;
    };

    expect(opening.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "click", button: "right", advances_game: true }),
        expect.objectContaining({
          type: "assert_state",
          expect: { phase: "waiting_input", fault: null },
        }),
      ]),
    );
    expect(february.start.path).toContain("save05.sav");
    const cornerAssertions = february.actions.filter(
      (action) => action.type === "assert_dom" && action.locator?.css?.includes(':text-is("┌")'),
    );
    expect(cornerAssertions).toHaveLength(4);
    expect(cornerAssertions.map((action) => action.expect?.count)).toEqual([2, 1, 1, 2]);
    expect(cornerAssertions.every((action) => action.expect?.visible === true)).toBe(true);
    const cornerSelectors = cornerAssertions.map((action) => action.locator?.css ?? "").join("\n");
    expect(cornerSelectors).toContain("工房");
    expect(cornerSelectors).toContain("亚兰德");
    expect(cornerSelectors).toContain("系统");
    expect(cornerSelectors).toContain("[/] 奴隶");
    expect(february.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input", value: 11 }),
        expect.objectContaining({ type: "input", value: 1 }),
      ]),
    );
  });

  it("measures native Tauri petting skip through the next interactive command screen", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const spec = readFileSync(
      resolve("tests/tauri/rorona-settlement-performance.spec.mjs"),
      "utf8",
    );
    const flow = readFileSync(resolve("tests/tauri/rorona-flow.mjs"), "utf8");

    expect(runner).toContain('"rorona-settlement-performance.spec.mjs"');
    expect(runner).toContain("release: true");
    expect(runner).toContain("releaseRequested || specProfile?.release === true");
    expect(runner).toContain('createWriteStream(snapshotLogPath, { flags: "wx" })');
    expect(runner).toContain('type: "tauri-snapshot-log"');
    expect(runner).toContain("snapshotLog.write(`${message}\\n`)");
    const webdriverConfiguration = readFileSync(
      resolve("src-tauri/tauri.webdriver.conf.json"),
      "utf8",
    );
    expect(webdriverConfiguration).toContain('"core:window:allow-show"');
    expect(webdriverConfiguration).toContain('"core:window:allow-hide"');
    expect(webdriverConfiguration).toContain('"core:window:allow-set-focus"');
    expect(spec).toContain("reachManualSettlementBoundary()");
    expect(spec).toContain("reachTitle(20)");
    expect(spec).toContain("submit(1, true)");
    expect(spec).toContain("submit(7, true)");
    expect(spec).toContain('clickVisibleCharacterTrainButton("奥蕾莉亚")');
    expect(spec).toContain("/^\\[\\s*调\\s*\\]$/u");
    expect(spec).toContain("/\\[\\s*0\\s*\\][\\s\\S]*爱抚/");
    expect(spec).toContain('assert.equal(pettingBoundary.wait?.kind, "enter_key")');
    expect(spec).toContain("waitForVisibleGameButton(");
    expect(spec).toContain("const TARGET_ELAPSED_MS = 50");
    expect(spec).toContain('const TARGET_BUTTON_TEXT = ["爱抚"]');
    expect(spec).toContain('document.querySelectorAll(".game-viewport button")');
    expect(spec).toContain('const buttons = await $$(".game-viewport button")');
    expect(spec).toContain("isDisplayed({ withinViewport: true })");
    expect(spec).toContain('clickViewportBottom("right"');
    expect(spec).toContain("captureEvents: false");
    expect(spec).toContain("await appWindow.show()");
    expect(spec).toContain("await appWindow.setFocus()");
    expect(spec).toContain("await appWindow.isVisible()");
    expect(spec).toContain("await appWindow.isFocused()");
    expect(spec).not.toContain("maximize(");
    expect(spec).toContain("hidePerformanceWindow()");
    expect(spec).toContain("TARGET_ELAPSED_MS + 50");
    expect(spec).toContain("await readSettlementProbe()");
    expect(spec).toContain("event.button !== 2");
    expect(spec).toContain("measurement.mouseUpAt != null");
    expect(spec).toContain("measurement.mouseUpAt >= measurement.mouseDownAt");
    expect(spec).toContain("measurement.mouseUpAt - measurement.mouseDownAt >= 40");
    expect(spec).toContain('measurement.mouseDownVisibilityState, "visible"');
    expect(spec).toContain("measurement.mouseDownFocused, true");
    expect(spec).toContain('measurement.paintVisibilityState, "visible"');
    expect(spec).toContain("measurement.paintFocused, true");
    expect(spec).toContain("performanceWindowShowAttempted = true");
    expect(spec).toContain("performance.now()");
    expect(spec).toContain("paintReadyAt - measurement.mouseDownAt");
    expect(spec).toContain("elapsedMs <= TARGET_ELAPSED_MS");
    expect(spec).toContain("checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })");
    expect(spec).toContain('const buttons = [...viewport.querySelectorAll("button")]');
    expect(spec).toContain("const buttons = targetButtons()");
    expect(spec).toContain("if (buttons.some((button) => !actuallyVisible(button)))");
    expect(spec).toContain("finally");
    expect(spec).toContain("cleanupSettlementProbe()");
    expect(spec).toContain("observer.disconnect()");
    expect(spec).toContain("cancelAnimationFrame(sampleFrame)");
    expect(spec).toContain("cancelAnimationFrame(paintFrame)");
    expect(spec).toContain("delete window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__");
    expect(flow).toContain('id: "rustyera-viewport-pointer"');
    expect(flow).toContain('type: "pointerDown"');
    expect(flow).toContain('type: "pointerUp"');
    expect(flow).toContain("setTimeout(resolve, 50)");
    expect(flow).toContain("await browser.releaseActions()");
    expect(flow).toContain("if (pointerMayBePressed)");
    expect(flow).not.toContain(".pause(50)");
    expect(spec).toContain('assert.equal(final.bridgeKind, "tauri")');
    expect(spec).toContain("assert.equal(final.canInteract, true)");
    expect(spec).toContain("button instanceof HTMLButtonElement && !button.disabled");
  });

  it("checks erarorona training transitions for atomic painted presentations", () => {
    const scenario = JSON.parse(
      readFileSync(
        resolve("tools/runtime-tester/scenarios/erarorona-presentation-atomicity.json"),
        "utf8",
      ),
    );
    const atomicClicks = scenario.actions.filter(
      (action: any) => action.type === "click" && action.expect_atomic_presentation === true,
    );

    expect(atomicClicks.map((action: any) => action.locator.name)).toEqual([
      "[  0] 调教",
      "能力提升结束了",
    ]);
    expect(atomicClicks.at(-1)).toMatchObject({ dom_click: true });
    expect(scenario.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input", value: "切" }),
        expect.objectContaining({ type: "input", value: "99" }),
      ]),
    );
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
    const abilityScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erarorona-ability-box-layout.json"),
      "utf8",
    );
    const tauriRunner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const titleScenario = readFileSync(
      resolve("tools/runtime-tester/scenarios/erafl-title-layout.json"),
      "utf8",
    );

    expect(runner).toContain('fields.includes("square_grid")');
    expect(runner).toContain('const SHRINE_INTERIOR_EDGE = "║"');
    expect(runner).toContain('fields.includes("dialog_border")');
    expect(runner).toContain("const boundedTable =");
    expect(runner).toContain("lines.slice(tableStart, tableEnd + 1)");
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
    expect(abilityScenario).toContain('"width": 800');
    expect(abilityScenario).toContain('"compiled_cache": true');
    expect(abilityScenario).toContain('"width": 1440');
    expect(runner).toContain('action.type === "set_game_text_style"');
    expect(runner).toContain('action.type === "reveal_text"');
    expect(runner).toContain("--game-font");
    expect(runner).toContain("--game-size");
    expect(abilityScenario).toContain('"font_family": "等距时代黑体 SC"');
    expect(abilityScenario).toContain('"font_family": "monospace"');
    expect(abilityScenario).toContain('"font_size": 12');
    expect(abilityScenario).toContain('"font_size": 18');
    expect(abilityScenario).toContain('"font_size": 24');
    expect(abilityScenario).toContain('"dialog_border": { "aligned": true }');
    const tauriAbilitySpec = readFileSync(
      resolve("tests/tauri/rorona-ability-box-layout.spec.mjs"),
      "utf8",
    );
    expect(tauriAbilitySpec).toContain('["等距时代黑体 SC", "monospace"]');
    expect(tauriAbilitySpec).toContain("[12, 16, 18, 24]");
    expect(tauriAbilitySpec).toContain('const LABELS = ["烙印", "经验", "宝珠"');
    expect(tauriAbilitySpec).toContain("browser.setWindowSize(width, height)");
    expect(tauriAbilitySpec).toContain("const boundedTable =");
    expect(tauriRunner).toContain(
      'defaultState: "../games/erarorona/runtime_20260825-100940.snapshot"',
    );
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
      vi.fn(async () => {
        order.push("cleanup-1-start");
        await Promise.resolve();
        order.push("cleanup-1-end");
      }),
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
    expect(order.indexOf("cleanup-1-end")).toBeLessThan(order.indexOf("cleanup-2"));
    expect(order.at(-1)).toBe("close");
    expect(order.indexOf("result")).toBeLessThan(order.indexOf("close"));
  });
});
