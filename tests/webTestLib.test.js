import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  browserProjectProgressErrors,
  compareObservations,
  injectInGameSaveFlow,
  isolatedProject,
  loadScenario,
  nativeFirefoxCapabilities,
  resolveLocator,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  runAction,
  terminalRuntimeRejection,
} from "../scripts/web-test-lib.mjs";

describe("web game test scenario", () => {
  it.each(["\n", "\r\n"])("injects the save flow using the fixture's %j newline", (newline) => {
    const source = `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}RETURN${newline}`;

    expect(injectInGameSaveFlow(source)).toBe(
      `@SYSTEM_TITLE${newline}PRINTL ORACLE_READY${newline}SAVEGAME${newline}RETURN${newline}${newline}@SAVEINFO${newline}SAVEDATA_TEXT = "browser game save"${newline}RETURN${newline}`,
    );
  });

  it.each(["win32", "linux"])("lets WebDriver discover Firefox on %s", (platform) => {
    expect(nativeFirefoxCapabilities(platform)["moz:firefoxOptions"]).toEqual({
      args: ["-headless"],
    });
  });

  it("uses the native Firefox application path on macOS", () => {
    expect(nativeFirefoxCapabilities("darwin")["moz:firefoxOptions"]).toEqual({
      args: ["-headless"],
      binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
    });
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

  it("waits for a submitted runtime input to consume the current wait", async () => {
    let waitId = "4";
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: { snapshot: () => ({ fault: null, wait: { wait_id: waitId } }) },
    });
    const input = { fill: vi.fn() };
    const button = { click: vi.fn(() => (waitId = "5")) };
    const page = {
      evaluate: vi.fn((callback) => callback()),
      locator: vi.fn((selector) => (selector.includes("input") ? input : button)),
      waitForFunction: vi.fn((callback, argument) => callback(argument)),
    };

    await expect(runAction(page, { type: "input", value: 100 })).resolves.toEqual({
      semanticInput: "100",
    });

    expect(input.fill).toHaveBeenCalledWith("100");
    expect(button.click).toHaveBeenCalledOnce();
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), "4");
    vi.unstubAllGlobals();
  });

  it("waits for a clicked runtime button to consume the current wait", async () => {
    let waitId = "8";
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: { snapshot: () => ({ fault: null, wait: { wait_id: waitId } }) },
    });
    const locator = {
      evaluate: vi.fn(() => true),
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
