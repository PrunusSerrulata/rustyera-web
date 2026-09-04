import {
  TextEncoder,
  access,
  blake3,
  browserProjectProgressErrors,
  compareObservations,
  describe,
  expect,
  isolatedProject,
  it,
  loadScenario,
  mkdir,
  mkdtemp,
  packagedProjectProgressErrors,
  path,
  publishCrossHostArtifacts,
  readFile,
  runAction,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  stat,
  terminalRuntimeRejection,
  tmpdir,
  vi,
  waitForRuntimeObservation,
  writeFile,
} from "./webTestLib.testHarness";

describe("web game test scenario", () => {
  it("uses packaged cache progress policy independently of native file upload", () => {
    const progress = {
      active: false,
      completed: true,
      cacheHit: true,
      gaps: 4,
      labels: [
        "正在读取项目文件：1/1（100%）",
        "项目缓存命中，正在准备脚本热重载…",
        "正在准备 Runtime 资源：1/1（100%）",
      ],
    };
    expect(packagedProjectProgressErrors(progress, false)).toEqual([]);
    expect(packagedProjectProgressErrors({ ...progress, completed: false }, false)).toContain(
      "continuous completed progress",
    );
    expect(packagedProjectProgressErrors({ ...progress, cacheHit: false }, false)).toContain(
      "compiled cache hit",
    );
    expect(packagedProjectProgressErrors({ ...progress, labels: [] }, false)).toEqual([
      "file read",
      "cache handoff",
    ]);
    expect(packagedProjectProgressErrors(progress)).toEqual([
      "project preferences during loading",
      "project preferences after loading",
    ]);
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

  it.each([true, false])(
    "accepts coalesced cold-start progress with synthetic focus=%s",
    (focusBeforeChange) => {
      expect(
        browserProjectProgressErrors({
          active: false,
          completed: false,
          gaps: 3,
          cacheHit: false,
          labels: [],
          portableImport: {
            fallback: true,
            focusBeforeChange,
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
    },
  );

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
      __RUSTYERA_TEST__: {
        snapshot: () => {
          throw new Error("input must not decode unrelated protocol evidence");
        },
        snapshotSummary: () => ({ fault: null, wait: { wait_id: waitId } }),
      },
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
        snapshot: () => timed,
        snapshotSummary: () => snapshots.shift() ?? timed,
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
      __RUSTYERA_TEST__: {
        snapshot: () => current,
        snapshotSummary: () => current,
        waitForStableObservation,
      },
      requestAnimationFrame: vi.fn(),
    });
    const page = { evaluate: vi.fn((callback, argument) => callback(argument)) };

    await expect(waitForRuntimeObservation(page, 5_000)).resolves.toBe(stable);
    expect(waitForStableObservation).toHaveBeenCalledWith(5_000);
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "omits unrelated wire payloads from requested summary observations (timed=%s)",
    async (timed) => {
      const current = {
        canInteract: true,
        wait: { deadline_ns: timed ? 5000000 : null },
        output: ["ready"],
      };
      const waitForStableObservation = vi.fn(async () => current);
      vi.stubGlobal("window", {
        __RUSTYERA_TEST__: {
          snapshot: () => {
            throw new Error("unrelated wire payload must not be materialized");
          },
          snapshotSummary: () => current,
          waitForStableObservation,
        },
        requestAnimationFrame: vi.fn(),
      });
      const page = { evaluate: vi.fn((callback, argument) => callback(argument)) };
      try {
        await expect(waitForRuntimeObservation(page, 5000, true)).resolves.toBe(current);
        expect(waitForStableObservation).toHaveBeenCalledWith(5000, true);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([".game-viewport", ".interaction-assist-panel"])(
    "waits for a clicked runtime button in %s to consume the current wait",
    async (container) => {
      let waitId = "8";
      vi.stubGlobal("window", {
        __RUSTYERA_TEST__: {
          snapshot: () => {
            throw new Error("input must not decode unrelated protocol evidence");
          },
          snapshotSummary: () => ({ fault: null, wait: { wait_id: waitId } }),
        },
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
});
