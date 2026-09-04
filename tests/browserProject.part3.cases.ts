import {
  BrowserProject,
  SaveDirectoryHandle,
  SaveFileHandle,
  blake3,
  cacheIdentityManifest,
  createProjectProgressReporter,
  decodeProjectSource,
  deferred,
  describe,
  expect,
  it,
  referenceCompatibility,
  referenceProject,
  runBounded,
  saveSlotName,
  snakeCompatibility,
  vi,
  writeFixtureFile,
} from "./browserProject.testHarness";

describe("browser project reads", () => {
  it("does not roll back authoritative configuration when stale-cache deletion fails", async () => {
    const root = new SaveDirectoryHandle("game");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    await (await cache.createWritable()).write(new TextEncoder().encode("stale-cache"));
    cacheDirectory.removeEntry = async () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    project.useConfigurationUpdatePreparer(async () => {
      throw new Error("stale cache");
    });

    await expect(
      project.writeConfiguration(new Uint8Array(), "[audio]\nvolume = 42\n"),
    ).resolves.toBeUndefined();

    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      "[audio]\nvolume = 42\n",
    );
    await expect(cacheDirectory.getFileHandle("compiled-project.reracache")).resolves.toBe(cache);
  });

  it("treats repeated first-time writes as idempotent and rejects non-UTF-8 TOML", async () => {
    const root = new SaveDirectoryHandle("game");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    const contents = "[meta]\nschema_version = 1\n";
    await project.writeConfiguration(new Uint8Array(), contents);
    await project.writeConfiguration(new Uint8Array(), contents.replaceAll("\n", "\r\n"));
    expect(() => decodeProjectSource(Uint8Array.of(0x81), "reraconfig.toml")).toThrow("UTF-8");
  });

  it("treats an already-applied schema upgrade as idempotent", async () => {
    const root = new SaveDirectoryHandle("game");
    const original = "[meta]\nschema_version = 1\n";
    const upgraded = "[meta]\nschema_version = 2\n";
    const writer = await (
      await root.getFileHandle("reraconfig.toml", { create: true })
    ).createWritable();
    await writer.write(new TextEncoder().encode(original));
    await writer.close();
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    const originalDigest = blake3(new TextEncoder().encode(original));
    await project.writeConfiguration(originalDigest, upgraded);
    await project.writeConfiguration(originalDigest, upgraded);
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      upgraded,
    );
  });

  it("keeps packaged configuration read-only without a writable file handle", async () => {
    const project = referenceProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    project.useEmbeddedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [],
    });

    await expect(
      project.writeConfiguration(new Uint8Array(), "[text]\nfont_size = 18\n"),
    ).rejects.toThrow("无法直接修改");
  });

  it("appends a compact packaged configuration update through a writable handle", async () => {
    const root = new SaveDirectoryHandle("storage");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    await (
      await (
        await cacheDirectory.getFileHandle("compiled-project.reracache", { create: true })
      ).createWritable()
    ).write(Uint8Array.of(9, 8, 7));
    const project = referenceProject(root as any, 1, "game");
    const handle = new SaveFileHandle("game.reraproj", new TextEncoder().encode("base-tail"));
    const file = await handle.getFile();
    const prepare = vi.fn(async () => {
      const result = new Uint8Array(8 + 7);
      new DataView(result.buffer).setBigUint64(0, 4n, true);
      result.set(new TextEncoder().encode("journal"), 8);
      return result;
    });
    project.usePackagedFile(file, handle as any, prepare);
    project.useEmbeddedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [],
    });

    await project.writeConfiguration(
      new Uint8Array(),
      "[text]\r\nreplace_full_width_spaces = true\r\n",
    );

    expect(project.configurationWritable()).toBe(true);
    expect(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())).toBe(
      "basejournal",
    );
    expect(prepare).toHaveBeenCalledOnce();
    await expect(cacheDirectory.getFileHandle("compiled-project.reracache")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(project.embeddedManifest()?.files).toContainEqual(
      expect.objectContaining({
        relative_path: "reraconfig.toml",
        payload: { type: "utf8", value: "[text]\nreplace_full_width_spaces = true\n" },
      }),
    );
  });

  it("keeps a packaged sidecar when the authoritative configuration update fails", async () => {
    const root = new SaveDirectoryHandle("storage");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    await (await cache.createWritable()).write(Uint8Array.of(9, 8, 7));
    const project = referenceProject(root as any, 1, "game");
    const handle = new SaveFileHandle("game.reraproj", new TextEncoder().encode("base-tail"));
    project.usePackagedFile(await handle.getFile(), handle as any, async () => {
      throw new Error("update rejected");
    });
    project.useEmbeddedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [],
    });

    await expect(
      project.writeConfiguration(new Uint8Array(), "[text]\nfont_size = 18\n"),
    ).rejects.toThrow("update rejected");
    await expect(project.readPersistedCompiledCache()).resolves.toEqual(Uint8Array.of(9, 8, 7));
  });

  it("reuses the selected packaged file without copying it into browser storage", async () => {
    const project = referenceProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([], "game.reraproj");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });

    project.usePackagedFile(file);

    const progress = vi.fn();
    await expect(project.readCompiledCache(progress)).resolves.toEqual(bytes);
    expect(progress.mock.calls.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
  });

  it("prefers a refreshed packaged-project sidecar over the embedded legacy cache", async () => {
    const root = new SaveDirectoryHandle("storage");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cacheHandle = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    const refreshed = Uint8Array.of(9, 8, 7);
    await (await cacheHandle.createWritable()).write(refreshed);
    const project = referenceProject(root as any, 1, "game");
    project.usePackagedFile(new File([Uint8Array.of(1, 2, 3, 4)], "game.reraproj"));

    await expect(project.readCompiledCache()).resolves.toEqual(refreshed);
  });

  it("serves resources embedded in a packaged project", async () => {
    const project = referenceProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    const resource = Uint8Array.of(1, 2, 3);
    project.useEmbeddedManifest({
      project_revision: 3,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "resources/a.png",
          category: "resource",
          payload: { type: "bytes", value: resource },
          content_hash: new Uint8Array(32),
        },
      ],
    });
    expect(resource.byteLength).toBe(0);
    resource[0] = 9;

    await expect(project.readResource("RESOURCES/A.PNG")).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(project.readResourcePrefix("resources/a.png", 2)).resolves.toEqual(
      Uint8Array.of(1, 2),
    );
  });

  it("reads worker-owned packaged resources on demand without retaining their payload", async () => {
    const project = referenceProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    const read = vi.fn(async (_path: string, maximum?: number) =>
      Uint8Array.of(4, 5, 6).slice(0, maximum),
    );
    project.useOwnedEmbeddedManifest(
      {
        project_revision: 3,
        compatibility: referenceCompatibility(),
        files: [
          {
            relative_path: "resources/a.png",
            category: "resource",
            payload: { type: "bytes", value: new Uint8Array() },
            content_hash: new Uint8Array(32),
          },
        ],
      },
      read,
    );

    await expect(project.readResourcePrefix("RESOURCES/A.PNG", 2)).resolves.toEqual(
      Uint8Array.of(4, 5),
    );
    await expect(project.readResource("resources/a.png")).resolves.toEqual(Uint8Array.of(4, 5, 6));
    expect(read.mock.calls).toEqual([["RESOURCES/A.PNG", 2], ["resources/a.png"]]);
  });

  it("resolves imported resources lazily without rescanning their payloads", async () => {
    const root = new SaveDirectoryHandle("storage");
    const resources = await root.getDirectoryHandle("resources", { create: true });
    const handle = await resources.getFileHandle("a.png", { create: true });
    const bytes = Uint8Array.of(4, 5, 6);
    await (await handle.createWritable()).write(bytes);
    const project = referenceProject(root as any, 1, "game");
    project.useImportedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "resources/a.png",
          category: "resource",
          payload: { type: "external", byteLength: bytes.byteLength },
          content_hash: blake3(bytes),
        },
      ],
    });

    await expect(project.readResourcePrefix("resources/a.png", 2)).resolves.toEqual(
      Uint8Array.of(4, 5),
    );
    await expect(project.readResource("resources/a.png")).resolves.toEqual(bytes);
    await (await handle.createWritable()).write(Uint8Array.of(7, 8, 9));
    await expect(project.readResource("resources/a.png")).rejects.toThrow("发生变化");
  });

  it("limits concurrency and reports failures in file order", async () => {
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 12 }, (_, index) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      if (index === 5 || index === 9) throw new Error(`failed-${index}`);
    });

    await expect(runBounded(tasks, 3)).rejects.toThrow("failed-5");
    expect(maximum).toBe(3);
  });

  it("reports completed task counts from the bounded file reader", async () => {
    const observed: Array<[number, number]> = [];
    const tasks = Array.from({ length: 4 }, () => async () => Promise.resolve());

    await runBounded(tasks, 2, (completed, total) => observed.push([completed, total]));

    expect(observed).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it("throttles fast provider batches while retaining genuine intermediate completions", async () => {
    const observed: Array<[number, number]> = [];
    const tasks = Array.from({ length: 40 }, () => async () => Promise.resolve());

    await runBounded(tasks, 4, (completed, total) => observed.push([completed, total]));

    expect(observed).toEqual([
      [8, 40],
      [16, 40],
      [24, 40],
      [32, 40],
      [40, 40],
    ]);
  });

  it("reports a slow provider completion before the eight-file batch threshold", () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const observed: Array<[number, number]> = [];
      const report = createProjectProgressReporter(40, (completed, total) =>
        observed.push([completed, total]),
      );

      now = 249;
      report(1);
      now = 250;
      report(2);

      expect(observed).toEqual([[2, 40]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops scheduling after cancellation and waits for started readers to clean up", async () => {
    const controller = new AbortController();
    const release = deferred<void>();
    const started: number[] = [];
    const cleaned: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, index) => async () => {
      started.push(index);
      try {
        await release.promise;
      } finally {
        cleaned.push(index);
      }
    });

    const reading = runBounded(tasks, 2, undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new DOMException("cancelled", "AbortError"));
    release.resolve();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toEqual([0, 1]);
    expect(cleaned).toEqual([0, 1]);
  });
});

