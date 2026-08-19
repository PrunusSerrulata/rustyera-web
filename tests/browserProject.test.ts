import { describe, expect, it, vi } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";

import {
  BrowserProject,
  cacheIdentityManifest,
  decodeProtocolBytes,
  decodeProjectSource,
  normalizeResourceManifest,
  runBounded,
  saveSlotName,
  scanBrowserProjectFile,
} from "../src/platform/browserProject";
import {
  FailingIndexDirectoryHandle,
  SaveDirectoryHandle,
  SaveFileHandle,
  writeFixtureFile,
} from "./browserProjectTestSupport";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function manifestIdentityHex(manifest: {
  files: Array<{ relative_path: string; category: string; content_hash: Uint8Array }>;
}): string {
  const categoryCodes: Record<string, number> = {
    csv: 0,
    erh: 1,
    erb: 2,
    resource_manifest: 3,
    resource: 4,
    configuration: 5,
  };
  const encoder = new TextEncoder();
  const identity: number[] = [];
  for (const file of manifest.files) {
    const category = categoryCodes[file.category];
    if (category === undefined) throw new Error(`unknown test category ${file.category}`);
    const path = encoder.encode(file.relative_path);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(path.byteLength), true);
    identity.push(...length, ...path, category, ...file.content_hash);
  }
  return Array.from(
    blake3(Uint8Array.from(identity), {
      context: encoder.encode("rustyera.project-source-identity.v1"),
    }),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("browser project source decoding", () => {
  it("decodes UTF-8 and removes its byte order mark", () => {
    expect(
      decodeProjectSource(new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xbd, 0xa0]), "main.erb"),
    ).toBe("你");
  });

  it("normalizes Windows-31J source text", () => {
    const bytes = new Uint8Array([0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x31, 0x0a]);

    expect(decodeProjectSource(bytes, "GAMEBASE.csv")).toBe("コード,1\n");
  });

  it("normalizes GBK source text after Windows-31J rejects it", () => {
    const bytes = new Uint8Array([0x3b, 0xbd, 0xd7, 0xb2, 0xe3, 0x0a]);

    expect(decodeProjectSource(bytes, "main.erh")).toBe(";阶层\n");
  });

  it("reports source text invalid in every supported encoding", () => {
    expect(() => decodeProjectSource(new Uint8Array([0x81]), "main.erb")).toThrow(
      "main.erb 不是有效的 UTF-8、Windows-31J 或 GBK 文件",
    );
  });
});

describe("browser storage byte decoding", () => {
  it("accepts BigInt arrays projected by WASM", () => {
    expect(decodeProtocolBytes(BigUint64Array.from([0n, 127n, 255n]))).toEqual(
      Uint8Array.of(0, 127, 255),
    );
  });

  it("rejects values outside the byte range", () => {
    expect(() => decodeProtocolBytes(BigUint64Array.from([256n]))).toThrow("存储操作包含无效字节");
  });
});

describe("browser resource manifest normalization", () => {
  it("normalizes resource paths to NFC while preserving spacing and line endings", () => {
    expect(normalizeResourceManifest("FACE,  e\u0301.png  \r\nANIM,Anime\n")).toBe(
      "FACE,  é.png  \r\nANIM,Anime\n",
    );
  });
});

describe("browser project font resources", () => {
  it("packages supported files below the case-insensitive font directory", () => {
    for (const extension of ["ttf", "otf", "ttc", "woff", "woff2"]) {
      const bytes = new TextEncoder().encode(extension);
      expect(scanBrowserProjectFile(`FoNt/game.${extension}`, bytes, new Set())).toMatchObject({
        relative_path: `FoNt/game.${extension}`,
        category: "resource",
        payload: { type: "external", byteLength: bytes.byteLength },
      });
    }
    expect(scanBrowserProjectFile("font/license.txt", new Uint8Array(), new Set())).toBeUndefined();
  });

  it("materializes font resources for full project exports and page registration", async () => {
    const root = new SaveDirectoryHandle("game");
    const fonts = await root.getDirectoryHandle("font", { create: true });
    await writeFixtureFile(fonts, "Project.ttf", Uint8Array.of(1, 2, 3));
    const project = new BrowserProject(root as any);

    const manifest = await project.scanQuick();

    expect(manifest.files[0]).toMatchObject({
      relative_path: "font/Project.ttf",
      category: "resource",
    });
    const [font] = project.fontSources();
    expect(font).toMatchObject({
      relativePath: "font/Project.ttf",
      contentHash: blake3(Uint8Array.of(1, 2, 3)),
    });
    await expect(font?.read()).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(project.materialize()).resolves.toMatchObject({
      files: [{ payload: { type: "external", byteLength: 3 } }],
    });
  });
});

