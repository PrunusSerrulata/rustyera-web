import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextEncoder } from "node:util";
import { runInNewContext } from "node:vm";
import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it, vi } from "vitest";

import {
  assertAtomicPresentationTransition,
  browserProjectProgressErrors,
  compareObservations,
  goalStatus,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  isolatedProject,
  installRemoteFileSystem,
  loadScenario,
  nativeFirefoxCapabilities,
  focusNativeBrowser,
  publishCrossHostArtifacts,
  resolveLocator,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  runAction,
  terminalRuntimeRejection,
  waitForWebDriverDocument,
  waitForRuntimeObservation,
} from "../scripts/web-test-lib.mjs";
import { SNAKE_DATA_MARKERS } from "../scripts/snake-data-test-support.mjs";

describe("web game test scenario", () => {
  it("focuses Safari through its WebDriver automation window", async () => {
    const calls = [];
    const execute = vi.fn(async (...args) => calls.push(["activate", ...args]));
    const heading = {
      waitForDisplayed: async (options) => calls.push(["displayed", options.timeout]),
      click: async () => calls.push(["click"]),
    };
    const browser = {
      getWindowHandle: async () => {
        calls.push(["handle"]);
        return "automation";
      },
      switchToWindow: async (handle) => calls.push(["switch", handle]),
      $: async (selector) => {
        calls.push(["element", selector]);
        return heading;
      },
      execute: async (read) =>
        runInNewContext(`(${read})()`, {
          document: { visibilityState: "visible", hasFocus: () => true },
        }),
      waitUntil: async (read, options) => {
        calls.push(["observe", options.timeout, options.interval]);
        expect(await read()).toBe(true);
      },
    };
    await focusNativeBrowser(browser, "safari", { platform: "darwin", execute });
    expect(calls).toEqual([
      ["handle"],
      ["switch", "automation"],
      ["element", ".welcome h1"],
      ["displayed", 3_000],
      ["click"],
      ["observe", 3_000, 50],
    ]);
    expect(execute).not.toHaveBeenCalled();
    execute.mockClear();
    await focusNativeBrowser(browser, "firefox", { platform: "linux", execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["activation", "switch", "hidden", "unfocused", "unsupported"])(
    "rejects a failed %s foreground prerequisite without retrying input",
    async (failure) => {
      const execute = vi.fn(async () => {
        if (failure === "activation") throw new Error("activation");
      });
      const browser = {
        getWindowHandle: async () => "automation",
        switchToWindow: async () => {
          if (failure === "switch") throw new Error("switch");
        },
        $: async () => ({
          waitForDisplayed: async () => {},
          click: async () => {},
        }),
        execute: async (read) =>
          runInNewContext(`(${read})()`, {
            document: {
              visibilityState: failure === "hidden" ? "hidden" : "visible",
              hasFocus: () => failure !== "unfocused",
            },
          }),
        waitUntil: async (read, options) => {
          if (!(await read())) throw new Error(options.timeoutMsg);
        },
      };
      await expect(
        focusNativeBrowser(
          browser,
          failure === "unsupported" ? "unknown" : failure === "activation" ? "firefox" : "safari",
          {
            platform: "darwin",
            execute,
          },
        ),
      ).rejects.toThrow();
      expect(execute.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("rejects a missing remote directory before storage traversal starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-remote-directory-"));
    const remoteWindow = {};
    try {
      await writeFile(path.join(root, "file.txt"), "resource");
      await installRemoteFileSystem(
        {
          exposeBinding: async (name, callback) => {
            remoteWindow[name] = (request) => callback({}, request);
          },
          addInitScript: async (initialize) => {
            runInNewContext(`(${initialize.toString()})()`, {
              window: remoteWindow,
              DOMException: globalThis.DOMException,
            });
          },
        },
        root,
      );
      const directory = await remoteWindow.showDirectoryPicker();
      await expect(directory.getDirectoryHandle("data")).rejects.toMatchObject({
        name: "NotFoundError",
      });
      await expect(directory.getDirectoryHandle("file.txt")).rejects.toMatchObject({
        name: "TypeMismatchError",
      });
      const created = await directory.getDirectoryHandle("data", { create: true });
      expect(created.kind).toBe("directory");
      await expect(directory.getDirectoryHandle("data")).resolves.toMatchObject({
        kind: "directory",
        name: "data",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires all data integration stages after the visible startup input", async () => {
    const scenario = await loadScenario("tools/runtime-tester/scenarios/snake-data.json");
    expect(scenario.actions).toEqual([
      { type: "input", value: "1", when: { output_contains: "SNAKE_DATA_START" } },
    ]);
    const observation = { output: [...SNAKE_DATA_MARKERS], wait: { kind: "integer_value" } };
    expect(goalStatus(observation, scenario.goal).satisfied).toBe(true);
    expect(
      goalStatus({ ...observation, output: ["SNAKE_DATA_READY"] }, scenario.goal).satisfied,
    ).toBe(false);
    expect(goalStatus({ ...observation, wait: { kind: "any_key" } }, scenario.goal).satisfied).toBe(
      false,
    );
  });

  it("accepts only the starting and completed presentation revisions across painted frames", () => {
    const samples = [
      { revision: "10", waitId: "4", outputTail: ["command"] },
      { revision: "10", waitId: "4", outputTail: ["command"] },
      { revision: "14", waitId: "5", outputTail: ["complete"] },
    ];

    expect(assertAtomicPresentationTransition(samples, "14")).toMatchObject({
      startRevision: "10",
      endRevision: "14",
      paintedRevisions: ["10", "14"],
    });
    expect(() =>
      assertAtomicPresentationTransition(
        [samples[0], { revision: "12", waitId: null, outputTail: ["incomplete"] }, samples[2]],
        "14",
      ),
    ).toThrow("painted intermediate revisions");
    expect(() => assertAtomicPresentationTransition(samples.slice(0, 2), "14")).toThrow(
      "did not paint completed revision",
    );
    expect(() => assertAtomicPresentationTransition(samples.slice(0, 2), "10")).toThrow(
      "did not advance",
    );
  });

  it.each(["\n", "\r\n"])("injects the save flow using the fixture's %j newline", (newline) => {
    const source = `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}RETURN${newline}`;

    expect(injectInGameSaveFlow(source)).toBe(
      `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}SAVEGAME${newline}RETURN${newline}${newline}@SAVEINFO${newline}SAVEDATA_TEXT = "browser game save"${newline}RETURN${newline}`,
    );
  });

  it.each(["\n", "\r\n"])(
    "injects an interaction-assist button using the fixture's %j newline",
    (newline) => {
      const source = `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}INPUT${newline}RETURN${newline}`;

      expect(injectInteractionAssistFlow(source)).toBe(
        `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}$RUSTYERA_INTERACTION_ASSIST_WAIT${newline}PRINTBUTTON "ASSISTED_ACTION", 0${newline}INPUT${newline}GOTO RUSTYERA_INTERACTION_ASSIST_WAIT${newline}INPUT${newline}RETURN${newline}`,
      );
      expect(injectInteractionAssistFlow(`PRINTL ORACLE_READY${newline}SAVEGAME${newline}`)).toBe(
        `PRINTL ORACLE_READY${newline}SAVEGAME${newline}$RUSTYERA_INTERACTION_ASSIST_WAIT${newline}PRINTBUTTON "ASSISTED_ACTION", 0${newline}INPUT${newline}GOTO RUSTYERA_INTERACTION_ASSIST_WAIT${newline}`,
      );
      expect(() => injectInteractionAssistFlow("@SYSTEM_TITLE\nINPUT\n")).toThrow(
        "lacks ORACLE_READY",
      );
      expect(() => injectInteractionAssistFlow(injectInteractionAssistFlow(source))).toThrow(
        "already exposes",
      );
    },
  );

  it.each(["win32", "linux"])("lets WebDriver discover Firefox on %s", (platform) => {
    const capabilities = nativeFirefoxCapabilities(platform);
    expect(capabilities.webSocketUrl).toBeUndefined();
    expect(capabilities.pageLoadStrategy).toBe("none");
    expect(capabilities["wdio:enforceWebDriverClassic"]).toBe(true);
    expect(capabilities["wdio:geckodriverOptions"]).toEqual({
      cacheDir: path.resolve(".rustyera", "webdriver"),
      geckoDriverVersion: "0.37.1",
    });
    expect(capabilities["moz:firefoxOptions"]).toEqual({
      args: ["-headless"],
    });
  });

  it.each([true, false])("uses native Firefox on macOS with headless=%s", (headless) => {
    const capabilities = nativeFirefoxCapabilities("darwin", { headless });
    expect(capabilities.webSocketUrl).toBeUndefined();
    expect(capabilities.pageLoadStrategy).toBe("none");
    expect(capabilities["wdio:enforceWebDriverClassic"]).toBe(true);
    expect(capabilities["wdio:geckodriverOptions"]).toEqual({
      cacheDir: path.resolve(".rustyera", "webdriver"),
      geckoDriverVersion: "0.37.1",
    });
    expect(capabilities["moz:firefoxOptions"]).toEqual({
      args: headless ? ["-headless"] : [],
      binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
    });
  });

  it("waits for the target WebDriver document instead of accepting about:blank", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ url: "about:blank", readyState: "complete" })
      .mockResolvedValueOnce({ url: "http://127.0.0.1:4173/", readyState: "interactive" });

    await expect(
      waitForWebDriverDocument({ execute }, "http://127.0.0.1:4173", {
        timeoutMs: 1_000,
        stage: "test navigation",
      }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4173/",
      readyState: "interactive",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("resizes the real Chromium layout viewport through a declared action", async () => {
    const page = { evaluate: vi.fn(async () => undefined), setViewportSize: vi.fn() };

    await expect(
      runAction(page, { type: "set_viewport", width: 600, height: 800 }),
    ).resolves.toEqual({ query: { viewport: { width: 600, height: 800 } } });
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 600, height: 800 });
    expect(page.evaluate).toHaveBeenCalledOnce();
    await expect(runAction(page, { type: "set_viewport", width: 0, height: 800 })).rejects.toThrow(
      "positive integer",
    );
  });

  it("validates and preserves declared touch capability", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-touch-scenario-"));
    const scenario = path.join(directory, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        schema_version: 1,
        mode: "fixed",
        project: ".",
        has_touch: true,
        limits: { max_steps: 1, timeout_seconds: 1 },
      }),
    );
    await expect(loadScenario(scenario)).resolves.toMatchObject({ has_touch: true });

    await writeFile(
      scenario,
      JSON.stringify({
        schema_version: 1,
        mode: "fixed",
        project: ".",
        has_touch: "yes",
      }),
    );
    await expect(loadScenario(scenario)).rejects.toThrow("has_touch must be a boolean");
  });

  it("drives declared gestures through real Chromium touch input", async () => {
    const send = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const locator = {
      boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 80 })),
    };
    const page = {
      locator: vi.fn(() => locator),
      context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({ send, detach })) })),
      waitForTimeout: vi.fn(async () => undefined),
    };

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "two_finger_tap",
        locator: { css: ".game-viewport" },
      }),
    ).resolves.toEqual({ semanticInput: undefined });
    expect(send).toHaveBeenNthCalledWith(1, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 42, y: 60, id: 1, radiusX: 8, radiusY: 8, force: 1 },
        { x: 78, y: 60, id: 2, radiusX: 8, radiusY: 8, force: 1 },
      ],
    });
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(80);
    expect(detach).toHaveBeenCalledOnce();

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "unsupported",
        locator: { css: ".game-viewport" },
      }),
    ).rejects.toThrow("requires two_finger_tap or long_press");
  });

  it("releases Chromium touch input when a gesture action fails", async () => {
    const failure = new Error("gesture wait failed");
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("touch cleanup failed"));
    const detach = vi.fn(async () => undefined);
    const page = {
      locator: vi.fn(() => ({
        boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 80 })),
      })),
      context: vi.fn(() => ({ newCDPSession: vi.fn(async () => ({ send, detach })) })),
      waitForTimeout: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      runAction(page, {
        type: "touch_gesture",
        gesture: "long_press",
        locator: { css: ".game-viewport" },
      }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenNthCalledWith(2, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("accepts coalesced cold-start progress once runtime preparation completes", () => {
    expect(
      browserProjectProgressErrors({
        active: false,
        completed: true,
        gaps: 0,
        cacheHit: false,
        labels: [
          "正在复制项目文件：2/2（100%）",
          "正在枚举项目文件… · 已等待 1 秒",
          "正在准备 Runtime 资源：2/2（100%）",
        ],
      }),
    ).toEqual([]);
  });

  it("accepts an imported manifest handed directly to the runtime without rescanning", () => {
    expect(
      browserProjectProgressErrors({
        active: false,
        completed: true,
        gaps: 0,
        cacheHit: false,
        labels: [
          "正在复制项目文件：18/18（100%）",
          "正在准备项目数据：18/18（100%）",
          "正在准备 Runtime 资源：2/2（100%）",
        ],
      }),
    ).toEqual([]);
  });

  it("accepts Firefox progress labels coalesced away after a successful cold startup", () => {
    expect(
      browserProjectProgressErrors({
        active: false,
        completed: false,
        gaps: 3,
        cacheHit: false,
        labels: [],
        portableImport: {
          fallback: true,
          focusBeforeChange: true,
          directoryPicker: true,
        },
        startupTelemetry: {
          scenario: "cold",
          cacheHit: false,
          outcome: "success",
          observedStages: { importing: 11, compiling: 19, finalizing: 16 },
        },
      }),
    ).toEqual([]);
  });

  it("rejects missing progress labels when cold-start telemetry is incomplete", () => {
    expect(
      browserProjectProgressErrors({
        active: false,
        completed: false,
        gaps: 3,
        cacheHit: false,
        labels: [],
        portableImport: {
          fallback: true,
          focusBeforeChange: true,
          directoryPicker: true,
        },
        startupTelemetry: {
          scenario: "cold",
          cacheHit: false,
          outcome: "success",
          observedStages: { importing: 11, compiling: 0, finalizing: 16 },
        },
      }),
    ).toEqual([
      "project discovery",
      "continuous progress",
      "completed progress",
      "runtime preparation",
    ]);
  });

  it("rejects progress that disappears before runtime preparation completes", () => {
    expect(
      browserProjectProgressErrors({
        active: true,
        completed: false,
        gaps: 1,
        cacheHit: false,
        labels: ["正在复制项目文件：2/2（100%）", "正在读取项目文件：2/2（100%）"],
      }),
    ).toEqual(["continuous progress", "completed progress", "runtime preparation"]);
  });

  it("identifies terminal snapshot rejections without treating transient cache work as fatal", () => {
    const versionMismatch = {
      logs: [
        { message: "compiled project cache preparation started" },
        { message: "command rejected [VersionMismatch]: snapshot is stale" },
      ],
    };
    const transient = {
      logs: [{ message: "command rejected [InvalidState]: cache preparation started" }],
    };

    expect(terminalRuntimeRejection(versionMismatch)?.message).toContain("VersionMismatch");
    expect(terminalRuntimeRejection(transient)).toBeUndefined();
  });

  it("tracks and reports the runtime fields that establish long-test progress", () => {
    const snapshot = {
      phase: "ready",
      status: "项目编译完成",
      projectOpen: true,
      canInteract: false,
      wait: null,
      presentationRevision: 0,
      output: [],
      fault: null,
      logs: [{ message: "command rejected [VersionMismatch]" }],
    };

    expect(runtimeProgressSignature(snapshot)).toContain("项目编译完成");
    expect(runtimeProgressDiagnostic(snapshot)).toEqual(
      expect.objectContaining({
        phase: "ready",
        status: "项目编译完成",
        logTail: snapshot.logs,
      }),
    );
  });

  it("uses an explicit seed and translates compatible TUI inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    await mkdir(project);
    const scenario = path.join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({ schema_version: 1, project, mode: "fixed", seed: 17, inputs: [0, "A"] }),
    );

    const loaded = await loadScenario(scenario);

    expect(loaded.seed).toBe(17);
    expect(loaded.actions).toEqual([
      { type: "input", value: 0 },
      { type: "input", value: "A" },
    ]);
  });

  it("generates a recorded seed when it is omitted", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (values) => ((values[0] = 123456), values) });
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    await mkdir(project);
    const scenario = path.join(root, "scenario.json");
    await writeFile(scenario, JSON.stringify({ schema_version: 1, project }));

    expect((await loadScenario(scenario)).seed).toBe(123456);
    vi.unstubAllGlobals();
  });

  it("preserves a full u64 seed supplied as a decimal string", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    await mkdir(project);
    const scenario = path.join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({ schema_version: 1, project, seed: "18446744073709551615" }),
    );

    expect((await loadScenario(scenario)).seed).toBe("18446744073709551615");
  });

  it("reports semantic output and wait differences", () => {
    const rust = { output_delta: { added: ["left"] }, wait: { kind: "integer" } };
    const reference = { output_delta: { added: ["right"] }, wait: { kind: "StrValue" } };

    expect(compareObservations(rust, reference).equal).toBe(false);
  });

  it("copies only an explicitly requested compiled cache from frontend-private state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    const cache = path.join(project, ".rustyera", "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "compiled-project.reracache"), "cache");
    await writeFile(path.join(cache, "source-index-v1.json"), "index");

    const isolated = await isolatedProject(project, { compiledCache: true });

    await expect(
      access(path.join(isolated.project, ".rustyera", "cache", "compiled-project.reracache")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(isolated.project, ".rustyera", "cache", "source-index-v1.json")),
    ).rejects.toThrow();
    await isolated.close();
  });

  it("installs an explicit cross-host compiled cache without copying other private state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "game.ERB"), "@SYSTEM_TITLE\nRETURN\n");
    const source = await stat(path.join(project, "game.ERB"), { bigint: true });
    const portableMtime = 1_700_000_000_123;
    const incoming = path.join(root, "tui.reracache");
    const incomingIndex = path.join(root, "tui-source-index.json");
    await writeFile(incoming, "tui-cache");
    await writeFile(
      incomingIndex,
      JSON.stringify({
        version: 3,
        files: {
          "game.ERB": {
            category: 2,
            signature: `${source.size}:${portableMtime}`,
            hash: "00".repeat(32),
            size: Number(source.size),
          },
        },
      }),
    );

    const isolated = await isolatedProject(project, {
      compiledCacheInput: incoming,
      sourceIndexInput: incomingIndex,
    });

    await expect(
      readFile(
        path.join(isolated.project, ".rustyera", "cache", "compiled-project.reracache"),
        "utf8",
      ),
    ).resolves.toBe("tui-cache");
    await expect(
      readFile(path.join(isolated.project, ".rustyera", "cache", "source-index-v1.json"), "utf8"),
    ).resolves.toContain('"version":3');
    const installedSource = await stat(path.join(isolated.project, "game.ERB"), { bigint: true });
    expect(installedSource.mtimeNs / 1_000_000n).toBe(BigInt(portableMtime));
    await isolated.close();
  });

  it("publishes successful cross-host artifacts without private state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-handoff-"));
    const source = path.join(root, "source");
    const isolated = path.join(root, "isolated");
    await mkdir(path.join(isolated, ".rustyera", "cache"), { recursive: true });
    await mkdir(source);
    await writeFile(path.join(isolated, "main.erb"), "@SYSTEM_TITLE\nRETURN\n");
    await writeFile(
      path.join(isolated, ".rustyera", "cache", "compiled-project.reracache"),
      "cache",
    );
    await writeFile(
      path.join(isolated, ".rustyera", "cache", "source-index-v1.json"),
      '{"version":3,"files":{}}',
    );
    const cacheOutput = path.join(root, "cache.reracache");
    const sourceIndexOutput = path.join(root, "source-index.json");
    const projectOutput = path.join(root, "project-output");

    await publishCrossHostArtifacts({
      source,
      isolated,
      cacheOutput,
      sourceIndexOutput,
      projectOutput,
      succeeded: true,
      cacheSaved: true,
    });

    await expect(readFile(cacheOutput, "utf8")).resolves.toBe("cache");
    await expect(readFile(sourceIndexOutput, "utf8")).resolves.toContain('"version":3');
    await expect(readFile(path.join(projectOutput, "main.erb"), "utf8")).resolves.toContain(
      "SYSTEM_TITLE",
    );
    await expect(access(path.join(projectOutput, ".rustyera"))).rejects.toThrow();
  });

  it("does not publish a failed handoff and rejects unsafe targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-handoff-"));
    const source = path.join(root, "source");
    const isolated = path.join(root, "isolated");
    await mkdir(source);
    await mkdir(isolated);
    const output = path.join(root, "cache.reracache");

    await publishCrossHostArtifacts({
      source,
      isolated,
      cacheOutput: output,
      succeeded: false,
      cacheSaved: false,
    });
    await expect(access(output)).rejects.toThrow();
    await expect(
      publishCrossHostArtifacts({
        source,
        isolated,
        cacheInput: output,
        cacheOutput: output,
        succeeded: true,
        cacheSaved: true,
      }),
    ).rejects.toThrow("must differ");

    await expect(
      publishCrossHostArtifacts({
        source,
        isolated,
        cacheOutput: path.join(source, "nested.reracache"),
        succeeded: true,
        cacheSaved: true,
      }),
    ).rejects.toThrow("overlaps project state");

    const nonempty = path.join(root, "nonempty-project");
    await mkdir(nonempty);
    await writeFile(path.join(nonempty, "keep.txt"), "keep");
    await expect(
      publishCrossHostArtifacts({
        source,
        isolated,
        projectOutput: nonempty,
        succeeded: true,
        cacheSaved: false,
      }),
    ).rejects.toThrow("absent or empty");

    await writeFile(output, "existing");
    await expect(
      publishCrossHostArtifacts({
        source,
        isolated,
        cacheOutput: output,
        succeeded: true,
        cacheSaved: true,
      }),
    ).rejects.toThrow("must not exist");
  });

  it("does nothing when cross-host outputs are not requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-handoff-"));
    await expect(
      publishCrossHostArtifacts({
        source: path.join(root, "source"),
        isolated: path.join(root, "isolated"),
        succeeded: true,
        cacheSaved: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires an observed producer cache save before publishing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-handoff-"));
    const source = path.join(root, "source");
    const isolated = path.join(root, "isolated");
    await mkdir(source);
    await mkdir(isolated);

    await expect(
      publishCrossHostArtifacts({
        source,
        isolated,
        cacheOutput: path.join(root, "cache.reracache"),
        succeeded: true,
        cacheSaved: false,
      }),
    ).rejects.toThrow("observed successful cache save");
  });

  it("checks diagnosis project hashes from the real decoded project manifest", async () => {
    const source = "@SYSTEM_TITLE\nRETURN\n";
    const hash = [...blake3(new TextEncoder().encode(source))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const page = {
      evaluate: vi.fn(async () => ({
        lastDownload: {
          projectHashes: {
            "erb/main.erb": hash,
          },
        },
      })),
    };

    await expect(
      runAction(page, {
        type: "assert_diagnosis_project_manifest",
        sources: { "erb/main.erb": source },
      }),
    ).resolves.toEqual({ semanticInput: undefined });
  });

  it("can isolate a fresh game without existing saves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "web-scenario-"));
    const project = path.join(root, "project");
    await mkdir(path.join(project, "sav"), { recursive: true });
    await writeFile(path.join(project, "sav", "global.sav"), "legacy save");
    await writeFile(path.join(project, "game.ERB"), "@EVENTFIRST\nRETURN");

    const isolated = await isolatedProject(project, { cleanSaves: true });

    await expect(access(path.join(isolated.project, "game.ERB"))).resolves.toBeUndefined();
    await expect(access(path.join(isolated.project, "sav", "global.sav"))).rejects.toThrow();
    await isolated.close();
  });

  it("types a submitted runtime input as physical keys before consuming the wait", async () => {
    let waitId = "4";
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: { snapshot: () => ({ fault: null, wait: { wait_id: waitId } }) },
    });
    const input = { fill: vi.fn(), pressSequentially: vi.fn() };
    const button = { click: vi.fn(() => (waitId = "5")) };
    const page = {
      evaluate: vi.fn((callback) => callback()),
      locator: vi.fn((selector) => (selector.includes("input") ? input : button)),
      waitForFunction: vi.fn((callback, argument) => callback(argument)),
    };

    await expect(runAction(page, { type: "input", value: 100 })).resolves.toEqual({
      semanticInput: "100",
    });

    expect(input.fill).toHaveBeenCalledWith("");
    expect(input.pressSequentially).toHaveBeenCalledWith("100");
    expect(button.click).toHaveBeenCalledOnce();
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), "4");
    vi.unstubAllGlobals();
  });

  it("observes a timed input transition before its changing deadline state can expire", async () => {
    const pending = { canInteract: false, wait: null };
    const timed = { canInteract: true, wait: { deadline_ns: 5_000_000_000 } };
    const snapshots = [pending, timed];
    const waitForStableObservation = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: {
        snapshot: () => snapshots.shift() ?? timed,
        waitForStableObservation,
      },
      requestAnimationFrame: (callback) => callback(),
    });
    const page = { evaluate: vi.fn((callback, argument) => callback(argument)) };

    await expect(waitForRuntimeObservation(page, 5_000)).resolves.toBe(timed);
    expect(waitForStableObservation).toHaveBeenCalledWith(5_000);
    vi.unstubAllGlobals();
  });

  it("retains stable-frame observation for untimed input", async () => {
    const current = { canInteract: true, wait: { deadline_ns: null } };
    const stable = { ...current, output: ["stable"] };
    const waitForStableObservation = vi.fn(async () => stable);
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: { snapshot: () => current, waitForStableObservation },
      requestAnimationFrame: vi.fn(),
    });
    const page = { evaluate: vi.fn((callback, argument) => callback(argument)) };

    await expect(waitForRuntimeObservation(page, 5_000)).resolves.toBe(stable);
    expect(waitForStableObservation).toHaveBeenCalledWith(5_000);
    vi.unstubAllGlobals();
  });

  it.each([".game-viewport", ".interaction-assist-panel"])(
    "waits for a clicked runtime button in %s to consume the current wait",
    async (container) => {
      let waitId = "8";
      vi.stubGlobal("window", {
        __RUSTYERA_TEST__: { snapshot: () => ({ fault: null, wait: { wait_id: waitId } }) },
      });
      const locator = {
        evaluate: vi.fn((callback) =>
          callback({
            closest: (selector) => {
              if (selector === ".game-viewport" && container === ".game-viewport") return {};
              if (
                selector === ".interaction-assist-action" &&
                container === ".interaction-assist-panel"
              )
                return {};
              return selector === "button" ? {} : null;
            },
            matches: (selector) =>
              selector === "button" ||
              (selector === ".interaction-assist-action" &&
                container === ".interaction-assist-panel"),
          }),
        ),
        click: vi.fn(() => (waitId = "9")),
      };
      const page = {
        getByText: vi.fn(() => locator),
        evaluate: vi.fn((callback) => callback()),
        waitForFunction: vi.fn((callback, argument) => callback(argument)),
      };

      await expect(
        runAction(page, {
          type: "click",
          locator: { text: "[画像表示]", exact: true },
        }),
      ).resolves.toEqual({ semanticInput: undefined });

      expect(locator.click).toHaveBeenCalledOnce();
      expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), "8");
      vi.unstubAllGlobals();
    },
  );

  it("does not wait for a panel disclosure button to consume a runtime wait", async () => {
    const locator = {
      evaluate: vi.fn((callback) =>
        callback({
          closest: (selector) => (selector === "button" ? {} : null),
          matches: (selector) => selector === "button",
        }),
      ),
      click: vi.fn(),
    };
    const page = {
      getByRole: vi.fn(() => locator),
      evaluate: vi.fn(),
      waitForFunction: vi.fn(),
    };

    await runAction(page, {
      type: "click",
      locator: { role: "button", name: "展开", exact: true },
    });

    expect(locator.click).toHaveBeenCalledOnce();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("drives hover through the production DOM locator", async () => {
    const locator = { hover: vi.fn() };
    const page = { getByText: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "hover",
        locator: { text: "hover target", exact: true },
      }),
    ).resolves.toEqual({ semanticInput: undefined });

    expect(page.getByText).toHaveBeenCalledWith("hover target", { exact: true });
    expect(locator.hover).toHaveBeenCalledOnce();
  });

  it("scrolls a focused production viewport with real keyboard input", async () => {
    const locator = { focus: vi.fn() };
    const page = {
      locator: vi.fn(() => locator),
      keyboard: { press: vi.fn() },
      waitForTimeout: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "scroll_key",
        locator: { css: ".game-viewport" },
        key: "PageUp",
        settle_ms: 80,
      }),
    ).resolves.toEqual({ semanticInput: undefined });

    expect(locator.focus).toHaveBeenCalledOnce();
    expect(page.keyboard.press).toHaveBeenCalledWith("PageUp");
    expect(page.waitForTimeout).toHaveBeenCalledWith(80);
  });

  it("can select the latest match for a repeated screen label", () => {
    const latest = {};
    const matches = { nth: vi.fn(() => latest) };
    const page = { getByText: vi.fn(() => matches) };

    expect(resolveLocator(page, { text: "第1年", exact: false, nth: -1 })).toBe(latest);
    expect(matches.nth).toHaveBeenCalledWith(-1);
  });

  it("requires positioned images to finish decoding", async () => {
    const image = globalThis.document.createElement("img");
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 1200 },
    });
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      isVisible: vi.fn(async () => true),
      evaluate: vi.fn(async (callback) => callback(image)),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: ".media-visual" },
        fields: ["count", "visible", "image_loaded"],
        expect: { count: 1, visible: true, image_loaded: true },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: { count: 1, visible: true, image_loaded: true },
      }),
    );
  });

  it("asserts the live checked state of form controls", async () => {
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      isChecked: vi.fn(async () => true),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: "input[type=checkbox]" },
        fields: ["count", "checked"],
        expect: { count: 1, checked: true },
      }),
    ).resolves.toMatchObject({ query: { count: 1, checked: true } });
  });

  it("reports whether vertical overflow is actually scrollable", async () => {
    const element = globalThis.document.createElement("div");
    element.style.overflowY = "auto";
    Object.defineProperties(element, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 240 },
    });
    const locator = {
      count: vi.fn(async () => 1),
      first: vi.fn(() => locator),
      evaluate: vi.fn(async (callback) => callback(element)),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_dom",
        locator: { css: ".scrollable" },
        fields: ["count", "scrollable_y"],
        expect: { count: 1, scrollable_y: true },
      }),
    ).resolves.toMatchObject({ query: { count: 1, scrollable_y: true } });
  });

  it("asserts reference-relative layout without hard-coding viewport coordinates", async () => {
    const box = (left, top, width, height) => ({
      getBoundingClientRect: () => ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      }),
    });
    const subject = {
      evaluateAll: vi.fn((callback) => callback([box(88, 10, 24, 24), box(88.4, 10.3, 24, 24)])),
    };
    const reference = {
      evaluateAll: vi.fn((callback) => callback([box(0, 40, 200, 20)])),
    };
    const page = {
      locator: vi.fn((selector) => (selector === ".layers" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".layers" },
        relative_to: { css: ".text" },
        expect: {
          count: 2,
          visible: true,
          same_left_within: 1,
          same_top_within: 1,
          above: { min: 5, max: 10 },
          no_overlap: true,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: expect.objectContaining({ layout: expect.objectContaining({ count: 2 }) }),
      }),
    );
  });

  it("asserts bottom alignment against the reference scene image", async () => {
    const box = (top, height) => ({
      getBoundingClientRect: () => ({
        left: 0,
        top,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(40, 60)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 101)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".portrait" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".portrait" },
        relative_to: { css: ".background" },
        expect: { bottom_aligned_within: 1 },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("asserts left alignment against a reference element", async () => {
    const box = (left) => ({
      getBoundingClientRect: () => ({
        left,
        top: 0,
        right: left + 100,
        bottom: 40,
        width: 100,
        height: 40,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(40.5)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(40)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".control" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".control" },
        relative_to: { css: ".label" },
        expect: { left_aligned_within: 1 },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("asserts horizontal centering against a reference box", async () => {
    const box = (left, width) => ({
      getBoundingClientRect: () => ({
        left,
        top: 0,
        right: left + width,
        bottom: 40,
        width,
        height: 40,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(39, 20)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 100)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".title" ? subject : reference)),
    };
    const action = {
      type: "assert_layout",
      locator: { css: ".title" },
      relative_to: { css: ".viewport" },
      expect: { horizontal_centered_within: 1 },
    };

    await expect(runAction(page, action)).resolves.toEqual(
      expect.objectContaining({ query: expect.any(Object) }),
    );

    subject.evaluateAll.mockImplementationOnce((callback) => callback([box(37, 20)]));
    await expect(runAction(page, action)).rejects.toThrow(
      "assertion failed at layout.horizontal_center",
    );
  });

  it("asserts vertical centering against a reference box", async () => {
    const box = (top, height) => ({
      getBoundingClientRect: () => ({
        left: 0,
        top,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
      }),
    });
    const subject = { evaluateAll: vi.fn((callback) => callback([box(9, 20)])) };
    const reference = { evaluateAll: vi.fn((callback) => callback([box(0, 40)])) };
    const page = {
      locator: vi.fn((selector) => (selector === ".control" ? subject : reference)),
    };
    const action = {
      type: "assert_layout",
      locator: { css: ".control" },
      relative_to: { css: ".label" },
      expect: { vertical_centered_within: 1 },
    };

    await expect(runAction(page, action)).resolves.toEqual(
      expect.objectContaining({ query: expect.any(Object) }),
    );

    subject.evaluateAll.mockImplementationOnce((callback) => callback([box(6, 20)]));
    await expect(runAction(page, action)).rejects.toThrow(
      "assertion failed at layout.vertical_center",
    );
  });

  it("can measure a text locator by its logical game-line box", async () => {
    const line = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 40,
        right: 200,
        bottom: 60,
        width: 200,
        height: 20,
      }),
    };
    const text = {
      closest: vi.fn((selector) => (selector === ".game-line" ? line : null)),
      getBoundingClientRect: () => ({
        left: 20,
        top: 36,
        right: 80,
        bottom: 58,
        width: 60,
        height: 22,
      }),
    };
    const subject = {
      evaluateAll: vi.fn((callback, mode) =>
        callback(
          [
            {
              getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                right: 100,
                bottom: 40,
                width: 100,
                height: 40,
              }),
            },
          ],
          mode,
        ),
      ),
    };
    const reference = {
      evaluateAll: vi.fn((callback, mode) => callback([text], mode)),
    };
    const page = {
      locator: vi.fn((selector) => (selector === ".image" ? subject : reference)),
    };

    await expect(
      runAction(page, {
        type: "assert_layout",
        locator: { css: ".image" },
        relative_to: { css: ".title" },
        relative_box: "game_line",
        expect: { above: { min: 0, max: 0 }, no_overlap: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ query: expect.any(Object) }));
  });

  it("stops explicit Enter advancement when the current output tail reaches a screen", async () => {
    const snapshots = [
      { output: ["opening"], wait: { kind: "enter_key", wait_id: "1" } },
      {
        output: ["old history", "第1年  1月  8日 周一", "亚斯特丽德的工房"],
        wait: { kind: "enter_key", wait_id: "2" },
      },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "第1年  1月  8日", tail_lines: 3 },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("continues a variable number of route prompts until a distinct portrait source appears", async () => {
    const snapshots = [
      { fault: null, wait: { kind: "integer_value", wait_id: "1" } },
      { fault: null, wait: { kind: "enter_key", wait_id: "2" } },
      { fault: null, wait: { kind: "integer_value", wait_id: "3" } },
    ];
    let snapshotIndex = 0;
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: {
        snapshot: () => snapshots[snapshotIndex],
        mediaPlacements: () => ({
          images:
            snapshotIndex < 2 ? [{ source: "clock" }] : [{ source: "clock" }, { source: "reimu" }],
        }),
        waitForStableObservation: () => snapshots[snapshotIndex],
      },
    });
    const fill = vi.fn();
    const click = vi.fn(() => {
      snapshotIndex += 1;
    });
    const page = {
      evaluate: vi.fn((callback) => callback()),
      locator: vi.fn((selector) =>
        selector === ".prompt-bar input" ? { fill } : { click, first: () => ({ click }) },
      ),
      waitForFunction: vi.fn((callback, argument) => callback(argument)),
    };

    await expect(
      runAction(page, {
        type: "advance_intermediate_waits_until",
        maximum: 10,
        integer_value: 0,
        until: { media_sources_at_least: 2 },
      }),
    ).resolves.toMatchObject({ attempts: 2, numericInputs: 1, mediaSources: 2 });
    expect(fill).toHaveBeenCalledWith("0");
    expect(click).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("waits past a text-matched fade frame until the screen locator is visible", async () => {
    const snapshots = [
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "1" } },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const target = {
      count: vi.fn(() => (snapshotIndex ? 1 : 0)),
      first: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(true) })),
    };
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn((selector) => (selector === ".target" ? target : { click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: {
          output_tail_contains: "目标场景",
          locator: { css: ".target" },
        },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("lets deadline waits advance without clicking the game input", async () => {
    const snapshots = [
      {
        output: ["淡入中"],
        wait: { kind: "void", wait_id: "1", deadline_ns: "10000000" },
      },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标场景" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).not.toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it("waits for active right-click skipping when automatic Enter submission is disabled", async () => {
    const snapshots = [
      { output: ["过场中"], wait: { kind: "enter_key", wait_id: "1" } },
      { output: ["目标场景"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        auto_enter: false,
        until: { output_tail_contains: "目标场景" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).not.toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it("submits Enter-compatible one-input message waits while advancing dialogue", async () => {
    const snapshots = [
      {
        output: ["打字完成"],
        wait: { kind: "string_value", wait_id: "1", one_input: true },
      },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click, first: () => ({ click }) })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("waits through a transient missing prompt between dialogue waits", async () => {
    const snapshots = [
      { output: ["转场中"], wait: null },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
  });

  it("advances an any-key introduction wait through the visible submit control", async () => {
    const snapshots = [
      { output: ["继续介绍"], wait: { kind: "any_key", wait_id: "1" } },
      { output: ["目标对话"], wait: { kind: "enter_key", wait_id: "2" } },
    ];
    let snapshotIndex = 0;
    const click = vi.fn();
    const page = {
      evaluate: vi.fn((callback) => {
        if (String(callback).includes("waitForStableObservation")) {
          snapshotIndex += 1;
          return snapshots[snapshotIndex];
        }
        return snapshots[snapshotIndex];
      }),
      locator: vi.fn(() => ({ click })),
      waitForFunction: vi.fn(),
    };

    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 5,
        until: { output_tail_contains: "目标对话" },
      }),
    ).resolves.toMatchObject({ attempts: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it("samples changing DOM content while scroll and layout stay in place", async () => {
    let frame = 0;
    let unstableScroll = false;
    let staticContent = false;
    const viewport = globalThis.document.createElement("div");
    Object.defineProperties(viewport, {
      scrollTop: { get: () => 320 + (unstableScroll ? frame : 0) },
      scrollHeight: { get: () => 900 },
      clientHeight: { get: () => 600 },
    });
    const heading = globalThis.document.createElement("div");
    heading.getBoundingClientRect = () => ({
      left: 20,
      top: 80,
      right: 220,
      bottom: 100,
      width: 200,
      height: 20,
    });
    const locatorFor = (elements) => {
      const locator = {
        count: vi.fn(async () => elements().length),
        first: vi.fn(() => ({
          evaluate: vi.fn(async (callback) => callback(elements()[0])),
        })),
        evaluateAll: vi.fn(async (callback) => callback(elements())),
      };
      return locator;
    };
    const viewportLocator = locatorFor(() => [viewport]);
    const headingLocator = locatorFor(() => [heading]);
    const linesLocator = locatorFor(() =>
      Array.from({ length: 4 }, (_, index) => {
        const line = globalThis.document.createElement("div");
        line.dataset.index = String(index);
        line.style.color = `rgb(${staticContent ? 0 : frame}, 0, 0)`;
        return line;
      }),
    );
    const page = {
      evaluate: vi.fn(async () => ({
        fault: null,
        presentationRevision: frame,
        historyRevision: 4,
        output: ["map"],
      })),
      locator: vi.fn((selector) => {
        if (selector === ".game-viewport") return viewportLocator;
        if (selector === ".map-heading") return headingLocator;
        return linesLocator;
      }),
      waitForTimeout: vi.fn(async () => {
        frame += 1;
      }),
    };
    const action = {
      type: "sample_queries",
      count: 3,
      interval_ms: 10,
      queries: [
        {
          name: "viewport",
          locator: { css: ".game-viewport" },
          fields: ["scroll_top", "scroll_height", "client_height"],
        },
        {
          name: "lines",
          locator: { css: ".game-line" },
          fields: ["count", "content_signature"],
        },
        { name: "map", locator: { css: ".map-heading" }, fields: ["box"] },
      ],
      expect: {
        stable: ["viewport.scroll_top", "viewport.scroll_height", "lines.count", "map.box.top"],
        changes: ["lines.content_signature"],
      },
    };

    const result = await runAction(page, action);
    expect(result.query.samples).toHaveLength(3);
    expect(result.query.samples[0]).toMatchObject({
      runtime: { presentation_revision: 0, history_revision: 4, output_count: 1 },
      viewport: { scroll_top: 320 },
      lines: { count: 4 },
    });
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);

    frame = 0;
    unstableScroll = true;
    await expect(runAction(page, action)).rejects.toThrow(
      "sample_queries.stable.viewport.scroll_top",
    );

    frame = 0;
    unstableScroll = false;
    staticContent = true;
    await expect(runAction(page, action)).rejects.toThrow(
      "sample_queries.changes.lines.content_signature",
    );

    frame = 0;
    await expect(
      runAction(page, {
        ...action,
        expect: { stable: ["map.box.missing"] },
      }),
    ).rejects.toThrow("path map.box.missing is missing from sample 0");
  });

  it("asserts that a generated canvas contains rendered pixels", async () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[3] = 255;
    pixels[11] = 128;
    const canvas = {
      tagName: "CANVAS",
      width: 4,
      height: 4,
      getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    };
    const locator = {
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn(() => ({
        evaluate: vi.fn((callback, count) => {
          const OriginalCanvas = globalThis.HTMLCanvasElement;
          Object.setPrototypeOf(canvas, OriginalCanvas.prototype);
          return callback(canvas, count);
        }),
      })),
    };
    const page = { locator: vi.fn(() => locator) };

    await expect(
      runAction(page, {
        type: "assert_canvas_pixels",
        locator: { css: ".canvas-replay" },
        expect: { count: 1, width: 4, height: 4, nontransparent_at_least: 2 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        query: { canvas_pixels: { count: 1, width: 4, height: 4, nontransparent: 2 } },
      }),
    );
  });
});

describe("snake service scenarios", () => {
  it("uses a visible pointer click and preserves the whole initialization goal", async () => {
    const services = await loadScenario("tools/runtime-tester/scenarios/snake-services.json");
    expect(services.actions.at(-1)).toMatchObject({
      type: "click",
      semantic_input: "41",
      advances_game: true,
    });
    const combined = await loadScenario("tools/runtime-tester/scenarios/snake-batch1.json");
    expect(
      goalStatus({ output: ["SNAKE_BATCH1_READY"], wait: { kind: "integer_value" } }, combined.goal)
        .satisfied,
    ).toBe(false);
    expect(
      goalStatus(
        { output: [...combined.goal.output_contains], wait: { kind: "integer_value" } },
        combined.goal,
      ).satisfied,
    ).toBe(true);
  });
});

describe("snake pointer lifecycle scenario", () => {
  it("uses real hover, resize, scroll and keyboard actions and retains five independent button observations", async () => {
    const scenario = await loadScenario(
      "tools/runtime-tester/scenarios/snake-service-lifecycle.json",
    );
    expect(scenario.actions.filter((action) => action.type === "press")).toHaveLength(5);
    expect(scenario.actions.some((action) => action.type === "set_viewport")).toBe(true);
    expect(
      scenario.actions.some((action) => action.type === "scroll_key" && action.key === "PageUp"),
    ).toBe(true);
    expect(scenario.goal.watch_equals).toEqual({
      "LIFE_BUTTON:0": "41",
      "LIFE_BUTTON:1": "",
      "LIFE_BUTTON:2": "",
      "LIFE_BUTTON:3": "41",
      "LIFE_BUTTON:4": "",
    });
    const complete = {
      output: [...scenario.goal.output_contains],
      wait: { kind: "integer_value" },
      watches: { ...scenario.goal.watch_equals },
    };
    expect(goalStatus(complete, scenario.goal).satisfied).toBe(true);
    expect(
      goalStatus(
        { ...complete, watches: { ...complete.watches, "LIFE_BUTTON:4": "41" } },
        scenario.goal,
      ).satisfied,
    ).toBe(false);
  });
});
