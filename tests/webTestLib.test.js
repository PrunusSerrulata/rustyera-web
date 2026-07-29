import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { compareObservations, isolatedProject, loadScenario } from "../scripts/web-test-lib.mjs";

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
});
