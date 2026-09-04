import {
  SaveDirectoryHandle,
  blake3,
  cacheIdentityManifest,
  compatibilityCbor,
  decodeProjectSource,
  decodeProtocolBytes,
  decodeServicePayload,
  describe,
  encodeServicePayload,
  expect,
  it,
  normalizeResourceManifest,
  referenceCompatibility,
  referenceProject,
  scanBrowserProjectFile,
  snakeCompatibility,
  vi,
  writeFixtureFile,
} from "./browserProject.testHarness";

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
  it("spools many files in bounded writes without changing CBOR payloads or hashes", async () => {
    const root = new SaveDirectoryHandle("game");
    for (let index = 0; index < 1000; index += 1)
      await writeFixtureFile(root, `source-${index}.erb`, `;${"脚本".repeat(100)}\n`);
    const project = referenceProject(root as any);
    const manifest = await project.scan();
    const storage = new SaveDirectoryHandle("opfs");
    const originalGet = storage.getFileHandle.bind(storage);
    const sizes: number[] = [];
    vi.spyOn(storage, "getFileHandle").mockImplementation(async (...args) => {
      const handle = await originalGet(...args);
      const originalCreate = handle.createWritable.bind(handle);
      vi.spyOn(handle, "createWritable").mockImplementation(async (options) => {
        const writer = await originalCreate(options);
        const originalWrite = writer.write.bind(writer);
        writer.write = async (bytes) => {
          sizes.push(bytes.byteLength);
          // The producer must await consumption before reusing its buffer.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          await originalWrite(bytes);
        };
        return writer;
      });
      return handle;
    });
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    try {
      const spool = await project.stageFullManifest();
      const decoded = decodeServicePayload(await spool.read(0, spool.totalBytes)) as Map<
        number,
        any
      >;
      expect(decoded.get(0)).toBe(manifest.project_revision);
      expect(decoded.get(2)).toEqual(compatibilityCbor(manifest.compatibility));
      expect(decoded.get(1)).toHaveLength(manifest.files.length);
      for (const [index, file] of manifest.files.entries()) {
        if (file.payload.type !== "utf8") throw new Error("fixture must contain source text");
        const encoded = decoded.get(1)[index] as Map<number, any>;
        expect(encoded.get(0)).toBe(file.relative_path);
        expect(encoded.get(2)).toEqual([0, [file.payload.value]]);
        expect(encoded.get(3)).toEqual(file.content_hash);
      }
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.length).toBeLessThan(10);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(spool.totalBytes);
      await spool.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
