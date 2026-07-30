import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  compareObservations,
  isolatedProject,
  loadScenario,
  resolveLocator,
  runAction,
} from "../scripts/web-test-lib.mjs";

describe("web game test scenario", () => {
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
    await writeFile(path.join(cache, "compiled-project-v8.bin.zst"), "cache");
    await writeFile(path.join(cache, "source-index-v1.json"), "index");

    const isolated = await isolatedProject(project, { compiledCache: true });

    await expect(
      access(path.join(isolated.project, ".rustyera", "cache", "compiled-project-v8.bin.zst")),
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

  it("can select the latest match for a repeated screen label", () => {
    const latest = {};
    const matches = { nth: vi.fn(() => latest) };
    const page = { getByText: vi.fn(() => matches) };

    expect(resolveLocator(page, { text: "第1年", exact: false, nth: -1 })).toBe(latest);
    expect(matches.nth).toHaveBeenCalledWith(-1);
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
