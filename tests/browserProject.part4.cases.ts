import {
  SaveDirectoryHandle,
  SaveFileHandle,
  blake3,
  deferred,
  describe,
  dispatchBrowserStorage,
  expect,
  it,
  manifestIdentityHex,
  referenceCompatibility,
  referenceProject,
  scanBrowserProjectFile,
  snakeCompatibility,
  storagePattern,
  storagePatternVectors,
  vi,
  writeFixtureFile,
} from "./browserProject.testHarness";

describe("manifest-authorized resource storage", () => {
  it("reads embedded resources without falling back to same-name project files", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "seed.xml", "outside");
    const project = referenceProject(root as any);
    const bytes = Uint8Array.from(new TextEncoder().encode("inside"));
    project.useOwnedEmbeddedManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "seed.xml",
          category: "resource",
          content_hash: blake3(bytes),
          payload: { type: "bytes", value: bytes },
        },
      ],
    });
    const request = {
      request_id: 1,
      namespace: "resource",
      relative_path: "seed.xml",
      operation: { type: "read" },
    };
    expect(project.embeddedManifest()?.files[0]?.payload).toEqual({
      type: "external",
      byteLength: bytes.byteLength,
    });
    expect((await project.storage(request)).result).toEqual({
      type: "read",
      data: [...bytes],
      revision: [...blake3(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""),
    });
    project.useOwnedEmbeddedManifest({
      project_revision: 2,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "seed.xml",
          category: "resource",
          content_hash: blake3(new TextEncoder().encode("outside")),
          payload: { type: "external", byteLength: 7 },
        },
      ],
    });
    expect((await project.storage(request)).result).toMatchObject({
      type: "error",
      error: { kind: "invalid_data" },
    });
  });
  it("rejects normalized resource collisions and recursive Data directory cycles", async () => {
    const root = new SaveDirectoryHandle("game");
    const project = referenceProject(root as any);
    const resource = {
      category: "resource",
      content_hash: blake3(Uint8Array.of(1)),
      payload: { type: "bytes" as const, value: Uint8Array.of(1) },
    };
    project.useImportedManifest({
      project_revision: 1,
      files: [
        { ...resource, relative_path: "é.xml" },
        { ...resource, relative_path: "e\u0301.xml" },
      ],
    });
    expect(
      (
        await project.storage({
          request_id: 1,
          namespace: "resource",
          relative_path: "",
          operation: { type: "list", recursive: true },
        })
      ).result,
    ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
    const data = await root.getDirectoryHandle("data", { create: true });
    vi.spyOn(data, "entries").mockImplementation(async function* () {
      yield ["loop", data] as [string, SaveDirectoryHandle];
    });
    expect(
      (
        await project.storage({
          request_id: 1,
          namespace: "data",
          relative_path: "",
          operation: { type: "list", recursive: true },
        })
      ).result,
    ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
  });
  it("does not authorize unselected resource changes during a scoped script reload", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@MAIN\nRETURN 1\n");
    await writeFixtureFile(root, "seed.xml", "old");
    const project = referenceProject(root as any);
    await project.scan();
    await writeFixtureFile(root, "main.erb", "@MAIN\nRETURN 2\n");
    await writeFixtureFile(root, "seed.xml", "new");
    await project.reloadRequest({ type: "script", path: "main.erb" });
    const request = {
      request_id: 1,
      namespace: "resource",
      relative_path: "seed.xml",
      operation: { type: "read" },
    };
    expect((await project.storage(request)).result).toMatchObject({
      type: "error",
      error: { kind: "conflict" },
    });
    project.finalizeReload(true);
    expect((await project.storage(request)).result).toMatchObject({
      type: "error",
      error: { kind: "conflict" },
    });
    await project.reloadRequest({ type: "all" });
    project.finalizeReload(true);
    expect((await project.storage(request)).result).toMatchObject({
      type: "read",
      data: [...new TextEncoder().encode("new")],
    });
  });
  it("reads, stats and enumerates committed resources separately from the Data overlay", async () => {
    const root = new SaveDirectoryHandle("game");
    const plugins = await root.getDirectoryHandle("plugins", { create: true });
    const nested = await plugins.getDirectoryHandle("nested", { create: true });
    await writeFixtureFile(plugins, "a.xml", "source");
    await writeFixtureFile(nested, "b.txt", "nested");
    await writeFixtureFile(root, "main.erb", "@MAIN\nRETURN\n");
    const project = referenceProject(root as any);
    project.setCompatibility(snakeCompatibility());
    await project.scanQuick();
    const call = async (relative_path: string, operation: any, namespace = "resource") =>
      (await project.storage({ request_id: 1, namespace, relative_path, operation })).result;
    await call(
      "plugins/a.xml",
      {
        type: "write",
        data: [...new TextEncoder().encode("overlay")],
        precondition: { type: "any" },
      },
      "data",
    );
    expect((await call("PLUGINS/a.xml", { type: "read" })).data).toEqual([
      ...new TextEncoder().encode("source"),
    ]);
    expect((await call("plugins/a.xml", { type: "read" }, "data")).data).toEqual([
      ...new TextEncoder().encode("overlay"),
    ]);
    const listed = await call("plugins", { type: "list", recursive: true, pattern: "*" });
    expect(listed.entries.map((entry: any) => entry.relative_path)).toEqual([
      "plugins/a.xml",
      "plugins/nested/b.txt",
    ]);
    expect(
      (await call("plugins", { type: "list", recursive: false, pattern: "*.xml" })).entries,
    ).toHaveLength(1);
    expect(await call("plugins/a.xml", { type: "stat" })).toMatchObject({
      type: "metadata",
      byte_length: 6,
    });
    expect(
      await call("plugins/a.xml", {
        type: "read_range",
        offset: 2,
        maximum_bytes: 3,
        change_token: listed.entries[0].change_token,
      }),
    ).toMatchObject({ type: "read_chunk", data: [117, 114, 99], complete: false });
    expect(
      await call("plugins/a.xml", {
        type: "read_range",
        offset: 0,
        maximum_bytes: 1,
        change_token: "old",
      }),
    ).toMatchObject({ type: "error", error: { kind: "conflict" } });
    expect(await call("main.erb", { type: "read" })).toMatchObject({
      type: "error",
      error: { kind: "permission_denied" },
    });
  });

  it("rejects Resource write/delete before creating any private or source directory", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "seed.xml", "seed");
    const project = referenceProject(root as any);
    project.setCompatibility(snakeCompatibility());
    for (const operation of [
      { type: "write", data: [1], precondition: { type: "any" } },
      { type: "delete", precondition: { type: "any" } },
    ]) {
      const result = await project.storage({
        request_id: 1,
        namespace: "resource",
        relative_path: "missing/sub/seed.xml",
        operation,
      });
      expect(result.result).toMatchObject({ type: "error", error: { kind: "read_only" } });
    }
    await expect(root.getDirectoryHandle("missing")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(root.getDirectoryHandle(".rustyera")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(await (await (await root.getFileHandle("seed.xml")).getFile()).text()).toBe("seed");
  });

  it.each(["read", "stat", "read_range", "list"])(
    "detects same-metadata mutations during %s",
    async (type) => {
      const root = new SaveDirectoryHandle("game");
      await writeFixtureFile(root, "seed.xml", "one");
      const project = referenceProject(root as any);
      await project.scanQuick();
      (await root.getFileHandle("seed.xml")).replacePreservingMetadata(
        new TextEncoder().encode("two"),
      );
      const result = await project.storage({
        request_id: 1,
        namespace: "resource",
        relative_path: type === "list" ? "" : "seed.xml",
        operation: { type, recursive: true, offset: 0, maximum_bytes: 1 },
      });
      expect(result.result).toMatchObject({ type: "error", error: { kind: "conflict" } });
    },
  );

  it("rejects invalid ranges and oversize full reads before opening the file", async () => {
    const root = new SaveDirectoryHandle("game");
    const project = referenceProject(root as any);
    project.useImportedManifest({
      project_revision: 1,
      files: [
        {
          relative_path: "large.xml",
          category: "resource",
          content_hash: blake3(Uint8Array.of(1)),
          payload: { type: "external", byteLength: 64 * 1024 * 1024 + 1 },
        },
      ],
    });
    const open = vi.spyOn(root, "getFileHandle");
    for (const operation of [
      { type: "read" },
      { type: "read_range", offset: -1, maximum_bytes: 1 },
      { type: "read_range", offset: 0, maximum_bytes: 4 * 1024 * 1024 + 1 },
    ]) {
      expect(
        (
          await project.storage({
            request_id: 1,
            namespace: "resource",
            relative_path: "large.xml",
            operation,
          })
        ).result,
      ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("does not accept an asynchronous read from a replaced project manifest", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "seed.xml", "seed");
    const project = referenceProject(root as any);
    const manifest = await project.scanQuick();
    const handle = await root.getFileHandle("seed.xml");
    const started = deferred<void>();
    const release = deferred<void>();
    const getFile = handle.getFile.bind(handle);
    vi.spyOn(handle, "getFile").mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return getFile();
    });
    const pending = project.storage({
      request_id: 1,
      namespace: "resource",
      relative_path: "seed.xml",
      operation: { type: "read" },
    });
    await started.promise;
    project.useImportedManifest({ ...manifest, project_revision: 2 });
    release.resolve();
    expect((await pending).result).toMatchObject({ type: "error", error: { kind: "conflict" } });
  });
});

