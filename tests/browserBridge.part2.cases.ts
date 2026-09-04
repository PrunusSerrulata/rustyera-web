import {
  BROWSER_FILE_SAVE_EVENT,
  BrowserBridge,
  BrowserProject,
  MemoryDirectoryHandle,
  afterEach,
  beforeEach,
  blake3,
  cleanupBrowserBridgeHarness,
  containsBytes,
  defaultPreferences,
  deferred,
  describe,
  diagnosisInput,
  directoryEntryNames,
  expect,
  flushMicrotasks,
  installCache,
  it,
  loadBrowserPreferences,
  overlayBrowserDirectory,
  pickBrowserDirectory,
  referenceCompatibility,
  requests,
  resetBrowserBridgeHarness,
  responseControl,
  snakeCompatibility,
  streamDiagnosisArchiveInWorker,
  vi,
} from "./browserBridge.testHarness";
import type { BrowserFileSaveRequest } from "./browserBridge.testHarness";

describe("browser startup bridge", () => {
  beforeEach(resetBrowserBridgeHarness);
  afterEach(cleanupBrowserBridgeHarness);

  it("cancels a failed constrained manifest stream and releases every partial payload", async () => {
    const root = new MemoryDirectoryHandle("game");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => new MemoryDirectoryHandle("storage") },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const manifest = {
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: ["one", "two"].map((name, index) => ({
        relative_path: `${name}.erb`,
        category: "erb",
        payload: { type: "utf8" as const, value: `@${name.toUpperCase()}\nRETURN\n` },
        content_hash: new Uint8Array(32).fill(index),
      })),
    };
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest,
    });
    let appended = 0;
    responseControl.respond = (method) => {
      if (method === "appendProjectManifestFile" && appended++ === 1)
        throw new Error("stream failed");
      return 1n;
    };

    await expect(new BrowserBridge().openProject()).rejects.toThrow("stream failed");

    expect(requests.map((request) => request.message.method)).toEqual([
      "beginProjectManifest",
      "appendProjectManifestFile",
      "appendProjectManifestFile",
      "cancelProjectManifest",
    ]);
    expect(manifest.files.map((file) => file.payload.value)).toEqual(["", ""]);
  });

  it("leaves constrained project ownership empty when replacement streaming fails", async () => {
    const oldRoot = new MemoryDirectoryHandle("old-game");
    const oldSource = await oldRoot.getFileHandle("old.erb", { create: true });
    const oldText = "@OLD\nPRINTL ACTIVE\nRETURN\n";
    await (await oldSource.createWritable()).write(new TextEncoder().encode(oldText));
    const newRoot = new MemoryDirectoryHandle("new-game");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => new MemoryDirectoryHandle("storage") },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    pickBrowserDirectory
      .mockResolvedValueOnce({
        handle: oldRoot,
        persistHandle: false,
        projectName: "old-game",
        manifest: {
          project_revision: 1,
          compatibility: referenceCompatibility(),
          files: [
            {
              relative_path: "old.erb",
              category: "erb",
              payload: { type: "utf8", value: oldText },
              content_hash: blake3(new TextEncoder().encode(oldText)),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        handle: newRoot,
        persistHandle: false,
        projectName: "new-game",
        manifest: {
          project_revision: 2,
          compatibility: referenceCompatibility(),
          files: ["one", "two"].map((name) => ({
            relative_path: `${name}.erb`,
            category: "erb",
            payload: { type: "utf8" as const, value: `@${name.toUpperCase()}\nRETURN\n` },
            content_hash: new Uint8Array(32),
          })),
        },
      });
    const bridge = new BrowserBridge();
    await bridge.openProject();
    let failReplacementFinish = true;
    responseControl.respond = (method) => {
      if (method === "finishProjectManifest" && failReplacementFinish) {
        failReplacementFinish = false;
        throw new Error("replacement failed");
      }
      return 1n;
    };

    await expect(bridge.openProject()).rejects.toThrow("replacement failed");
    responseControl.respond = () => 1n;
    await expect(bridge.restartProject()).rejects.toThrow("没有打开的项目");

    const submissions: string[] = [];
    let streamed = "";
    for (const request of requests) {
      if (request.message.method === "beginProjectManifest") streamed = "";
      if (request.message.method === "appendProjectManifestFile")
        streamed += new TextDecoder().decode(request.message.args[3] as Uint8Array);
      if (request.message.method === "finishProjectManifest") submissions.push(streamed);
    }
    expect(
      requests.filter((request) => request.message.method === "cancelProjectManifest"),
    ).toHaveLength(1);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toContain("PRINTL ACTIVE");
    expect(submissions[1]).toContain("@TWO");
    expect(bridge.projectName()).toBeUndefined();
  });

  it("uses explicit schema 4 metadata trust and reports actual source-index reuse", async () => {
    const root = new MemoryDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
    });
    vi.mocked(loadBrowserPreferences).mockResolvedValue({
      ...defaultPreferences(),
      trustProjectFileMetadata: true,
    });
    const bridge = new BrowserBridge();
    await bridge.loadPreferences();

    const cold = await bridge.openProject();
    const indexed = await bridge.openProject();

    expect(cold).toMatchObject({
      sourceIndexTrusted: true,
      sourceIndexReusedFiles: 0,
      sourceIndexHashedFiles: 1,
    });
    expect(indexed).toMatchObject({
      sourceIndexTrusted: true,
      sourceIndexReusedFiles: 1,
      sourceIndexHashedFiles: 0,
    });
  });

  it("performs an exact scan immediately after metadata trust is disabled", async () => {
    const root = new MemoryDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    pickBrowserDirectory.mockResolvedValue({ handle: root, persistHandle: false });
    const bridge = new BrowserBridge();
    await bridge.savePreferences({
      ...defaultPreferences(),
      trustProjectFileMetadata: true,
    });
    await bridge.openProject();

    await bridge.savePreferences(defaultPreferences());
    const exact = await bridge.openProject();

    expect(exact).toMatchObject({
      sourceIndexTrusted: false,
      sourceIndexReusedFiles: 0,
      sourceIndexHashedFiles: 1,
    });
  });

  it("submits a complete cold quick scan without a second directory stat pass", async () => {
    const root = new MemoryDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    pickBrowserDirectory.mockResolvedValue({ handle: root, persistHandle: false });

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));

    const metrics = await new BrowserBridge().openProject();

    expect(source.reads).toBe(1);
    expect(metrics?.quickScanMs).toBeGreaterThan(0);
    expect(requests.some((request) => request.message.method === "loadProjectBinary")).toBe(true);
  });

  it("keeps portable manifest resources authorized after a configuration write", async () => {
    const storage = new MemoryDirectoryHandle("game-storage");
    const contents = "<root>portable</root>";
    const bytes = new TextEncoder().encode(contents);
    const source = {
      name: "map.xml",
      size: bytes.byteLength,
      lastModified: 1,
      arrayBuffer: async () => bytes.buffer.slice(0),
      slice: (start = 0, end = bytes.byteLength) => {
        const chunk = bytes.slice(start, end);
        return { arrayBuffer: async () => chunk.buffer.slice(0) } as Blob;
      },
    } as File;
    const handle = overlayBrowserDirectory(storage as any, [
      { path: "plugins/map.xml", file: source },
    ]);
    pickBrowserDirectory.mockResolvedValue({
      handle,
      persistHandle: false,
      projectName: "game",
      manifest: {
        project_revision: 1,
        compatibility: snakeCompatibility(),
        files: [
          {
            relative_path: "plugins/map.xml",
            category: "resource",
            payload: { type: "external", byteLength: bytes.byteLength },
            content_hash: blake3(bytes),
          },
        ],
      },
    });
    responseControl.respond = (method) =>
      method === "resolveProjectCompatibility"
        ? {
            request_id: 0,
            identity: snakeCompatibility(),
            configuration_digest: null,
            diagnostics: [],
          }
        : 1n;
    const bridge = new BrowserBridge();

    await bridge.openProject();
    await bridge.writeProjectConfiguration(new Uint8Array(), "[meta]\nschema_version = 5\n");

    const read = await bridge.handleStorage({
      request_id: 1,
      namespace: "resource",
      relative_path: "plugins/map.xml",
      operation: { type: "read" },
    });
    expect(read, JSON.stringify(read)).toMatchObject({
      request_id: 1,
      result: { type: "read", data: [...bytes] },
    });
    await expect(
      bridge.handleStorage({
        request_id: 2,
        namespace: "resource",
        relative_path: "plugins",
        operation: { type: "list", recursive: true, pattern: "*.xml" },
      }),
    ).resolves.toMatchObject({
      request_id: 2,
      result: {
        type: "listed",
        entries: [expect.objectContaining({ relative_path: "plugins/map.xml" })],
      },
    });
  });

  it("falls back with one binary manifest transfer and retries its cache without rescanning", async () => {
    const root = new MemoryDirectoryHandle("game");
    await installCache(root, Uint8Array.of(9, 8, 7));
    const resourcePayload = { type: "bytes" as const, value: Uint8Array.of(1, 2, 3) };
    const secondResourcePayload = { type: "bytes" as const, value: Uint8Array.of(5, 6) };
    const manifest = {
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "main.erb",
          category: "erb",
          payload: { type: "utf8" as const, value: "@SYSTEM_TITLE\nRETURN\n" },
          content_hash: new Uint8Array(32),
        },
        {
          relative_path: "resources/title.png",
          category: "resource",
          payload: resourcePayload,
          content_hash: new Uint8Array(32).fill(4),
        },
        {
          relative_path: "resources/button.png",
          category: "resource",
          payload: secondResourcePayload,
          content_hash: new Uint8Array(32).fill(5),
        },
      ],
    };
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest,
    });
    let cacheAttempts = 0;
    responseControl.respond = (method) => {
      if (method === "loadProjectWithCompiledCacheBinary" && cacheAttempts++ === 0)
        throw new Error("stale cache");
      return 1n;
    };
    const scan = vi.spyOn(BrowserProject.prototype, "scan");
    const bridge = new BrowserBridge();

    await bridge.openProject();
    await bridge.restartProject();

    const fallback = requests.find((request) => request.message.method === "loadProjectBinary");
    const encoded = fallback?.message.args[0] as Uint8Array;
    expect(new TextDecoder().decode(encoded.subarray(0, 8))).toBe("RERMAN02");
    expect(new TextDecoder().decode(encoded)).toContain("@SYSTEM_TITLE\nRETURN\n");
    expect(containsBytes(encoded, resourcePayload.value)).toBe(true);
    expect(containsBytes(encoded, secondResourcePayload.value)).toBe(true);
    expect(fallback?.transfer).toHaveLength(1);
    expect(fallback?.transfer[0]).toBe(encoded.buffer);
    expect(
      requests.filter((request) => request.message.method === "loadProjectWithCompiledCacheBinary"),
    ).toHaveLength(2);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it("aborts an incomplete compiled-cache writer", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();

    await bridge.writeCompiledCacheChunk(Uint8Array.of(1, 2, 3), true, false);
    const cache = await (await root.getDirectoryHandle(".rustyera")).getDirectoryHandle("cache");
    const file = await cache.getFileHandle("compiled-project.reracache");
    await bridge.cancelCompiledCacheExport();

    expect(file.abort).toHaveBeenCalledOnce();
  });

  it("discards compiled-cache writes for a project using session storage", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      storagePersistent: false,
      projectName: "game",
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();

    await bridge.writeCompiledCacheChunk(Uint8Array.of(1, 2, 3), true, false);
    await bridge.writeCompiledCacheChunk(Uint8Array.of(4, 5, 6), false, true);

    await expect(root.getDirectoryHandle(".rustyera")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("reports diagnosis completion only after the browser writer closes", async () => {
    const closed = deferred<void>();
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(() => closed.promise),
      abort: vi.fn(async () => undefined),
    };
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => ({
        createWritable: vi.fn(async () => writer),
      })),
    );
    streamDiagnosisArchiveInWorker.mockImplementation(
      async (
        _input: unknown,
        write: (chunk: Uint8Array) => Promise<void>,
        progress?: (value: { completed: number; total: number }) => void,
      ) => {
        await write(Uint8Array.of(1));
        progress?.({ completed: 1, total: 2 });
        return 2;
      },
    );
    const progress = vi.fn();

    const saving = new BrowserBridge().saveDiagnosis(
      "diagnosis.tar.zst",
      diagnosisInput(),
      progress,
    );
    await flushMicrotasks();

    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 2 });
    expect(progress).not.toHaveBeenCalledWith({ completed: 2, total: 2 });
    closed.resolve();
    await expect(saving).resolves.toBe(true);
    expect(progress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
  });

  it("observes exported payload identities instead of compact source placeholders", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    const identity = {
      projectRevision: 1n,
      files: [
        {
          relativePath: "csv/GAMEBASE.CSV",
          category: "csv",
          contentHash: "a".repeat(64),
          payloadKind: "utf8",
          byteLength: 80n,
        },
      ],
    };
    responseControl.respond = (method) => {
      if (method !== "projectFileIdentity") throw new Error(`unexpected observation ${method}`);
      return identity;
    };
    streamDiagnosisArchiveInWorker.mockResolvedValue(20);
    const input = diagnosisInput();
    await expect(new BrowserBridge().saveDiagnosis("identity.tar.zst", input)).resolves.toBe(true);
    expect(window.__RUSTYERA_TEST_DOWNLOADS__?.at(-1)?.projectIdentity?.files[0]).toMatchObject({
      relativePath: "csv/GAMEBASE.CSV",
      byteLength: 80,
      contentHash: identity.files[0].contentHash,
    });
    expect(
      requests.find((row) => row.message.method === "projectFileIdentity")?.message.args[0],
    ).toEqual(input.projectFile);
  });

  it("falls back to download chunks when OPFS export initialization fails", async () => {
    const originalNavigator = globalThis.navigator;
    const originalUrl = globalThis.URL;
    class ExportUrl extends originalUrl {}
    Object.assign(ExportUrl, {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockRejectedValue(new Error("OPFS unavailable")) },
    });
    vi.stubGlobal("URL", ExportUrl);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const bridge = new BrowserBridge();
      await expect(bridge.beginProjectFileExport("game.reraproj")).resolves.toBe(true);
      await bridge.writeProjectFileChunk(Uint8Array.of(1, 2), true, false);
      await bridge.writeProjectFileChunk(Uint8Array.of(3), false, true);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
      vi.stubGlobal("navigator", originalNavigator);
      vi.stubGlobal("URL", originalUrl);
    }
  });

  it("rejects an oversized project export when no streaming sink is available", async () => {
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn().mockRejectedValue(new Error("OPFS unavailable")) },
    });
    const bridge = new BrowserBridge();
    await bridge.beginProjectFileExport("large.reraproj");
    const oversized = { byteLength: 64 * 1024 * 1024 + 1 } as Uint8Array;

    await expect(bridge.writeProjectFileChunk(oversized, true, false)).rejects.toThrow(
      "没有可用的流式文件写入能力",
    );
    await expect(bridge.writeProjectFileChunk(Uint8Array.of(1), false, true)).rejects.toThrow(
      "项目文件导出尚未开始",
    );
  });

  it("streams state-export chunks into a Blob without concatenating a second byte array", async () => {
    const originalUrl = globalThis.URL;
    let exported: Blob | undefined;
    class ExportUrl extends originalUrl {}
    Object.assign(ExportUrl, {
      createObjectURL: vi.fn((blob: Blob) => {
        exported = blob;
        return "blob:state";
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("URL", ExportUrl);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const bridge = new BrowserBridge();
      await expect(bridge.beginStateExport("state.snapshot", 3)).resolves.toBe(true);
      await bridge.writeStateExportChunk(Uint8Array.of(1, 2), true, false);
      await bridge.writeStateExportChunk(Uint8Array.of(3), false, true);

      expect(exported?.size).toBe(3);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
      vi.stubGlobal("URL", originalUrl);
    }
  });

  it("rejects an oversized state export before allocating fallback chunks", async () => {
    const bridge = new BrowserBridge();

    await expect(bridge.beginStateExport("huge.snapshot", 64 * 1024 * 1024 + 1)).rejects.toThrow(
      "64 MiB",
    );
    await expect(bridge.writeStateExportChunk(Uint8Array.of(1), true, false)).rejects.toThrow(
      "状态导出尚未开始",
    );
  });

  it("retains an OPFS project export until the iOS Firefox share request releases it", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone) FxiOS/151.0 Mobile/15E148 Safari/605.1.15",
      storage: { getDirectory: async () => storage },
      canShare: vi.fn(() => true),
      share: vi.fn(),
    });
    const secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    let request: BrowserFileSaveRequest | undefined;
    const receive = (event: Event) => {
      request = (event as CustomEvent<BrowserFileSaveRequest>).detail;
    };
    window.addEventListener(BROWSER_FILE_SAVE_EVENT, receive, { once: true });
    try {
      const bridge = new BrowserBridge();
      await bridge.beginProjectFileExport("game.reraproj");
      await bridge.writeProjectFileChunk(Uint8Array.of(1, 2, 3), true, true);

      expect(request?.file.name).toBe("game.reraproj");
      await expect(directoryEntryNames(storage)).resolves.toHaveLength(1);
      request?.release?.();
      await expect(directoryEntryNames(storage)).resolves.toHaveLength(0);
    } finally {
      if (secureContext) Object.defineProperty(window, "isSecureContext", secureContext);
      else Reflect.deleteProperty(window, "isSecureContext");
    }
  });

  it("propagates project export cancellation through the materialization abort signal", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();
    const materialize = vi.spyOn(BrowserProject.prototype, "stageFullManifest").mockImplementation(
      async (_progress, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    try {
      const staging = bridge.stageFullProjectManifest();
      await Promise.resolve();
      await bridge.cancelProjectFileExport();
      await expect(staging).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      materialize.mockRestore();
    }
  });

  it("cancels an active cache export before persisting authoritative configuration", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();
    await bridge.writeCompiledCacheChunk(Uint8Array.of(1, 2, 3), true, false);
    const cache = await (await root.getDirectoryHandle(".rustyera")).getDirectoryHandle("cache");
    const partial = await cache.getFileHandle("compiled-project.reracache");

    await bridge.writeProjectConfiguration(
      new Uint8Array(),
      "[text]\nreplace_full_width_spaces = true\n",
    );
    await bridge.writeCompiledCacheChunk(Uint8Array.of(4, 5, 6), false, true);

    expect(partial.abort).toHaveBeenCalledOnce();
    await expect(cache.getFileHandle("compiled-project.reracache")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(await (await (await root.getFileHandle("reraconfig.toml")).getFile()).text()).toContain(
      "replace_full_width_spaces = true",
    );
  });

  it("releases a manifest spool that finishes after export cancellation", async () => {
    pickBrowserDirectory.mockResolvedValue({
      handle: new MemoryDirectoryHandle("game"),
      persistHandle: false,
      projectName: "game",
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();
    let finishStaging!: (
      value: import("@/platform/browserProject").BrowserFullManifestSpool,
    ) => void;
    const release = vi.fn(async () => {});
    const entered = deferred<void>();
    const stagingSpy = vi
      .spyOn(BrowserProject.prototype, "stageFullManifest")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStaging = resolve;
            entered.resolve();
          }),
      );
    try {
      const staging = bridge.stageFullProjectManifest();
      const rejected = expect(staging).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      await bridge.cancelProjectFileExport();
      finishStaging({ totalBytes: 1, read: async () => Uint8Array.of(1), release });
      await rejected;
      expect(release).toHaveBeenCalledOnce();
      await expect(bridge.readFullProjectManifestChunk(0, 1)).rejects.toThrow("尚未暂存");
    } finally {
      stagingSpy.mockRestore();
    }
  });
});
