import storagePatternVectors from "./fixtures/snake-storage-patterns.json";
import { storagePattern } from "@/platform/storagePattern";
import { referenceCompatibility, snakeCompatibility } from "./compatibilityTestSupport";
import { describe, expect, it, vi } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { compatibilityCbor } from "@/core/compatibility";
import { encodeServicePayload } from "@/core/serviceCodec";

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
import { dispatchBrowserStorage } from "@/platform/browserProjectStorage";
import { createProjectProgressReporter } from "@/platform/browserProjectUtilities";
import {
  FailingIndexDirectoryHandle,
  SaveDirectoryHandle,
  SaveFileHandle,
  writeFixtureFile,
} from "./browserProjectTestSupport";

function referenceProject(...args: ConstructorParameters<typeof BrowserProject>): BrowserProject {
  const project = new BrowserProject(...args);
  project.bindResolvedCompatibility(referenceCompatibility(), null);
  return project;
}

it("shares snake project saves while isolating runtime data and caches", async () => {
  const root = new SaveDirectoryHandle("game");
  const reference = referenceProject(root as unknown as FileSystemDirectoryHandle);
  reference.setCompatibility(referenceCompatibility());
  const snake = referenceProject(root as unknown as FileSystemDirectoryHandle);
  snake.setCompatibility(snakeCompatibility());
  await reference.writeTraditionalSave(0, Uint8Array.of(1));
  await expect(snake.readTraditionalSave(0)).resolves.toEqual(Uint8Array.of(1));
  await snake.writeTraditionalSave(0, Uint8Array.of(2));
  expect(await reference.readTraditionalSave(0)).toEqual(Uint8Array.of(2));
  expect(await snake.readTraditionalSave(0)).toEqual(Uint8Array.of(2));
  expect(await snake.cacheDirectory(true)).not.toBe(await reference.cacheDirectory(true));
  const snakeData = await snake.storage({
    request_id: 2,
    namespace: "data",
    relative_path: "state.db",
    operation: {
      type: "write",
      data: [3],
      atomic_replace: true,
      precondition: { type: "any" },
    },
  });
  expect(snakeData.result.type).toBe("written");
  await expect(root.getDirectoryHandle("data")).rejects.toMatchObject({ name: "NotFoundError" });
  const snakeLog = await snake.storage({
    request_id: 4,
    namespace: "log",
    relative_path: "runtime.log",
    operation: {
      type: "write",
      data: [4],
      atomic_replace: true,
      precondition: { type: "any" },
    },
  });
  expect(snakeLog.result.type).toBe("written");
  await expect(root.getDirectoryHandle("logs")).rejects.toMatchObject({ name: "NotFoundError" });
  const globalDirectory = await root.getDirectoryHandle("sav");
  await writeFixtureFile(globalDirectory, "global.sav", "standard global");
  const snakeGlobal = await snake.storage({
    request_id: 3,
    namespace: "global_save",
    relative_path: "global.sav",
    operation: { type: "read" },
  });
  expect(snakeGlobal.result.data).toEqual([...new TextEncoder().encode("standard global")]);
  await writeFixtureFile(root, "resource.txt", "shared");
  await snake.scanQuick();
  const response = await snake.storage({
    request_id: 1,
    namespace: "resource",
    relative_path: "resource.txt",
    operation: { type: "read" },
  });
  expect(response.result.data).toEqual([...new TextEncoder().encode("shared")]);
});

it("retains compatibility and root configuration when discarding submitted source payloads", () => {
  const manifest = {
    project_revision: 1,
    compatibility: snakeCompatibility(),
    files: [
      {
        relative_path: "reraconfig.toml",
        category: "configuration",
        payload: {
          type: "utf8" as const,
          value: '[compatibility]\nprofile = "emuera.skia.snake"\n',
        },
        content_hash: new Uint8Array(32),
      },
    ],
  };
  const lightweight = cacheIdentityManifest(manifest);
  expect(lightweight.compatibility).toEqual(snakeCompatibility());
  expect(lightweight.files[0].payload).toEqual(manifest.files[0].payload);
});

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
    als: 6,
    erd: 7,
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
    expect(scanBrowserProjectFile("font/license.txt", new Uint8Array(), new Set())).toMatchObject({
      relative_path: "font/license.txt",
      category: "resource",
      payload: { type: "external", byteLength: 0 },
    });
  });

  it("materializes font resources for full project exports and page registration", async () => {
    const root = new SaveDirectoryHandle("game");
    const fonts = await root.getDirectoryHandle("font", { create: true });
    await writeFixtureFile(fonts, "Project.ttf", Uint8Array.of(1, 2, 3));
    const project = referenceProject(root as any);

    const manifest = await project.scanQuick();

    expect(manifest.files[0]).toMatchObject({
      relative_path: "font/Project.ttf",
      category: "resource",
    });
    const [font] = project.fontSources();
    expect(font).toMatchObject({
      relativePath: "font/Project.ttf",
      contentHash: blake3(Uint8Array.of(1, 2, 3)),
      byteLength: 3,
    });
    await expect(font?.read()).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(project.materialize()).resolves.toMatchObject({
      files: [{ payload: { type: "external", byteLength: 3 } }],
    });

    // Portable directory imports retain the manifest hash, without the scanner's change token.
    project.useImportedManifest(manifest);
    const storage = new SaveDirectoryHandle("opfs");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const spool = await project.stageFullManifest();
    const encoded = await spool.read(0, spool.totalBytes);
    const compatibility = encodeServicePayload(compatibilityCbor(manifest.compatibility));
    expect(encoded.slice(-compatibility.length - 1)).toEqual(Uint8Array.of(2, ...compatibility));
    await spool.release();
    await writeFixtureFile(fonts, "Project.ttf", Uint8Array.of(3, 2, 1));
    await expect(project.stageFullManifest()).rejects.toThrow("资源在项目扫描后发生变化");
  });
});

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