describe("ALS and ERD project ingestion", () => {
  it.each(["names.als", "nested/names.ERD"])("requires UTF-8 for %s", (path) => {
    expect(() => scanBrowserProjectFile(path, Uint8Array.of(0x82, 0xa0), new Set())).toThrow(
      `${path} 不是有效的 UTF-8 文件`,
    );
    const text = "10,索引\r\n";
    const bytes = new TextEncoder().encode(`\uFEFF${text}`);
    const scanned = scanBrowserProjectFile(path, bytes, new Set());
    expect(scanned?.payload).toEqual({ type: "utf8", value: text });
    expect(scanned?.content_hash).toEqual(blake3(new TextEncoder().encode(text)));
    expect(scanned?.content_hash).not.toEqual(blake3(bytes));
  });

  it("keeps ALS/ERD categories through warm source-index reuse, hydration and scoped reload", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const nested = await erb.getDirectoryHandle("indices", { create: true });
    const csv = await root.getDirectoryHandle("CSV", { create: true });
    await writeFixtureFile(nested, "BUFF.erd", "10,主名\n");
    await writeFixtureFile(nested, "BUFF.als", "11,别名\n");
    await writeFixtureFile(csv, "TRAIN.als", "12,训练\n");
    const cold = await referenceProject(root as any, 1, "game", true).scanQuick();
    const project = referenceProject(root as any, 1, "game", true);
    const warm = await project.scanQuick();
    expect(warm.files.map((file) => file.category)).toEqual(["als", "als", "erd"]);
    expect(warm.files.map((file) => file.content_hash)).toEqual(
      cold.files.map((file) => file.content_hash),
    );
    expect(project.sourceIndexStats().reusedFiles).toBe(3);
    expect(warm.files.every((file) => file.payload.type === "utf8" && !file.payload.value)).toBe(
      true,
    );
    expect((await project.materialize()).files).toEqual(cold.files);
    expect((await project.projectReloadTargets()).scripts).toContain("ERB/indices/BUFF.erd");

    await writeFixtureFile(nested, "BUFF.als", "13,更新\n");
    await nested.removeEntry("BUFF.erd");
    await writeFixtureFile(nested, "MATRIX@2.erd", "10,新索引\n");
    const reload = await project.reloadRequest({ type: "folder", path: "ERB/indices" });
    expect(reload.changes).toHaveLength(3);
    expect(reload.changes).toContainEqual({
      type: "remove",
      relative_path: "ERB/indices/BUFF.erd",
      category: "erd",
    });
    project.finalizeReload(true);
    const updated = await project.materialize();
    expect(updated.files.map((file) => file.relative_path)).toEqual([
      "CSV/TRAIN.als",
      "ERB/indices/BUFF.als",
      "ERB/indices/MATRIX@2.erd",
    ]);
    expect(manifestIdentityHex(updated)).not.toBe(manifestIdentityHex(cold));
  });

  it("applies canonical roots without treating index data as executable source", () => {
    const roots = new Set(["csv", "erb"]);
    const bytes = new TextEncoder().encode("10,entry\n");
    for (const path of ["ERB/nested/name.erd", "ERB/nested/name.als", "CSV/TRAIN.als"])
      expect(scanBrowserProjectFile(path, bytes, roots)?.category).toBe(
        path.endsWith(".erd") ? "erd" : "als",
      );
    for (const path of ["loose.erd", "CSV/name.erd", "notes/name.als"])
      expect(scanBrowserProjectFile(path, bytes, roots)).toBeUndefined();
    expect(scanBrowserProjectFile("flat.als", bytes, new Set())?.category).toBe("als");
  });

  it("rejects normalized name collisions before a source-index entry can overwrite another", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "BUFF.erd", "10,one\n");
    await writeFixtureFile(root, "buff.erd", "11,two\n");
    await expect(referenceProject(root as any).scanQuick()).rejects.toThrow("项目路径归一化冲突");
  });
});