describe("browser compiled cache identity", () => {
  it("keeps paths, categories, and hashes without cloning project payloads", () => {
    const hash = new Uint8Array(32).fill(7);
    const manifest = {
      project_revision: 7,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "ERB/main.erb",
          category: "erb",
          payload: { type: "utf8" as const, value: "@SYSTEM_TITLE\nRETURN" },
          content_hash: hash,
        },
      ],
    };

    expect(cacheIdentityManifest(manifest)).toEqual({
      project_revision: 7,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "ERB/main.erb",
          category: "erb",
          payload: { type: "utf8", value: "" },
          content_hash: hash,
        },
      ],
    });
  });

  it("releases submitted source text while retaining hot-reload identities", async () => {
    const root = new SaveDirectoryHandle("game");
    const oldSource = "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n";
    await writeFixtureFile(root, "main.erb", oldSource);
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    const imported = await project.scan();
    project.useImportedManifest(imported);

    project.releaseSubmittedSourcePayloads();

    expect(project.importedManifest()).toBeUndefined();
    expect(imported.files[0].payload).toEqual({ type: "utf8", value: "" });
    const materialized = await project.materialize();
    expect(materialized.project_revision).toBe(1);
    expect(materialized.files[0].payload).toEqual({ type: "utf8", value: oldSource });
    project.releaseSubmittedSourcePayloads();
    const unchanged = await project.reloadRequest({ type: "all" });
    expect(unchanged.changes).toEqual([]);
    project.finalizeReload(true);

    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");
    project.releaseSubmittedSourcePayloads();
    const changed = await project.reloadRequest({ type: "all" });
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0].file.payload.value).toContain("PRINTL NEW");
    project.finalizeReload(true);

    project.releaseSubmittedSourcePayloads();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL EXPORTED\nRETURN\n");
    const storage = new SaveDirectoryHandle("opfs");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    try {
      const spool = await project.stageFullManifest();
      const bytes = await spool.read(0, spool.totalBytes);
      expect(new TextDecoder().decode(bytes)).toContain("PRINTL EXPORTED");
      await spool.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("browser traditional saves", () => {
  it("treats a missing save namespace as an empty directory", async () => {
    const root = new SaveDirectoryHandle("project");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);

    const response = await project.storage({
      request_id: 5n,
      namespace: "save",
      relative_path: "",
      operation: { type: "list", pattern: "save*.sav", recursive: false },
    });

    expect(response.result).toEqual({ type: "listed", entries: [] });
    await expect(root.getDirectoryHandle("sav")).resolves.toBeDefined();
  });

  it("falls back to Emuera root reads while preserving private data overrides", async () => {
    const root = new SaveDirectoryHandle("project");
    const xml = await root.getDirectoryHandle("XML", { create: true });
    const source = await xml.getFileHandle("SKILL_LIFE.xml", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("<project />"));
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);

    const response = await project.storage({
      request_id: 6n,
      namespace: "data",
      relative_path: "XML/SKILL_LIFE.xml",
      operation: { type: "read" },
    });

    expect(response.result).toMatchObject({
      type: "read",
      data: [...new TextEncoder().encode("<project />")],
    });

    const listed = await project.storage({
      request_id: 7n,
      namespace: "data",
      relative_path: "XML",
      operation: { type: "list", pattern: "SKILL*.xml", recursive: false },
    });
    expect(listed.result).toMatchObject({
      type: "listed",
      entries: [{ relative_path: "XML/SKILL_LIFE.xml" }],
    });

    const data = await root.getDirectoryHandle("data", { create: true });
    const dataXml = await data.getDirectoryHandle("XML", { create: true });
    await writeFixtureFile(dataXml, "SKILL_LIFE.xml", "<override />");
    const overrideRead = await project.storage({
      request_id: 8n,
      namespace: "data",
      relative_path: "XML/SKILL_LIFE.xml",
      operation: { type: "read" },
    });
    expect(overrideRead.result).toMatchObject({
      type: "read",
      data: [...new TextEncoder().encode("<override />")],
    });

    const written = await project.storage({
      request_id: 9n,
      namespace: "data",
      relative_path: "XML/SKILL_LIFE.xml",
      operation: {
        type: "write",
        data: [...new TextEncoder().encode("<written />")],
        atomic_replace: true,
        precondition: { type: "any" },
      },
    });
    expect(written.result.type).toBe("written");
    expect(await (await source.getFile()).text()).toBe("<project />");
    expect(await (await (await dataXml.getFileHandle("SKILL_LIFE.xml")).getFile()).text()).toBe(
      "<written />",
    );
  });

  it("creates a missing save only after its write precondition passes", async () => {
    const root = new SaveDirectoryHandle("project");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);

    const response = await project.storage({
      request_id: 7n,
      namespace: "save",
      relative_path: "save00.sav",
      operation: {
        type: "write",
        data: BigUint64Array.from([0xefn, 0xbbn, 0xbfn, 0x34n, 0x32n]),
        atomic_replace: true,
        precondition: { type: "missing" },
      },
    });

    expect(response.result.type).toBe("written");
    expect(await project.readTraditionalSave(0)).toEqual(
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x34, 0x32),
    );
  });

  it("lists, writes, and reads numbered slots in the project sav directory", async () => {
    const root = new SaveDirectoryHandle("project");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);

    expect(await project.listTraditionalSaveSlots(3)).toEqual([
      { slot: 0, occupied: false },
      { slot: 1, occupied: false },
      { slot: 2, occupied: false },
    ]);

    await project.writeTraditionalSave(1, Uint8Array.of(4, 5, 6));

    expect(await project.listTraditionalSaveSlots(3)).toEqual([
      { slot: 0, occupied: false },
      { slot: 1, occupied: true },
      { slot: 2, occupied: false },
    ]);
    expect(await project.readTraditionalSave(1)).toEqual(Uint8Array.of(4, 5, 6));
    expect(saveSlotName(1)).toBe("save01.sav");
    expect(() => saveSlotName(100)).toThrow("存档槽位必须介于 00 和 99");
  });
});

