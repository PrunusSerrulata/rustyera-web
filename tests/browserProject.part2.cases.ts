import {
  FailingIndexDirectoryHandle,
  SaveDirectoryHandle,
  deferred,
  describe,
  expect,
  it,
  manifestIdentityHex,
  pngHeader,
  referenceCompatibility,
  referenceProject,
  vi,
  writeFixtureFile,
} from "./browserProject.testHarness";

describe("browser project reads", () => {
  it("pipelines Android Chromium file snapshots with content reads", async () => {
    vi.stubGlobal("navigator", {
      hardwareConcurrency: 4,
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 17; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
    });
    const root = new SaveDirectoryHandle("game");
    const handles = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const handle = await root.getFileHandle(`${index}.erb`, { create: true });
        await (
          await handle.createWritable()
        ).write(new TextEncoder().encode(`@TEST_${index}\nRETURN\n`));
        return handle;
      }),
    );
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    const fifthSnapshotStarted = deferred<void>();
    const releaseFifthSnapshot = deferred<void>();
    const firstGetFile = handles[0]!.getFile.bind(handles[0]);
    const fifthGetFile = handles[4]!.getFile.bind(handles[4]);
    vi.spyOn(handles[0]!, "getFile").mockImplementation(async () => {
      const file = await firstGetFile();
      return {
        ...file,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        arrayBuffer: async () => {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
          return file.arrayBuffer();
        },
      } as File;
    });
    vi.spyOn(handles[4]!, "getFile").mockImplementation(async () => {
      fifthSnapshotStarted.resolve();
      await releaseFifthSnapshot.promise;
      return fifthGetFile();
    });

    try {
      const scan = referenceProject(root as any).scanQuick();
      await Promise.all([firstReadStarted.promise, fifthSnapshotStarted.promise]);
      releaseFirstRead.resolve();
      releaseFifthSnapshot.resolve();
      expect((await scan).files).toHaveLength(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports enumeration before monotonic metadata and content work", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const source = await erb.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    const progress = vi.fn();

    await referenceProject(root as any).scanQuick(progress);

    expect(progress.mock.calls).toEqual([
      [0, 0],
      [2, 0],
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("reuses a persistent stat index for warm project identity scans", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const source = await erb.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));

    const coldProject = referenceProject(root as any, 1, "game", true);
    const cold = await coldProject.scanQuick();
    const warmProject = referenceProject(root as any, 1, "game", true);
    const warm = await warmProject.scanQuick();

    expect(cold.files[0].payload).toEqual({ type: "utf8", value: "@MAIN\nRETURN\n" });
    expect(warm.files[0].payload).toEqual({ type: "utf8", value: "" });
    expect(warm.files[0].content_hash).toEqual(cold.files[0].content_hash);
    expect(coldProject.quickManifestHasAllSources()).toBe(true);
    expect(warmProject.quickManifestHasAllSources()).toBe(false);
  });

  it("migrates a native source index and preserves incremental reuse", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    const privateDirectory = await root.getDirectoryHandle(".rustyera");
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
    const indexHandle = await cacheDirectory.getFileHandle("source-index-v1.json");
    const index = JSON.parse(await (await indexHandle.getFile()).text());
    const file = await source.getFile();
    index.version = 2;
    index.files["main.erb"].category = 2;
    index.files["main.erb"].signature = [file.size, file.lastModified * 1_000_000, 0, 0, 0];
    await (
      await indexHandle.createWritable()
    ).write(new TextEncoder().encode(JSON.stringify(index)));

    const migrated = referenceProject(root as any, 1, "game", true);
    await migrated.scanQuick();

    expect(migrated.sourceIndexStats()).toMatchObject({ reusedFiles: 1, hashedFiles: 0 });
    const canonical = JSON.parse(await (await indexHandle.getFile()).text());
    expect(canonical).toMatchObject({
      version: 3,
      files: { "main.erb": { category: 2, signature: `${file.size}:${file.lastModified}` } },
    });

    await (
      await source.createWritable()
    ).write(new TextEncoder().encode("@MAIN\nPRINTL CHANGED\nRETURN\n"));
    const updated = referenceProject(root as any, 1, "game", true);
    await updated.scanQuick();
    const repeated = referenceProject(root as any, 1, "game", true);
    await repeated.scanQuick();

    expect(updated.sourceIndexStats()).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
    expect(repeated.sourceIndexStats()).toMatchObject({ reusedFiles: 1, hashedFiles: 0 });
  });

  it("never trusts size and mtime identities from a user-controlled directory", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@ONE\nRETURN\n"));
    const first = await referenceProject(root as any).scanQuick();
    source.replacePreservingMetadata(new TextEncoder().encode("@TWO\nRETURN\n"));

    const second = await referenceProject(root as any).scanQuick();

    expect(second.files[0].content_hash).not.toEqual(first.files[0].content_hash);
    expect(second.files[0].payload).toEqual({ type: "utf8", value: "@TWO\nRETURN\n" });
  });

  it("materializes a warm identity snapshot with its original directory classification", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const source = await erb.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    const project = referenceProject(root as any, 1, "game", true);
    await project.scanQuick();

    const materialized = await project.materialize();

    expect(materialized.files).toHaveLength(1);
    expect(materialized.files[0]).toMatchObject({
      relative_path: "ERB/main.erb",
      category: "erb",
      payload: { type: "utf8", value: "@MAIN\nRETURN\n" },
    });
  });

  it("sorts project paths by portable lowercase code-point order", async () => {
    const root = new SaveDirectoryHandle("game");
    const accented = await root.getFileHandle("é.erb", { create: true });
    const ascii = await root.getFileHandle("z.erb", { create: true });
    await (await accented.createWritable()).write(new TextEncoder().encode("@ACCENTED\nRETURN\n"));
    await (await ascii.createWritable()).write(new TextEncoder().encode("@ASCII\nRETURN\n"));

    const manifest = await referenceProject(root as any).scanQuick();

    expect(manifest.files.map((file) => file.relative_path)).toEqual(["z.erb", "é.erb"]);
  });

  it("shares the fixed project-scan contract used by native frontends", async () => {
    const root = new SaveDirectoryHandle("game");
    const resources = await root.getDirectoryHandle("resources", { create: true });
    const sound = await root.getDirectoryHandle("sound", { create: true });
    const fonts = await root.getDirectoryHandle("font", { create: true });
    const nested = await root.getDirectoryHandle("sub", { create: true });
    const privateDirectory = await root.getDirectoryHandle(".RUSTYERA", { create: true });
    const privateCache = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const decomposed = "e\u0301.png";
    await writeFixtureFile(resources, decomposed, "png");
    await writeFixtureFile(
      resources,
      "sprites.csv",
      `FACE, \t${decomposed} \t\r\nANIME, \tAnImE\t \nNOTE,\u00a0${decomposed}\u00a0\rMETA,a\u0085b`,
    );
    await writeFixtureFile(sound, "theme.MP3", "audio");
    await writeFixtureFile(fonts, "Project.ttf", "font");
    await writeFixtureFile(sound, "ignored.erb", "@IGNORED");
    await writeFixtureFile(privateCache, "ignored.erb", "@PRIVATE");
    await writeFixtureFile(root, "reraconfig.toml", "[display]\nfont_size = 20\n");
    await writeFixtureFile(nested, "reraconfig.toml", Uint8Array.of(0x82, 0xa0, 0x0a));
    await writeFixtureFile(root, "é.erb", "@ACCENTED\nRETURN\n");
    await writeFixtureFile(root, "z.erb", "@ASCII\nRETURN\n");

    const project = referenceProject(root as any);
    const manifest = await project.scanQuick();
    const quickIdentity = manifestIdentityHex(manifest);

    expect(manifest.files.map((file) => [file.relative_path, file.category])).toEqual([
      ["font/Project.ttf", "resource"],
      ["reraconfig.toml", "configuration"],
      ["resources/sprites.csv", "resource_manifest"],
      ["resources/é.png", "resource"],
      ["sound/theme.MP3", "resource"],
      ["sub/reraconfig.toml", "configuration"],
      ["z.erb", "erb"],
      ["é.erb", "erb"],
    ]);
    expect(manifest.files[2].payload).toEqual({
      type: "utf8",
      value: "FACE, \té.png \t\r\nANIME, \tAnImE\t \nNOTE,\u00a0é.png\u00a0\rMETA,a\u0085b",
    });
    expect(manifest.files[5].payload).toEqual({ type: "utf8", value: "あ\n" });
    expect(quickIdentity).toBe("2554d3820c88d26cf3ddd33ba9896e9cc6397ce28669772cd0abd60539b2ae2b");
    expect(manifestIdentityHex(await project.materialize())).toBe(quickIdentity);
  });

  it("rescans instead of mixing a quick snapshot with added or changed files", async () => {
    const root = new SaveDirectoryHandle("game");
    const first = await root.getFileHandle("one.erb", { create: true });
    await (await first.createWritable()).write(new TextEncoder().encode("@ONE\nRETURN\n"));
    const project = referenceProject(root as any, 1, "game", true);
    await project.scanQuick();
    const second = await root.getFileHandle("two.erb", { create: true });
    await (await second.createWritable()).write(new TextEncoder().encode("@TWO\nRETURN\n"));

    const materialized = await project.materialize();

    expect(materialized.files.map((file) => file.relative_path)).toEqual(["one.erb", "two.erb"]);
    expect(
      materialized.files.every(
        (file) => file.payload.type !== "external" && file.payload.value.length > 0,
      ),
    ).toBe(true);
  });

  it("treats a corrupt source index as a disposable cold-scan cache", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const index = await cacheDirectory.getFileHandle("source-index-v1.json", { create: true });
    await (await index.createWritable()).write(new TextEncoder().encode("{broken"));

    const manifest = await referenceProject(root as any, 1, "game", true).scanQuick();

    expect(manifest.files[0].payload).toEqual({ type: "utf8", value: "@MAIN\nRETURN\n" });
  });

  it.each([
    { version: 1, metadata: undefined, label: "v1 without metadata" },
    {
      version: 2,
      metadata: { width: 0, height: 3, format: "invalid", animated: false },
      label: "malformed v2 metadata",
    },
  ])("migrates $label by reading only the cached image prefix", async ({ version, metadata }) => {
    const root = new SaveDirectoryHandle("game");
    const resources = await root.getDirectoryHandle("resources", { create: true });
    await writeFixtureFile(resources, "image.png", pngHeader(2, 3));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    const privateDirectory = await root.getDirectoryHandle(".rustyera");
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
    const indexHandle = await cacheDirectory.getFileHandle("source-index-v1.json");
    const index = JSON.parse(await (await indexHandle.getFile()).text());
    index.version = version;
    delete index.files["resources/image.png"].image_metadata;
    index.files["resources/image.png"].imageMetadata = metadata;
    await (
      await indexHandle.createWritable()
    ).write(new TextEncoder().encode(JSON.stringify(index)));

    const warm = referenceProject(root as any, 1, "game", true);
    const manifest = await warm.scanQuick();

    expect(warm.sourceIndexStats()).toMatchObject({ reusedFiles: 1, hashedFiles: 0 });
    expect(manifest.files[0].payload).toEqual({
      type: "external",
      byteLength: 24,
      imageMetadata: { width: 2, height: 3, format: "png", animated: false },
    });
    const migrated = JSON.parse(await (await indexHandle.getFile()).text());
    expect(migrated.version).toBe(3);
    expect(migrated.files["resources/image.png"].image_metadata).toEqual({
      width: 2,
      height: 3,
      format: "png",
      animated: false,
    });
    expect(migrated.files["resources/image.png"]).not.toHaveProperty("imageMetadata");
  });

  it("keeps startup functional when the disposable source index cannot be written", async () => {
    const root = new FailingIndexDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));

    const manifest = await referenceProject(root as any, 1, "game", true).scanQuick();

    expect(manifest.files[0].payload).toEqual({ type: "utf8", value: "@MAIN\nRETURN\n" });
  });

  it("removes an old trusted index when an exact refresh cannot be written", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await referenceProject(root as any).scanQuick();
    const privateDirectory = await root.getDirectoryHandle(".rustyera");
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
    const index = await cacheDirectory.getFileHandle("source-index-v1.json");
    index.createWritable = async () => ({
      write: async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      seek: async () => {},
      truncate: async () => {},
      close: async () => {},
      abort: async () => {},
    });

    await referenceProject(root as any).scanQuick();
    const trusted = referenceProject(root as any, 1, "game", true);
    await trusted.scanQuick();

    expect(trusted.sourceIndexStats()).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
  });

  it("refreshes trusted index entries after edits and deletions", async () => {
    const root = new SaveDirectoryHandle("game");
    const first = await root.getFileHandle("one.erb", { create: true });
    const second = await root.getFileHandle("two.erb", { create: true });
    await (await first.createWritable()).write(new TextEncoder().encode("@ONE\nRETURN\n"));
    await (await second.createWritable()).write(new TextEncoder().encode("@TWO\nRETURN\n"));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    await (await first.createWritable()).write(new TextEncoder().encode("@NEW\nRETURN\n"));
    await root.removeEntry("two.erb");

    const refreshed = await referenceProject(root as any, 1, "game", true).scanQuick();

    expect(refreshed.files).toHaveLength(1);
    expect(refreshed.files[0]).toMatchObject({
      relative_path: "one.erb",
      payload: { type: "utf8", value: "@NEW\nRETURN\n" },
    });
  });

  it("serves warm-indexed resources by normalized case-insensitive path", async () => {
    const root = new SaveDirectoryHandle("game");
    const resources = await root.getDirectoryHandle("resources", { create: true });
    const handle = await resources.getFileHandle("e\u0301.png", { create: true });
    await (await handle.createWritable()).write(Uint8Array.of(4, 5, 6));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    const project = referenceProject(root as any, 1, "game", true);
    const manifest = await project.scanQuick();

    expect(manifest.files[0].payload).toEqual({
      type: "external",
      byteLength: 3,
      imageMetadata: undefined,
    });
    await expect(project.readResource("RESOURCES/É.PNG")).resolves.toEqual(Uint8Array.of(4, 5, 6));
    await expect(project.readResourcePrefix("resources/é.png", 2)).resolves.toEqual(
      Uint8Array.of(4, 5),
    );
  });

  it("indexes Emuera sound-directory audio and serves it lazily", async () => {
    const root = new SaveDirectoryHandle("game");
    const storage = new SaveDirectoryHandle("opfs");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const sound = await root.getDirectoryHandle("sound", { create: true });
    const handle = await sound.getFileHandle("主题.mp3", { create: true });
    await (await handle.createWritable()).write(Uint8Array.of(4, 5, 6));
    await referenceProject(root as any, 1, "game", true).scanQuick();
    const project = referenceProject(root as any, 1, "game", true);

    const manifest = await project.scanQuick();

    expect(manifest.files).toMatchObject([
      {
        relative_path: "sound/主题.mp3",
        category: "resource",
        payload: { type: "external", byteLength: 3, imageMetadata: undefined },
      },
    ]);
    await expect(project.readResource("SOUND/主题.MP3")).resolves.toEqual(Uint8Array.of(4, 5, 6));
    const spool = await project.stageFullManifest();
    expect(spool.totalBytes).toBeGreaterThan(3);
    expect(await spool.read(0, spool.totalBytes)).toHaveLength(spool.totalBytes);
    await spool.release();
  });

  it("reloads only the selected script folder while the runtime retains complete sources", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const selected = await erb.getDirectoryHandle("selected", { create: true });
    const other = await erb.getDirectoryHandle("other", { create: true });
    await writeFixtureFile(selected, "command.erb", "@COM0\nPRINTL OLD\nRETURN 1\n");
    await writeFixtureFile(other, "command.erb", "@COM1\nPRINTL OLD\nRETURN 1\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();

    await writeFixtureFile(selected, "command.erb", "@COM0\nPRINTL SELECTED\nRETURN 1\n");
    await writeFixtureFile(other, "command.erb", "@COM1\nPRINTL OTHER\nRETURN 1\n");
    const selectedReload = await project.reloadRequest({
      type: "folder",
      path: "ERB/selected",
    });

    expect(selectedReload.changes).toHaveLength(1);
    expect(Array.isArray(selectedReload.changes[0].file.content_hash)).toBe(true);
    expect(
      selectedReload.changes.find(
        (change: any) => change.file.relative_path === "ERB/selected/command.erb",
      ).file.payload.value,
    ).toContain("PRINTL SELECTED");
    expect((await project.materialize()).project_revision).toBe(1);
    project.finalizeReload(true);
    const active = await project.materialize();
    expect(active.project_revision).toBe(2);
    expect(
      (
        active.files.find((file) => file.relative_path === "ERB/selected/command.erb")?.payload as {
          value: string;
        }
      ).value,
    ).toContain("PRINTL SELECTED");
    expect(
      (
        active.files.find((file) => file.relative_path === "ERB/other/command.erb")?.payload as {
          value: string;
        }
      ).value,
    ).toContain("PRINTL OLD");

    const remainingReload = await project.reloadRequest({
      type: "script",
      path: "ERB/other/command.erb",
    });
    expect(remainingReload.changes).toHaveLength(1);
    expect(remainingReload.changes[0].file.relative_path).toBe("ERB/other/command.erb");
    project.finalizeReload(true);
  });

  it("refreshes the portable source index after an incremental reload scan", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@MAIN\nPRINTL OLD\nRETURN\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle, 1, "game", true);
    await project.scanQuick();
    await writeFixtureFile(root, "main.erb", "@MAIN\nPRINTL UPDATED VALUE\nRETURN\n");

    await project.reloadRequest({ type: "script", path: "main.erb" });

    const cache = await (await root.getDirectoryHandle(".rustyera")).getDirectoryHandle("cache");
    const index = JSON.parse(
      await (await (await cache.getFileHandle("source-index-v1.json")).getFile()).text(),
    );
    const source = await (await root.getFileHandle("main.erb")).getFile();
    expect(index.version).toBe(3);
    expect(index.files["main.erb"].signature).toBe(`${source.size}:${source.lastModified}`);
    expect(index.files["main.erb"].size).toBe(source.size);
    const repeated = referenceProject(
      root as unknown as FileSystemDirectoryHandle,
      2,
      "game",
      true,
    );
    await repeated.scanQuick();
    expect(repeated.sourceIndexStats()).toMatchObject({ reusedFiles: 1, hashedFiles: 0 });
  });

  it("discards a rejected scoped reload without changing the active manifest", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");

    await project.reloadRequest({ type: "script", path: "main.erb" });
    project.finalizeReload(false);

    const active = await project.materialize();
    expect(active.project_revision).toBe(1);
    expect((active.files[0].payload as { value: string }).value).toContain("PRINTL OLD");
  });

  it("rebuilds a sparse runtime manifest with complete upserts and removals", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n");
    await writeFixtureFile(root, "other.erb", "@OTHER\nPRINTL OLD\nRETURN\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    const original = await project.scan();
    project.markRuntimeManifestSparse();
    project.releaseSubmittedSourcePayloads();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");
    await root.removeEntry("other.erb");

    const reload = await project.reloadRequest({ type: "script", path: "main.erb" });

    expect(reload.changes).toHaveLength(2);
    expect(reload.changes[0].type).toBe("upsert");
    expect(reload.changes[0].file.payload.value).toContain("PRINTL NEW");
    expect(reload.changes[1]).toMatchObject({
      type: "remove",
      category: "erb",
      relative_path: "other.erb",
    });
    project.finalizeReload(false);
    const rejected = (project as any).manifestValue;
    expect(rejected.project_revision).toBe(1);
    expect(manifestIdentityHex(rejected)).toBe(manifestIdentityHex(original));

    const accepted = await project.reloadRequest({ type: "all" });
    expect(accepted.base_revision).toBe(1);
    project.finalizeReload(true);
    project.markRuntimeManifestSparse();
    project.releaseSubmittedSourcePayloads();
    const compact = (project as any).manifestValue;
    expect(compact.project_revision).toBe(2);
    expect(compact.files).toHaveLength(1);
    expect(compact.files[0].payload).toEqual({ type: "utf8", value: "" });
  });

  it("rejects an invalid reload scope before changing its revision or baseline", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");

    await expect(project.reloadRequest({ type: "script", path: "../main.erb" })).rejects.toThrow(
      "项目目录内",
    );

    const reload = await project.reloadRequest({ type: "all" });
    expect(reload.base_revision).toBe(1);
    expect(reload.target_revision).toBe(2);
    expect(reload.changes).toHaveLength(1);
    expect(reload.changes[0].file.relative_path).toBe("main.erb");
    project.finalizeReload(true);
  });

  it("lists current and removed scripts as selectable reload targets", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const commands = await erb.getDirectoryHandle("commands", { create: true });
    await writeFixtureFile(commands, "hot.erb", "@COM0\nRETURN 1\n");
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    await commands.removeEntry("hot.erb");
    await writeFixtureFile(commands, "new.erh", "#DIM TEST\n");

    await expect(project.projectReloadTargets()).resolves.toEqual({
      folders: ["ERB/commands"],
      scripts: ["ERB/commands/hot.erb", "ERB/commands/new.erh"],
    });
  });

  it("atomically updates a root reraconfig.toml after checking its normalized digest", async () => {
    const root = new SaveDirectoryHandle("game");
    const handle = await root.getFileHandle("reraconfig.toml", { create: true });
    await (
      await handle.createWritable()
    ).write(new TextEncoder().encode("[display]\r\nfont_size = 12\r\n"));
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    project.useImportedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [],
    });
    const { blake3 } = await import("@noble/hashes/blake3.js");
    const digest = blake3(new TextEncoder().encode("[display]\nfont_size = 12\n"));

    await project.writeConfiguration(digest, "[display]\nfont_size = 18\n");

    expect(
      new TextDecoder().decode(new Uint8Array(await (await handle.getFile()).arrayBuffer())),
    ).toBe("[display]\nfont_size = 18\n");
    await expect(project.writeConfiguration(digest, "[display]\nfont_size = 20\n")).rejects.toThrow(
      "已被其他程序修改",
    );
  });

  it("invalidates the compact OPFS cache after a source configuration update", async () => {
    const root = new SaveDirectoryHandle("game");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    await (await cache.createWritable()).write(new TextEncoder().encode("base-tail"));
    const prepare = vi.fn();
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    project.useConfigurationUpdatePreparer(prepare);

    await project.writeConfiguration(
      new Uint8Array(),
      "[text]\nreplace_full_width_spaces = true\n",
    );

    expect(prepare).not.toHaveBeenCalled();
    await expect(cacheDirectory.getFileHandle("compiled-project.reracache")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      "[text]\nreplace_full_width_spaces = true\n",
    );
  });

  it("persists authoritative configuration when the cache planner rejects stale data", async () => {
    const root = new SaveDirectoryHandle("game");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    await (await cache.createWritable()).write(new TextEncoder().encode("stale-cache"));
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    project.useConfigurationUpdatePreparer(async () => {
      throw new Error("stale cache");
    });

    await expect(
      project.writeConfiguration(new Uint8Array(), "[audio]\nvolume = 42\n"),
    ).resolves.toBeUndefined();

    await expect(cacheDirectory.getFileHandle("compiled-project.reracache")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      "[audio]\nvolume = 42\n",
    );
  });

  it("persists authoritative configuration when the cache changes before append", async () => {
    const root = new SaveDirectoryHandle("game");
    const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", {
      create: true,
    });
    await (await cache.createWritable()).write(new TextEncoder().encode("base-tail"));
    const project = referenceProject(root as unknown as FileSystemDirectoryHandle);
    project.useConfigurationUpdatePreparer(async () => {
      cache.replacePreservingMetadata(new TextEncoder().encode("evil-tail"));
      const result = new Uint8Array(8 + 7);
      new DataView(result.buffer).setBigUint64(0, 4n, true);
      result.set(new TextEncoder().encode("journal"), 8);
      return result;
    });

    await project.writeConfiguration(new Uint8Array(), "[audio]\nvolume = 42\n");

    await expect(cacheDirectory.getFileHandle("compiled-project.reracache")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      "[audio]\nvolume = 42\n",
    );
  });
});