describe("read-only project data resource inventory", () => {
  it("retains raw XML/text/database bytes and hashes across cold, warm and full manifests", async () => {
    const root = new SaveDirectoryHandle("game");
    const plugins = await root.getDirectoryHandle("plugins", { create: true });
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0xff);
    for (const suffix of ["xml", "txt", "db", "sqlite", "dll"])
      await writeFixtureFile(plugins, `fixture.${suffix}`, bytes);
    const saves = await root.getDirectoryHandle("sav", { create: true });
    await writeFixtureFile(saves, "txt00.txt", "user save");
    const cold = await referenceProject(root as any, 1, "game", true).scanQuick();
    const project = referenceProject(root as any, 1, "game", true);
    const warm = await project.scanQuick();
    expect(warm.files).toEqual(cold.files);
    expect(warm.files.map((file) => file.relative_path)).toEqual([
      "plugins/fixture.db",
      "plugins/fixture.sqlite",
      "plugins/fixture.txt",
      "plugins/fixture.xml",
    ]);
    for (const file of warm.files) {
      expect(file).toMatchObject({
        category: "resource",
        payload: { type: "external", byteLength: bytes.byteLength },
      });
      expect(file.content_hash).toEqual(blake3(bytes));
      expect(await project.readResource(file.relative_path)).toEqual(bytes);
    }
    expect((await project.materialize()).files).toEqual(cold.files);
    const storage = new SaveDirectoryHandle("opfs");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    try {
      const full = await project.stageFullManifest();
      expect(full.totalBytes).toBeGreaterThan(bytes.length * 4);
      await full.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("snake Data normalized identity", () => {
  async function entryNames(directory: SaveDirectoryHandle): Promise<string[]> {
    const names: string[] = [];
    for await (const [name] of directory.entries()) names.push(name);
    return names;
  }

  async function dataProject() {
    const root = new SaveDirectoryHandle("game");
    const project = referenceProject(root as any);
    project.setCompatibility(snakeCompatibility());
    const data = (await (
      await project.dataRoot()
    ).getDirectoryHandle("data", { create: true })) as unknown as SaveDirectoryHandle;
    const call = async (relative_path: string, operation: any, namespace = "data") =>
      (await project.storage({ request_id: 1, namespace, relative_path, operation })).result;
    return { root, project, data, call };
  }

  it("uses the same identity for nested reads, metadata, list, updates and deletes without guessing Resource fallback", async () => {
    const { root, project, data, call } = await dataProject();
    const sourceDirectory = await (
      await root.getDirectoryHandle("plugins", { create: true })
    ).getDirectoryHandle("café", { create: true });
    await writeFixtureFile(sourceDirectory, "seed.txt", "source");
    await project.scanQuick();
    const actual = await (
      await data.getDirectoryHandle("PlUgIns", { create: true })
    ).getDirectoryHandle("Cafe\u0301", { create: true });
    await writeFixtureFile(actual, "SEED.TXT", "overlay");
    const handle = await actual.getFileHandle("SEED.TXT");
    const bytes = (text: string) => [...new TextEncoder().encode(text)];
    for (const path of ["plugins/CAFÉ/seed.txt", "PLUGINS/cafe\u0301/SEED.TXT"]) {
      expect(await call(path, { type: "read" })).toMatchObject({
        type: "read",
        data: bytes("overlay"),
      });
      expect(await call(path, { type: "stat" })).toMatchObject({
        type: "metadata",
        byte_length: 7,
      });
      expect(await call(path, { type: "read_range", offset: 1, maximum_bytes: 3 })).toMatchObject({
        type: "read_chunk",
        data: bytes("ver"),
      });
    }
    const listed = await call("pLuGiNs", { type: "list", recursive: true, pattern: "*" });
    expect(listed.entries.map((entry: any) => entry.relative_path)).toEqual([
      "PlUgIns/Café/SEED.TXT",
    ]);
    expect((await call(listed.entries[0].relative_path, { type: "read" })).data).toEqual(
      bytes("overlay"),
    );
    expect((await call("PLUGINS/café/seed.txt", { type: "read" }, "resource")).data).toEqual(
      bytes("source"),
    );
    expect(
      await call("plugins/CAFÉ/Seed.Txt", {
        type: "write",
        data: bytes("changed"),
        precondition: { type: "any" },
      }),
    ).toMatchObject({ type: "written" });
    expect(await actual.getFileHandle("SEED.TXT")).toBe(handle);
    expect(await (await handle.getFile()).text()).toBe("changed");
    expect(await entryNames(actual)).toEqual(["SEED.TXT"]);
    expect(
      await call("New/e\u0301.txt", {
        type: "write",
        data: bytes("new"),
        precondition: { type: "any" },
      }),
    ).toMatchObject({ type: "written" });
    const created = await data.getDirectoryHandle("New");
    expect(await entryNames(created)).toEqual(["é.txt"]);
    expect(await call("new/É.TXT", { type: "read" })).toMatchObject({
      type: "read",
      data: bytes("new"),
    });
    expect(
      await call("PLUGINS/café/seed.txt", { type: "delete", precondition: { type: "any" } }),
    ).toEqual({ type: "deleted" });
    expect(await call("plugins/café/seed.txt", { type: "read" })).toMatchObject({
      type: "error",
      error: { kind: "not_found" },
    });
    expect((await call("plugins/café/seed.txt", { type: "read" }, "resource")).data).toEqual(
      bytes("source"),
    );
  });

  it.each([
    ["seed.txt", "SEED.TXT"],
    ["é.txt", "e\u0301.txt"],
    ["İ.txt", "i\u0307.txt"],
  ])("rejects ambiguous sibling identities %s / %s before any mutation", async (first, second) => {
    const { data, call } = await dataProject();
    await writeFixtureFile(data, first, "first");
    await writeFixtureFile(data, second, "second");
    const before = await data.getFileHandle(first);
    const write = vi.spyOn(before, "createWritable");
    for (const operation of [
      { type: "read" },
      { type: "stat" },
      { type: "read_range", offset: 0, maximum_bytes: 1 },
      { type: "write", data: [1], precondition: { type: "any" } },
      { type: "delete", precondition: { type: "any" } },
      { type: "list", recursive: true },
    ]) {
      const path = operation.type === "list" ? "" : first;
      expect(await call(path, operation)).toMatchObject({
        type: "error",
        error: { kind: "invalid_data" },
      });
    }
    expect(
      await call("new/different.txt", { type: "write", data: [1], precondition: { type: "any" } }),
    ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
    expect(write).not.toHaveBeenCalled();
    expect(await (await before.getFile()).text()).toBe("first");
    await expect(data.getDirectoryHandle("new")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("keeps permission failures distinct and does not swallow delete metadata errors", async () => {
    const { data, call } = await dataProject();
    await writeFixtureFile(data, "Seed.TXT", "safe");
    const handle = await data.getFileHandle("Seed.TXT");
    const denied = new DOMException("denied", "NotAllowedError");
    const scan = vi.spyOn(data, "entries").mockImplementation(() => {
      throw denied;
    });
    expect(await call("seed.txt", { type: "read" })).toMatchObject({
      type: "error",
      error: { kind: "permission_denied" },
    });
    scan.mockRestore();
    const read = vi.spyOn(handle, "getFile").mockRejectedValue(denied);
    expect(await call("SEED.txt", { type: "delete", precondition: { type: "any" } })).toMatchObject(
      { type: "error", error: { kind: "permission_denied" } },
    );
    read.mockRestore();
    expect(await (await handle.getFile()).text()).toBe("safe");
  });

  it("rejects excessive paths, cyclic directory handles and paths outside the granted root", async () => {
    const { data, call } = await dataProject();
    for (const path of ["a".repeat(4097), Array(257).fill("a").join("/"), "bad\0name.txt"]) {
      expect(
        await call(path, { type: "write", data: [1], precondition: { type: "any" } }),
      ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
    }
    expect(await entryNames(data)).toEqual([]);
    (data as any).children.set("Loop", data);
    expect(await call("loop/a.txt", { type: "read" })).toMatchObject({
      type: "error",
      error: { kind: "invalid_data" },
    });
    (data as any).children.clear();
    await writeFixtureFile(data, "Outside.txt", "private");
    (data as any).resolve = async () => null;
    expect(await call("outside.TXT", { type: "read" })).toMatchObject({
      type: "error",
      error: { kind: "permission_denied" },
    });
    expect(await call("", { type: "list", recursive: true })).toMatchObject({
      type: "error",
      error: { kind: "permission_denied" },
    });
  });

  it("bounds complete parent scans before creating a missing target", async () => {
    const { data, call } = await dataProject();
    const handle = new SaveFileHandle("existing");
    const scan = vi.spyOn(data, "entries").mockImplementation(async function* () {
      for (let index = 0; index <= 100_000; index += 1)
        yield [`entry${index}`, handle] as [string, SaveFileHandle];
    });
    expect(
      await call("new.txt", { type: "write", data: [1], precondition: { type: "any" } }),
    ).toMatchObject({ type: "error", error: { kind: "invalid_data" } });
    scan.mockRestore();
    expect(await entryNames(data)).toEqual([]);
  });

  it("keeps the original profile and disabled root fallback independent of snake identity", async () => {
    const root = new SaveDirectoryHandle("game");
    const data = await root.getDirectoryHandle("data", { create: true });
    await writeFixtureFile(data, "Literal.TXT", "old");
    const reference = referenceProject(root as any);
    const operation = { type: "read" };
    expect(
      (
        await reference.storage({
          request_id: 1,
          namespace: "data",
          relative_path: "Literal.TXT",
          operation,
        })
      ).result.type,
    ).toBe("read");
    expect(
      (
        await reference.storage({
          request_id: 1,
          namespace: "data",
          relative_path: "literal.txt",
          operation,
        })
      ).result,
    ).toMatchObject({ type: "error", error: { kind: "not_found" } });
    await expect(
      dispatchBrowserStorage(root as any, "data", "literal.txt", operation, root as any, false),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await writeFixtureFile(data, "literal.txt", "separate");
    const written = await reference.storage({
      request_id: 1,
      namespace: "data",
      relative_path: "Literal.TXT",
      operation: { type: "write", data: [9], precondition: { type: "any" } },
    });
    expect(written.result.type).toBe("written");
    const listed = await reference.storage({
      request_id: 1,
      namespace: "data",
      relative_path: "",
      operation: { type: "list", recursive: true },
    });
    expect(listed.result.entries.map((entry: any) => entry.relative_path)).toEqual([
      "Literal.TXT",
      "literal.txt",
    ]);
  });
});

describe("bounded storage patterns and traversal error boundaries", () => {
  it("uses the shared snake scalar/NFC/Unicode-lowercase vectors", () => {
    for (const entry of storagePatternVectors.cases) {
      const match = () => storagePattern(entry.pattern, "emuera.skia.snake")(entry.name);
      if (entry.error)
        expect(match, entry.id).toThrowError(expect.objectContaining({ name: "DataError" }));
      else expect(match(), entry.id).toBe(entry.expected);
    }
  });

  it("keeps the original non-Unicode regex case, UTF-16 wildcard and endpoint rules", () => {
    for (const [pattern, name, expected] of [
      ["?.txt", "😀.txt", false],
      ["??.txt", "😀.txt", true],
      ["s", "ſ", false],
      ["k", "K", false],
      ["σ", "ς", true],
      ["ß", "ẞ", false],
      ["[ab]", "a", false],
      ["[ab]", "[ab]", true],
      ["é", "e\u0301", false],
      ["*a", "*ba", true],
      ["?a", "?a", true],
      ["", "anything", true],
      ["foo", "foo\n", false],
      ["*", "foo\n", false],
      ["*", "foo\r", false],
      ["*", "foo\u2028", false],
      ["*", "foo\u2029", false],
      ["*", "foo\r\n", false],
      ["foo\n", "foo\n", true],
      ["*\n", "foo\n", true],
      ["a*b", "a\nb", false],
    ] as const)
      expect(storagePattern(pattern, "emuera.em")(name), `${pattern}/${name}`).toBe(expected);
    expect(() => storagePattern(`*${"a".repeat(2000)}b`, "emuera.em")("a".repeat(4000))).toThrow(
      "工作限额",
    );
  });

  async function fixture(snake: boolean) {
    const root = new SaveDirectoryHandle("game");
    const project = referenceProject(root as any);
    if (snake) project.setCompatibility(snakeCompatibility());
    const data = (await (
      await project.dataRoot()
    ).getDirectoryHandle("data", { create: true })) as unknown as SaveDirectoryHandle;
    const list = async (path = "", pattern: string | null = null, namespace = "data") =>
      (
        await project.storage({
          request_id: 1,
          namespace,
          relative_path: path,
          operation: { type: "list", pattern, recursive: true },
        })
      ).result;
    return { root, project, data, list };
  }

  it("matches snake Data and manifest Resource with the same literal brackets, scalar and NFC rules", async () => {
    const { root, project, data, list } = await fixture(true);
    const names = ["SEED.TXT", "😀.txt", "e\u0301.txt", "[ab].txt", "a.txt"];
    for (const name of names) {
      await writeFixtureFile(root, name, "source");
      await writeFixtureFile(data, name, "overlay");
    }
    await project.scanQuick();
    for (const pattern of ["*.txt", "?.txt", "É.TXT", "[ab].txt", ""]) {
      const dataResult = await list("", pattern);
      const resources = await list("", pattern, "resource");
      expect(dataResult.type).toBe("listed");
      expect(resources.type).toBe("listed");
      expect(dataResult.entries.map((entry: any) => entry.relative_path)).toEqual(
        resources.entries.map((entry: any) => entry.relative_path),
      );
    }
  });

  it.each([false, true])(
    "does not turn an already enumerated missing file into empty success or root fallback (snake=%s)",
    async (snake) => {
      const { root, data, list } = await fixture(snake);
      await writeFixtureFile(root, "fallback.txt", "must not appear");
      await writeFixtureFile(data, "good.txt", "good");
      const disappearing = await data.getFileHandle("gone.txt", { create: true });
      vi.spyOn(disappearing, "getFile").mockRejectedValue(
        new DOMException("removed during scan", "NotFoundError"),
      );
      const result = await list();
      expect(result).toMatchObject({ type: "error", error: { kind: "conflict" } });
      expect(result.entries).toBeUndefined();
    },
  );

  it.each(["NotFoundError", "NotAllowedError"])(
    "preserves an error from inside an opened subdirectory: %s",
    async (name) => {
      const { data, list } = await fixture(true);
      await writeFixtureFile(data, "good.txt", "good");
      const nested = await data.getDirectoryHandle("nested", { create: true });
      const brokenEntries = nested.entries();
      vi.spyOn(brokenEntries, "next").mockRejectedValue(
        new DOMException("subdirectory failed", name),
      );
      vi.spyOn(nested, "entries").mockReturnValue(brokenEntries);
      const result = await list();
      expect(result).toMatchObject({
        type: "error",
        error: { kind: name === "NotFoundError" ? "conflict" : "permission_denied" },
      });
      expect(result.entries).toBeUndefined();
    },
  );

  it.each([false, true])(
    "validates real basenames before filtering at root and nested scopes (snake=%s)",
    async (snake) => {
      for (const name of ["bad\\name.txt", "C:seed.txt"]) {
        const { data, list } = await fixture(snake);
        const nested = await data.getDirectoryHandle("nested", { create: true });
        await writeFixtureFile(nested, name, "invalid");
        for (const path of ["", "nested"])
          expect(await list(path, "*.xml")).toMatchObject({
            type: "error",
            error: { kind: "invalid_data" },
          });
      }
    },
  );

  it("returns an existing alias handle's logical prefix, not its backing directory name", async () => {
    const { project, data, list } = await fixture(true);
    const real = new SaveDirectoryHandle("real");
    await writeFixtureFile(real, "A.txt", "alias contents");
    const alias = new SaveDirectoryHandle("AliAs");
    vi.spyOn(alias, "entries").mockImplementation(() => real.entries());
    vi.spyOn(alias, "getFileHandle").mockImplementation((name, options) =>
      real.getFileHandle(name, options),
    );
    vi.spyOn(data, "entries").mockImplementation(async function* () {
      yield ["AliAs", alias] as [string, SaveDirectoryHandle];
    });
    vi.spyOn(data, "getDirectoryHandle").mockImplementation(async (name) => {
      if (name === "AliAs") return alias;
      throw new DOMException("missing", "NotFoundError");
    });
    const result = await list("ALIAS");
    expect(result.entries.map((entry: any) => entry.relative_path)).toEqual(["AliAs/A.txt"]);
    const read = await project.storage({
      request_id: 2,
      namespace: "data",
      relative_path: result.entries[0].relative_path,
      operation: { type: "read" },
    });
    expect(read.result.data).toEqual([...new TextEncoder().encode("alias contents")]);
  });
});