it.each(["project", "data"])(
  "isolates every mutable read operation for snake %s",
  async (namespace) => {
    const root = new SaveDirectoryHandle("game");
    const shared = await root.getDirectoryHandle("shared", { create: true });
    await writeFixtureFile(shared, "sentinel.xml", "reference sentinel");
    const reference = referenceProject(root as unknown as FileSystemDirectoryHandle);
    reference.setCompatibility(referenceCompatibility());
    const snake = referenceProject(root as unknown as FileSystemDirectoryHandle);
    snake.setCompatibility(snakeCompatibility());
    await snake.scanQuick();
    for (const operation of [
      { type: "read" },
      { type: "stat" },
      { type: "read_range", offset: 0, maximum_bytes: 64 },
      { type: "list", recursive: false, pattern: "sentinel.xml" },
    ]) {
      const request = {
        request_id: 1,
        namespace,
        relative_path: operation.type === "list" ? "shared" : "shared/sentinel.xml",
        operation,
      };
      expect((await reference.storage(request)).result.type).not.toBe("error");
      const isolated = (await snake.storage(request)).result;
      if (namespace === "data" && operation.type === "list")
        expect(isolated).toEqual({ type: "listed", entries: [] });
      else expect(isolated.type).toBe("error");
    }
    const resource = await snake.storage({
      request_id: 2,
      namespace: "resource",
      relative_path: "shared/sentinel.xml",
      operation: { type: "read" },
    });
    expect(resource.result.data).toEqual([...new TextEncoder().encode("reference sentinel")]);
  },
);

it("does not bind mutable storage before compatibility resolution", async () => {
  const project = new BrowserProject(
    new SaveDirectoryHandle("game") as unknown as FileSystemDirectoryHandle,
  );
  await expect(project.dataRoot()).rejects.toThrow();
});

it("reuses the resolved snake data root across serial storage requests", async () => {
  const root = new SaveDirectoryHandle("game");
  const rootLookup = vi.spyOn(root, "getDirectoryHandle");
  const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
  project.setCompatibility(snakeCompatibility());

  const first = await project.dataRoot();
  const second = await project.dataRoot();

  expect(second).toBe(first);
  expect(rootLookup).toHaveBeenCalledTimes(1);
});
