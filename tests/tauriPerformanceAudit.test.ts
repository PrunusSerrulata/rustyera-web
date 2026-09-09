import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  capturePerformanceWindowSafety,
  ensurePerformanceProjectCopy,
  instrumentedPerformanceWindowMode,
  minimizePerformanceWindow,
  performanceAuditOptions,
  performanceCaptureChildArguments,
  performanceCommandTimeoutMs,
  performanceTelemetryCompleteness,
  performanceSnapshotMode,
  performanceWindowArguments,
  performanceWindowMode,
  readPerformanceWindowState,
  refreshPerformanceSession,
  validateExistingPerformanceProjectCopy,
  waitForPerformanceWindowSafety,
} from "../scripts/tauri-performance-audit.mjs";
import {
  MAXIMUM_PERFORMANCE_TRACE_BYTES,
  readPerformanceTrace,
  summarizeSamples,
} from "../scripts/tauri-performance-trace.mjs";
import { PerformanceAuditRingBuffer } from "../src/testing/performanceAudit";

describe("Tauri performance audit runner policy", () => {
  it("mutes WebDriver payload logging despite standalone remote's default info level", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const configure = runner.indexOf('if (perfAudit.enabled) process.env.WDIO_LOG_LEVEL = "error"');
    expect(configure).toBeGreaterThan(0);
    expect(configure).toBeLessThan(runner.indexOf('await import("@wdio/tauri-service")'));
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import logger from '@wdio/logger';
      const log = logger('webdriver');
      logger.setLogLevelsConfig(undefined, 'info');
      log.info('UNBOUNDED_CHECKPOINT_PAYLOAD');
      console.log(JSON.stringify({level: log.getLevel()}));
    `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, WDIO_LOG_LEVEL: "error" },
        encoding: "utf8",
      },
    );
    expect(output).not.toContain("UNBOUNDED_CHECKPOINT_PAYLOAD");
    expect(JSON.parse(output)).toEqual({ level: 4 });
  });
  it.each([0, 1])("reports authoritative timing/long-task loss (%s)", (dropped) => {
    for (const field of ["timingSamplesDropped", "longTasksDropped"] as const) {
      const frontend = { timingSamplesDropped: 0, longTasksDropped: 0, [field]: dropped };
      expect(performanceTelemetryCompleteness({ frontend, native: { dropped: 0 } })).toMatchObject({
        complete: dropped === 0,
        [field]: dropped,
      });
    }
  });
  const valid = [
    "--perf-audit",
    "--release",
    "--project",
    "/isolated/snake-tw",
    "--spec",
    "tests/tauri/snake-runtime-performance.spec.mjs",
    "--background-dom",
    "--window-mode",
    "minimized",
  ];

  it("requires the minimized background window policy for the release single-spec profile", () => {
    expect(performanceAuditOptions(valid, "snake-runtime-performance.spec.mjs")).toEqual({
      enabled: true,
      background: true,
      windowMode: "minimized",
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

  it("preserves the ordinary visible window as the default", () => {
    expect(
      performanceAuditOptions(valid.slice(0, -3), "snake-runtime-performance.spec.mjs"),
    ).toEqual({ enabled: true, background: false, windowMode: "visible" });
    expect(performanceWindowArguments("visible")).toEqual(["--window-mode", "visible"]);
  });

  it.each(["capture", "replay"])(
    "keeps %s requests/checkpoints at 30 seconds with a lightweight watchdog",
    (mode) => {
      vi.stubEnv("RUSTYERA_TAURI_PERF_CAPTURE", mode === "capture" ? "1" : "0");
      try {
        const policy = performanceAuditOptions(valid, "snake-runtime-performance.spec.mjs");
        expect(performanceCommandTimeoutMs(policy.enabled)).toBe(30_000);
        expect(performanceSnapshotMode(policy.enabled)).toBe("performance-progress");
        expect(performanceSnapshotMode(policy.enabled, true)).toBe("performance-diagnostic");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not relax ordinary E2E even when performance capture variables are present", () => {
    vi.stubEnv("RUSTYERA_TAURI_PERF_CAPTURE", "1");
    try {
      expect(performanceCommandTimeoutMs(false)).toBe(5_000);
      expect(performanceSnapshotMode(false)).toBe("complete");
      expect(performanceSnapshotMode(false, true)).toBe("complete");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives profile-enabled instrumentation a valid native window mode", () => {
    const ordinary = { enabled: false, background: false, windowMode: undefined };
    expect(instrumentedPerformanceWindowMode(ordinary, false)).toBeUndefined();
    expect(instrumentedPerformanceWindowMode(ordinary, true)).toBe("visible");
    expect(
      instrumentedPerformanceWindowMode(
        { enabled: true, background: true, windowMode: "minimized" },
        true,
      ),
    ).toBe("minimized");
  });

  it("rejects performance audit invocations that omit minimized background safeguards", () => {
    expect(performanceAuditOptions(valid, "snake-runtime-performance.spec.mjs")).toEqual({
      enabled: true,
      background: true,
      windowMode: "minimized",
    });
    expect(() =>
      performanceAuditOptions(
        valid.filter((argument) => argument !== "--background-dom"),
        "snake-runtime-performance.spec.mjs",
      ),
    ).toThrow("requires --background-dom");
    expect(() =>
      performanceAuditOptions(
        valid.map((argument) => (argument === "minimized" ? "visible" : argument)),
        "snake-runtime-performance.spec.mjs",
      ),
    ).toThrow("--background-dom requires minimized");
  });

  it("parses one shared window policy for capture and replay child processes", () => {
    expect(performanceWindowMode([])).toBe("visible");
    expect(performanceWindowArguments("minimized")).toEqual([
      "--background-dom",
      "--window-mode",
      "minimized",
    ]);
    expect(performanceWindowMode(["--window-mode", "visible"])).toBe("visible");
    expect(() => performanceWindowMode(["--window-mode", "hidden"])).toThrow(
      "must be visible or minimized",
    );
    expect(() =>
      performanceWindowMode(["--window-mode", "minimized", "--window-mode", "minimized"]),
    ).toThrow("only once");
  });

  it("minimizes the window and waits for the complete safe state", async () => {
    const minimizedBrowser = {
      minimizeWindow: vi.fn(async () => undefined),
    };
    await minimizePerformanceWindow(minimizedBrowser);
    expect(minimizedBrowser.minimizeWindow).toHaveBeenCalledOnce();

    const safeState = { minimized: true, focused: false, documentFocused: false };
    const inspectWindow = vi
      .fn<() => Promise<typeof safeState>>()
      .mockRejectedValueOnce(new Error("Tauri process still owns the foreground"))
      .mockResolvedValueOnce(safeState);
    const waitUntil = vi.fn(
      async (
        condition: () => Promise<unknown>,
        options: { timeout: number; interval: number; timeoutMsg: string },
      ) => {
        expect(await condition()).toBe(false);
        expect(await condition()).toBe(true);
        expect(options).toEqual({
          timeout: 5_000,
          interval: 50,
          timeoutMsg:
            "Tauri performance window did not reach a safe minimized state within 5 seconds",
        });
      },
    );
    await expect(waitForPerformanceWindowSafety({ waitUntil }, inspectWindow)).resolves.toBe(
      safeState,
    );
    expect(inspectWindow).toHaveBeenCalledTimes(2);
  });

  it("executes the minimized WebView state probe without display-placement logic", async () => {
    const current = {
      isVisible: vi.fn(async () => false),
      isMinimized: vi.fn(async () => true),
      isFocused: vi.fn(async () => false),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 1_000, height: 720 })),
    };
    const execute = vi.fn(
      async (script: (...arguments_: unknown[]) => unknown, ...arguments_: unknown[]) =>
        script(...arguments_),
    );
    vi.stubGlobal("window", {
      __TAURI__: {
        window: {
          getCurrentWindow: () => current,
        },
      },
    });
    vi.stubGlobal("document", { hasFocus: () => false, visibilityState: "hidden" });
    try {
      const state = await readPerformanceWindowState({ execute });
      expect(state).toMatchObject({
        visible: false,
        minimized: true,
        focused: false,
        documentFocused: false,
        visibilityState: "hidden",
      });
      expect(state).not.toHaveProperty("monitors");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records window metadata without rejecting foreground ownership", async () => {
    const browser = {
      execute: vi.fn(async () => ({
        mode: "minimized",
        visible: false,
        minimized: true,
        focused: false,
        position: { x: 0, y: 0 },
        size: { width: 1_000, height: 720 },
        documentFocused: false,
        visibilityState: "hidden",
      })),
    };
    const state = await capturePerformanceWindowSafety(browser, { pid: 700 }, 100, {
      observeForegroundApplication: async () => ({ pid: 700 }),
      capturePerformanceProcessTree: async () => [{ pid: 100 }],
    });
    expect(state).toMatchObject({
      minimized: true,
      visible: false,
      focused: false,
      documentFocused: false,
      ownsForeground: false,
    });
    await expect(
      capturePerformanceWindowSafety(browser, { pid: 100 }, 100, {
        observeForegroundApplication: async () => ({ pid: 100 }),
        capturePerformanceProcessTree: async () => [{ pid: 100 }],
      }),
    ).resolves.toMatchObject({ ownsForeground: true });
  });

  it("sets the performance socket timeout before the first session command", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const connected = runner.indexOf("startWdioSession(capabilities");
    const captureTimeout = runner.indexOf(
      "performanceCommandTimeoutMs(perfAudit.enabled)",
      connected,
    );
    const minimize = runner.indexOf("minimizePerformanceWindow(", captureTimeout);
    const monitor = runner.indexOf("startTauriSessionMonitor(browser", minimize);
    const order = [connected, captureTimeout, minimize, monitor];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(runner).not.toContain("waitForPerformanceWindowSafety");
    expect(runner).not.toContain("capturePerformanceWindowSafety");
    expect(runner).toMatch(/snapshotMode: performanceSnapshotMode\(\s*perfAudit\.enabled,/);
  });

  it("allows one build-only flag for the official performance artifact build", () => {
    expect(
      performanceAuditOptions([...valid, "--build-only"], "snake-runtime-performance.spec.mjs")
        .enabled,
    ).toBe(true);
    expect(() =>
      performanceAuditOptions(
        [...valid, "--build-only", "--build-only"],
        "snake-runtime-performance.spec.mjs",
      ),
    ).toThrow("exactly");
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
      performanceAuditOptions(
        [...valid.slice(0, -2), "--window-mode"],
        "snake-runtime-performance.spec.mjs",
      ),
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
      readPerformanceTrace(resolve("tests/fixtures/snake-runtime-performance-trace.v3.json")),
    ).rejects.toThrow("requires autonomous capture");
  });

  it("rejects an oversized trace before attempting to parse it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rustyera-oversized-trace-"));
    try {
      const trace = join(root, "oversized.json");
      const handle = await open(trace, "w");
      await handle.truncate(MAXIMUM_PERFORMANCE_TRACE_BYTES + 1);
      await handle.close();
      await expect(readPerformanceTrace(trace)).rejects.toThrow("256 MiB file limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows one prepared build and requires the identical artifact thereafter", () => {
    const runner = readFileSync(resolve("scripts/tauri-performance-runner.mjs"), "utf8");
    expect(runner).toContain('buildPrepared ? "--require-reuse-build" : "--reuse-build"');
    expect(runner).toContain("buildPrepared = true");
    expect(runner).toContain("for (let index = 0; index < 5; index += 1)");
    expect(runner).toContain("RUSTYERA_TEST_WALL_CLOCK_DEADLINE_MS");
  });

  it("creates one marked performance project copy and only reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rustyera-one-performance-copy-"));
    try {
      const source = join(root, "source");
      const copy = join(root, "evidence", "project-copy");
      await mkdir(join(source, "ERB"), { recursive: true });
      await writeFile(join(source, "reraconfig.toml"), 'profile = "emuera.skia.snake"\n');
      await writeFile(join(source, "ERB", "test.erb"), "@TEST\nRETURN 0\n");
      await mkdir(join(root, "evidence"), { recursive: true });
      await mkdir(`${copy}.copy-lock`);
      await expect(ensurePerformanceProjectCopy(source, copy)).rejects.toThrow("already locked");
      await rm(`${copy}.copy-lock`, { recursive: true });
      const created = await ensurePerformanceProjectCopy(source, copy);
      expect(created.created).toBe(true);
      const marker = await readFile(
        join(copy, ".rustyera", "performance-project-copy-v1.json"),
        "utf8",
      );
      const reused = await ensurePerformanceProjectCopy(source, copy);
      expect(reused).toMatchObject({
        copy: created.copy,
        created: false,
        projectDigest: created.projectDigest,
      });
      expect(
        await readFile(join(copy, ".rustyera", "performance-project-copy-v1.json"), "utf8"),
      ).toBe(marker);
      await writeFile(join(copy, "ERB", "test.erb"), "@TEST\nRETURN 1\n");
      await expect(
        validateExistingPerformanceProjectCopy(source, copy, created.projectDigest),
      ).rejects.toThrow("inputs changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a verified cached Tauri build before capture without implicit rebuilding", () => {
    expect(performanceCaptureChildArguments("/isolated/snake-tw", "minimized")).toEqual([
      "scripts/tauri-test.mjs",
      "--perf-audit",
      "--release",
      "--require-reuse-build",
      "--project",
      "/isolated/snake-tw",
      "--spec",
      "tests/tauri/snake-runtime-performance.spec.mjs",
      "--background-dom",
      "--window-mode",
      "minimized",
    ]);
  });

  it("restores the validated project copy after refreshing a reusable performance build", async () => {
    const order: string[] = [];
    const control = {
      performanceProgress: () => ({}),
      snapshotSummary: () => ({}),
      configureServiceLifecycle: ({ projectPaths }: { projectPaths: string[] }) =>
        order.push(`configure:${projectPaths[0]}`),
    };
    const page: { performance: { timeOrigin: number }; __RUSTYERA_TEST__?: typeof control } = {
      performance: { timeOrigin: 1 },
      __RUSTYERA_TEST__: control,
    };
    vi.stubGlobal("window", page);
    const browser = {
      refresh: vi.fn(async () => order.push("refresh")),
      execute: vi.fn(async (script: (...args: any[]) => any, ...args: any[]) => script(...args)),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options: { timeout: number }) => {
        expect(options.timeout).toBe(30_000);
        expect(await condition()).toBe(false); // Old document still has its ready control.
        page.performance.timeOrigin = 2;
        page.__RUSTYERA_TEST__ = undefined;
        expect(await condition()).toBe(false); // New document has not installed control yet.
        page.__RUSTYERA_TEST__ = control;
        expect(await condition()).toBe(true);
      }),
    };
    try {
      await refreshPerformanceSession(browser, "/isolated/project-copy", async () => {
        order.push("control");
      });
      expect(order).toEqual(["refresh", "control", "configure:/isolated/project-copy"]);
      await expect(
        refreshPerformanceSession(
          browser,
          "/__rustyera_test_picker_must_be_configured__",
          async () => undefined,
        ),
      ).rejects.toThrow("validated absolute project copy");
      expect(browser.refresh).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("binds foreground checks to the exact performance process tree", () => {
    const audit = readFileSync(resolve("scripts/tauri-performance-audit.mjs"), "utf8");
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