describe("browser project reads", () => {
  it("reuses a persistent stat index for warm project identity scans", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const source = await erb.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));

    const cold = await new BrowserProject(root as any, 1, "game", true).scanQuick();
    const warm = await new BrowserProject(root as any, 1, "game", true).scanQuick();

    expect(cold.files[0].payload).toEqual({ type: "utf8", value: "@MAIN\nRETURN\n" });
    expect(warm.files[0].payload).toEqual({ type: "utf8", value: "" });
    expect(warm.files[0].content_hash).toEqual(cold.files[0].content_hash);
  });

  it("migrates a native source index and preserves incremental reuse", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
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

    const migrated = new BrowserProject(root as any, 1, "game", true);
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
    const updated = new BrowserProject(root as any, 1, "game", true);
    await updated.scanQuick();
    const repeated = new BrowserProject(root as any, 1, "game", true);
    await repeated.scanQuick();

    expect(updated.sourceIndexStats()).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
    expect(repeated.sourceIndexStats()).toMatchObject({ reusedFiles: 1, hashedFiles: 0 });
  });

  it("never trusts size and mtime identities from a user-controlled directory", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@ONE\nRETURN\n"));
    const first = await new BrowserProject(root as any).scanQuick();
    source.replacePreservingMetadata(new TextEncoder().encode("@TWO\nRETURN\n"));

    const second = await new BrowserProject(root as any).scanQuick();

    expect(second.files[0].content_hash).not.toEqual(first.files[0].content_hash);
    expect(second.files[0].payload).toEqual({ type: "utf8", value: "@TWO\nRETURN\n" });
  });

  it("materializes a warm identity snapshot with its original directory classification", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const source = await erb.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
    const project = new BrowserProject(root as any, 1, "game", true);
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

    const manifest = await new BrowserProject(root as any).scanQuick();

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

    const project = new BrowserProject(root as any);
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
    const project = new BrowserProject(root as any, 1, "game", true);
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

    const manifest = await new BrowserProject(root as any, 1, "game", true).scanQuick();

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
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
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

    const warm = new BrowserProject(root as any, 1, "game", true);
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

    const manifest = await new BrowserProject(root as any, 1, "game", true).scanQuick();

    expect(manifest.files[0].payload).toEqual({ type: "utf8", value: "@MAIN\nRETURN\n" });
  });

  it("removes an old trusted index when an exact refresh cannot be written", async () => {
    const root = new SaveDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await new BrowserProject(root as any).scanQuick();
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

    await new BrowserProject(root as any).scanQuick();
    const trusted = new BrowserProject(root as any, 1, "game", true);
    await trusted.scanQuick();

    expect(trusted.sourceIndexStats()).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
  });

  it("refreshes trusted index entries after edits and deletions", async () => {
    const root = new SaveDirectoryHandle("game");
    const first = await root.getFileHandle("one.erb", { create: true });
    const second = await root.getFileHandle("two.erb", { create: true });
    await (await first.createWritable()).write(new TextEncoder().encode("@ONE\nRETURN\n"));
    await (await second.createWritable()).write(new TextEncoder().encode("@TWO\nRETURN\n"));
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
    await (await first.createWritable()).write(new TextEncoder().encode("@NEW\nRETURN\n"));
    await root.removeEntry("two.erb");

    const refreshed = await new BrowserProject(root as any, 1, "game", true).scanQuick();

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
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
    const project = new BrowserProject(root as any, 1, "game", true);
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
    await new BrowserProject(root as any, 1, "game", true).scanQuick();
    const project = new BrowserProject(root as any, 1, "game", true);

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

  it("reloads only the selected script folder and retains other changes for a later reload", async () => {
    const root = new SaveDirectoryHandle("game");
    const erb = await root.getDirectoryHandle("ERB", { create: true });
    const selected = await erb.getDirectoryHandle("selected", { create: true });
    const other = await erb.getDirectoryHandle("other", { create: true });
    await writeFixtureFile(selected, "command.erb", "@COM0\nPRINTL OLD\nRETURN 1\n");
    await writeFixtureFile(other, "command.erb", "@COM1\nPRINTL OLD\nRETURN 1\n");
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    project.markRuntimeManifestSparse();
    await project.prepareReloadBaseline();

    await writeFixtureFile(selected, "command.erb", "@COM0\nPRINTL SELECTED\nRETURN 1\n");
    await writeFixtureFile(other, "command.erb", "@COM1\nPRINTL OTHER\nRETURN 1\n");
    const selectedReload = await project.reloadRequest({
      type: "folder",
      path: "ERB/selected",
    });

    expect(selectedReload.changes).toHaveLength(2);
    expect(Array.isArray(selectedReload.changes[0].file.content_hash)).toBe(true);
    expect(
      selectedReload.changes.find(
        (change: any) => change.file.relative_path === "ERB/selected/command.erb",
      ).file.payload.value,
    ).toContain("PRINTL SELECTED");
    expect(
      selectedReload.changes.find(
        (change: any) => change.file.relative_path === "ERB/other/command.erb",
      ).file.payload.value,
    ).toContain("PRINTL OLD");
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
    const project = new BrowserProject(
      root as unknown as FileSystemDirectoryHandle,
      1,
      "game",
      true,
    );
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
    const repeated = new BrowserProject(
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");

    await project.reloadRequest({ type: "script", path: "main.erb" });
    project.finalizeReload(false);

    const active = await project.materialize();
    expect(active.project_revision).toBe(1);
    expect((active.files[0].payload as { value: string }).value).toContain("PRINTL OLD");
  });

  it("materializes every payload when fully reloading a cached project", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n");
    await writeFixtureFile(root, "other.erb", "@OTHER\nPRINTL OLD\nRETURN\n");
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    await project.scan();
    project.markRuntimeManifestSparse();
    await project.prepareReloadBaseline();
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n");

    const reload = await project.reloadRequest({ type: "all" });

    expect(reload.changes).toHaveLength(2);
    expect(reload.changes.every((change: any) => change.file.payload.value.length > 0)).toBe(true);
    expect(
      reload.changes.find((change: any) => change.file.relative_path === "other.erb").file.payload
        .value,
    ).toContain("PRINTL OLD");
    project.finalizeReload(true);
  });

  it("rejects an invalid reload scope before changing its revision or baseline", async () => {
    const root = new SaveDirectoryHandle("game");
    await writeFixtureFile(root, "main.erb", "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n");
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    project.useImportedManifest({ project_revision: 1, files: [] });
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    const originalDigest = blake3(new TextEncoder().encode(original));
    await project.writeConfiguration(originalDigest, upgraded);
    await project.writeConfiguration(originalDigest, upgraded);
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toBe(
      upgraded,
    );
  });

  it("keeps packaged configuration read-only without a writable file handle", async () => {
    const project = new BrowserProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    project.useEmbeddedManifest({ project_revision: 1, files: [] });

    await expect(
      project.writeConfiguration(new Uint8Array(), "[text]\nfont_size = 18\n"),
    ).rejects.toThrow("无法直接修改");
  });

  it("appends a compact packaged configuration update through a writable handle", async () => {
    const project = new BrowserProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    const handle = new SaveFileHandle("game.reraproj", new TextEncoder().encode("base-tail"));
    const file = await handle.getFile();
    const prepare = vi.fn(async () => {
      const result = new Uint8Array(8 + 7);
      new DataView(result.buffer).setBigUint64(0, 4n, true);
      result.set(new TextEncoder().encode("journal"), 8);
      return result;
    });
    project.usePackagedFile(file, handle as any, prepare);
    project.useEmbeddedManifest({ project_revision: 1, files: [] });

    await project.writeConfiguration(
      new Uint8Array(),
      "[text]\r\nreplace_full_width_spaces = true\r\n",
    );

    expect(project.configurationWritable()).toBe(true);
    expect(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())).toBe(
      "basejournal",
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(project.embeddedManifest()?.files).toContainEqual(
      expect.objectContaining({
        relative_path: "reraconfig.toml",
        payload: { type: "utf8", value: "[text]\nreplace_full_width_spaces = true\n" },
      }),
    );
  });

  it("reuses the selected packaged file without copying it into browser storage", async () => {
    const project = new BrowserProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([], "game.reraproj");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });

    project.usePackagedFile(file);

    const progress = vi.fn();
    await expect(project.readCompiledCache(progress)).resolves.toEqual(bytes);
    expect(progress.mock.calls.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
  });

  it("serves resources embedded in a packaged project", async () => {
    const project = new BrowserProject(new SaveDirectoryHandle("storage") as any, 1, "game");
    project.useEmbeddedManifest({
      project_revision: 3,
      files: [
        {
          relative_path: "resources/a.png",
          category: "resource",
          payload: { type: "bytes", value: Uint8Array.of(1, 2, 3) },
          content_hash: new Uint8Array(32),
        },
      ],
    });

    await expect(project.readResource("RESOURCES/A.PNG")).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(project.readResourcePrefix("resources/a.png", 2)).resolves.toEqual(
      Uint8Array.of(1, 2),
    );
  });

  it("resolves imported resources lazily without rescanning their payloads", async () => {
    const root = new SaveDirectoryHandle("storage");
    const resources = await root.getDirectoryHandle("resources", { create: true });
    const handle = await resources.getFileHandle("a.png", { create: true });
    const bytes = Uint8Array.of(4, 5, 6);
    await (await handle.createWritable()).write(bytes);
    const project = new BrowserProject(root as any, 1, "game");
    project.useImportedManifest({
      project_revision: 1,
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
});

describe("browser traditional saves", () => {
  it("treats a missing save namespace as an empty directory", async () => {
    const root = new SaveDirectoryHandle("project");
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);

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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);

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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);

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
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);

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
