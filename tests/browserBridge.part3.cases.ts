import {
  BrowserBridge,
  MemoryDirectoryHandle,
  MemoryFileHandle,
  afterEach,
  beforeEach,
  blake3,
  cleanupBrowserBridgeHarness,
  deferred,
  describe,
  directoryEntryNames,
  expect,
  installCache,
  it,
  overlayBrowserDirectory,
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
  referenceCompatibility,
  requests,
  resetBrowserBridgeHarness,
  responseControl,
  snakeCompatibility,
  vi,
} from "./browserBridge.testHarness";

describe("browser startup bridge", () => {
  beforeEach(resetBrowserBridgeHarness);
  afterEach(cleanupBrowserBridgeHarness);

  it.each(
    (["write", "close", "getFile"] as const).flatMap((phase) =>
      [false, true].map((reject) => ({ phase, reject })),
    ),
  )(
    "does not publish a cancelled OPFS download after late $phase (reject=$reject)",
    async ({ phase, reject }) => {
      const storage = new MemoryDirectoryHandle("storage");
      vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
      const blocked = deferred<void>();
      const entered = deferred<void>();
      const originalCreate = MemoryFileHandle.prototype.createWritable;
      const create = vi
        .spyOn(MemoryFileHandle.prototype, "createWritable")
        .mockImplementation(async function (this: MemoryFileHandle, options) {
          const writer = await originalCreate.call(this, options);
          if (phase === "write") {
            const original = writer.write;
            writer.write = async (input) => {
              entered.resolve();
              await blocked.promise;
              return original(input);
            };
          } else if (phase === "close") {
            writer.close = async () => {
              entered.resolve();
              await blocked.promise;
            };
          }
          return writer;
        });
      const bridge = new BrowserBridge();
      try {
        await bridge.beginProjectFileExport("first.reraproj");
        if (phase === "getFile") {
          const [name] = await directoryEntryNames(storage);
          const handle = await storage.getFileHandle(name!);
          const original = handle.getFile.bind(handle);
          vi.spyOn(handle, "getFile").mockImplementationOnce(async () => {
            const file = await original();
            entered.resolve();
            await blocked.promise;
            return file;
          });
        }
        const write = bridge.writeProjectFileChunk(Uint8Array.of(1), true, true);
        await entered.promise;
        await bridge.cancelProjectFileExport();
        create.mockRestore();
        await bridge.beginProjectFileExport("replacement.reraproj");
        if (reject) {
          const rejection = expect(write).rejects.toThrow("writer aborted");
          blocked.reject(new Error("writer aborted"));
          await rejection;
        } else {
          blocked.resolve();
          await write;
        }
        // The replacement remains writable and owns its own completion lifecycle.
        await expect(
          bridge.writeProjectFileChunk(Uint8Array.of(2), true, false),
        ).resolves.toBeUndefined();
        await bridge.cancelProjectFileExport();
        expect(await directoryEntryNames(storage)).toEqual([]);
      } finally {
        create.mockRestore();
      }
    },
  );

  it("defers the fallback project-file OPFS copy until configuration is edited", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([bytes], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes")
        return {
          storageKey: "legacy-key",
          manifest: { project_revision: 3, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      if (method === "prepareProjectConfigurationUpdate") {
        const result = new Uint8Array(8 + 7);
        new DataView(result.buffer).setBigUint64(0, 4n, true);
        result.set(new TextEncoder().encode("journal"), 8);
        return result;
      }
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    const projectRoot = await (
      await storage.getDirectoryHandle(".rustyera-project-files")
    ).getDirectoryHandle("legacy-key");
    await expect(projectRoot.getFileHandle("project.reraproj")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(bridge.projectConfigurationWritable()).toBe(true);

    await bridge.writeProjectConfiguration(
      new Uint8Array(),
      "[text]\nreplace_full_width_spaces = true\n",
    );
    await bridge.restartProject();

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFileBytes",
      "prepareProjectConfigurationUpdate",
      "loadProjectFileBytes",
    ]);
    expect(requests[0].transfer).toEqual([(requests[0].message.args[0] as Uint8Array).buffer]);
    expect(requests[0].message.args[0]).toEqual(bytes);
    await expect(
      (await storage.getDirectoryHandle("project-preferences")).getDirectoryHandle("legacy-key"),
    ).resolves.toBeDefined();
    const copiedProject = await projectRoot.getFileHandle("project.reraproj");
    expect(new TextDecoder().decode(await (await copiedProject.getFile()).arrayBuffer())).toBe(
      "\u0001\u0002\u0003\u0004journal",
    );
    expect(bridge.projectConfigurationWritable()).toBe(true);
    await expect(projectRoot.getDirectoryHandle(".rustyera")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("keeps packaged snake saves in the persistent copy without writing the selected file", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const originalBytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([originalBytes], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    responseControl.respond = (method) => {
      if (method === "traditionalSaveSlotCount") return 2;
      if (method === "resolveProjectCompatibility")
        return {
          request_id: 0,
          identity: snakeCompatibility(),
          configuration_digest: null,
          diagnostics: [],
        };
      if (method === "projectFileManifest")
        return {
          project_revision: 3,
          compatibility: snakeCompatibility(),
          files: [],
        };
      if (method === "loadProjectFileBytes")
        return {
          storageKey: "packaged-snake",
          manifest: {
            project_revision: 3,
            compatibility: snakeCompatibility(),
            files: [],
          },
          cacheImported: true,
        };
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await bridge.traditionalSaves.writeSlot(0, Uint8Array.of(9, 8, 7));

    expect(file.size).toBe(originalBytes.byteLength);
    expect("createWritable" in file).toBe(false);
    const projectRoot = await (
      await storage.getDirectoryHandle(".rustyera-project-files")
    ).getDirectoryHandle("packaged-snake");
    const saved = await (await projectRoot.getDirectoryHandle("sav")).getFileHandle("save00.sav");
    expect(new Uint8Array(await (await saved.getFile()).arrayBuffer())).toEqual(
      Uint8Array.of(9, 8, 7),
    );
  });

  it("reuses a refreshed packaged-project cache and retains the embedded fallback", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([bytes], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    const storageKey = Array.from(blake3(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
    const projects = await storage.getDirectoryHandle(".rustyera-project-files", { create: true });
    const projectRoot = await projects.getDirectoryHandle(storageKey, { create: true });
    const refreshedCache = Uint8Array.of(9, 8, 7);
    await installCache(projectRoot, refreshedCache);
    responseControl.respond = (method) => {
      if (
        method === "loadProjectFileWithCompiledCacheBytes" ||
        method === "loadProjectFileSourceBytes"
      ) {
        return {
          storageKey,
          manifest: {
            project_revision: 3,
            compatibility: referenceCompatibility(),
            files: [
              {
                relative_path: "resources/a.bin",
                category: "resource",
                payload: {
                  type: "external_resource",
                  value: { byte_length: 3, image_metadata: null },
                },
                content_hash: new Uint8Array(32),
              },
            ],
          },
          cacheImported: method === "loadProjectFileWithCompiledCacheBytes",
        };
      }
      if (method === "readProjectFileResource") return Uint8Array.of(4, 5, 6);
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await bridge.submitProjectSource();
    await expect(bridge.readResource("resources/a.bin")).resolves.toEqual(Uint8Array.of(4, 5, 6));

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFileWithCompiledCacheBytes",
      "loadProjectFileSourceBytes",
      "readProjectFileResource",
    ]);
    expect(requests[0].message.args).toEqual([bytes, refreshedCache]);
    expect(requests[0].transfer).toEqual([
      (requests[0].message.args[0] as Uint8Array).buffer,
      (requests[0].message.args[1] as Uint8Array).buffer,
    ]);
  });

  it("opens the authoritative project file when its packaged sidecar cannot be staged", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([bytes], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    const storageKey = Array.from(blake3(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
    const projects = await storage.getDirectoryHandle(".rustyera-project-files", { create: true });
    const projectRoot = await projects.getDirectoryHandle(storageKey, { create: true });
    await installCache(projectRoot, Uint8Array.of(0xff));
    responseControl.respond = (method) => {
      if (method === "loadProjectFileWithCompiledCacheBytes") throw new Error("bad sidecar");
      if (method === "loadProjectFileBytes") {
        return {
          storageKey,
          manifest: { project_revision: 3, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      }
      return 1n;
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(new BrowserBridge().openProjectFile()).resolves.toMatchObject({
      cacheImported: true,
    });

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFileWithCompiledCacheBytes",
      "loadProjectFileBytes",
    ]);
  });

  it("loads a constrained packaged project without silently copying it", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => storage },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    responseControl.respond = (method) => {
      if (method === "readProjectFileResource") return Uint8Array.of(4, 5, 6);
      if (method === "loadProjectFile")
        return {
          storageKey: "ios-key",
          manifest: {
            project_revision: 3,
            compatibility: referenceCompatibility(),
            files: [
              {
                relative_path: "resources/a.bin",
                category: "resource",
                payload: {
                  type: "external_resource",
                  value: { byte_length: 3, image_metadata: null },
                },
                content_hash: new Uint8Array(32),
              },
            ],
          },
          cacheImported: true,
        };
      return 1n;
    };
    const bridge = new BrowserBridge();
    const progress = vi.fn();
    bridge.setProjectProgressListener(progress);
    expect(bridge.fullProjectExportSupported()).toBe(true);

    await expect(bridge.openProjectFile()).resolves.toMatchObject({ cacheImported: true });
    expect(bridge.fullProjectExportSupported()).toBe(false);
    await expect(bridge.readResource("resources/a.bin")).resolves.toEqual(Uint8Array.of(4, 5, 6));
    await expect(bridge.restartProject()).resolves.toMatchObject({ cacheImported: true });

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFile",
      "readProjectFileResource",
      "loadProjectFile",
    ]);
    expect(requests[0].message.args).toEqual([file, { chunkBytes: 1024 * 1024 }]);
    expect(requests[1].message.args).toEqual(["resources/a.bin", undefined]);
    expect(requests[2].message.args).toEqual([file, { chunkBytes: 1024 * 1024 }]);
    expect(requests.every((request) => request.transfer.length === 0)).toBe(true);
    expect(progress.mock.calls).toEqual([
      [{ stage: "scanning", completed: 0, total: file.size }],
      [{ stage: "scanning", completed: file.size, total: file.size }],
      [{ stage: "scanning", completed: 0, total: file.size }],
      [{ stage: "scanning", completed: file.size, total: file.size }],
    ]);
    const projectRoot = await (
      await storage.getDirectoryHandle(".rustyera-project-files")
    ).getDirectoryHandle("ios-key");
    await expect(projectRoot.getFileHandle("project.reraproj")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(
      (await storage.getDirectoryHandle("project-preferences")).getDirectoryHandle("ios-key"),
    ).resolves.toBeDefined();
    expect(bridge.projectConfigurationWritable()).toBe(false);
  });

  it.each(["missing", "rejected"] as const)(
    "opens a constrained packaged project when OPFS is $case and keeps volatile storage functional",
    async (storageCase) => {
      const getDirectory = vi
        .fn()
        .mockRejectedValue(new DOMException("OPFS unavailable", "UnknownError"));
      vi.stubGlobal("navigator", {
        ...(storageCase === "rejected" ? { storage: { getDirectory } } : {}),
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
      });
      const file = new File([Uint8Array.of(1, 2, 3, 4)], "game.reraproj");
      pickBrowserFile.mockResolvedValue(file);
      responseControl.respond = (method) => {
        if (method === "traditionalSaveSlotCount") return 2;
        if (method === "loadProjectFile")
          return {
            storageKey: "session-key",
            manifest: { project_revision: 3, compatibility: referenceCompatibility(), files: [] },
            cacheImported: true,
          };
        return 1n;
      };
      const bridge = new BrowserBridge();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(bridge.openProjectFile()).resolves.toMatchObject({ cacheImported: true });
      await expect(
        bridge.writeCompiledCacheChunk(Uint8Array.of(1, 2, 3), true, false),
      ).resolves.toBe(undefined);
      await expect(bridge.writeCompiledCacheChunk(Uint8Array.of(4, 5), false, true)).resolves.toBe(
        undefined,
      );
      await expect(bridge.restartProject()).resolves.toMatchObject({ cacheImported: true });

      const written = await bridge.handleStorage({
        request_id: 1n,
        namespace: "data",
        relative_path: "session.bin",
        operation: {
          type: "write",
          data: [7, 8, 9],
          atomic_replace: true,
          precondition: { type: "missing" },
        },
      });
      expect(written.result.type).toBe("written");
      await expect(
        bridge.handleStorage({
          request_id: 2n,
          namespace: "data",
          relative_path: "session.bin",
          operation: { type: "read" },
        }),
      ).resolves.toMatchObject({ result: { type: "read", data: [7, 8, 9] } });
      await expect(
        bridge.handleStorage({
          request_id: 3n,
          namespace: "data",
          operation: { type: "list", pattern: null, recursive: false },
        }),
      ).resolves.toMatchObject({
        result: { type: "listed", entries: [{ relative_path: "session.bin", byte_length: 3 }] },
      });
      await expect(
        bridge.handleStorage({
          request_id: 4n,
          namespace: "data",
          relative_path: "session.bin",
          operation: { type: "delete", precondition: { type: "any" } },
        }),
      ).resolves.toMatchObject({ result: { type: "deleted" } });
      await expect(
        bridge.handleStorage({
          request_id: 5n,
          namespace: "data",
          relative_path: "session.bin",
          operation: { type: "read" },
        }),
      ).resolves.toMatchObject({ result: { type: "error", error: { kind: "not_found" } } });

      vi.stubEnv("VITE_RUSTYERA_TEST", "1");
      window.__RUSTYERA_TEST_DOWNLOADS__ = [];
      await bridge.traditionalSaves.writeSlot(1, Uint8Array.of(4, 5, 6));
      await expect(bridge.traditionalSaves.listSlots()).resolves.toEqual([
        { slot: 0, occupied: false },
        { slot: 1, occupied: true },
      ]);
      await bridge.traditionalSaves.exportSlot(1);

      expect(bridge.projectPreferencesWritable()).toBe(true);
      await expect(
        bridge.saveProjectPreferences({ settings: { UseMouse: "NO" }, imageScale: 1.25 }),
      ).resolves.toEqual({ settings: { UseMouse: "NO" }, imageScale: 1.25 });
      expect(bridge.currentProjectPreferences()).toEqual({
        settings: { UseMouse: "NO" },
        imageScale: 1.25,
      });
      expect(bridge.projectConfigurationWritable()).toBe(false);
      expect(window.__RUSTYERA_TEST_DOWNLOADS__).toEqual([
        { name: "save01.sav", bytes: Uint8Array.of(4, 5, 6) },
      ]);
      expect(requests.map((request) => request.message.method)).toEqual([
        "loadProjectFile",
        "loadProjectFile",
        "traditionalSaveSlotCount",
      ]);
      if (storageCase === "rejected") expect(getDirectory).toHaveBeenCalledOnce();
    },
  );

  it("routes a writable packaged configuration through the WASM update planner", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const handle = new MemoryFileHandle("game.reraproj", new TextEncoder().encode("base-tail"));
    const file = await handle.getFile();
    pickBrowserProjectFile.mockResolvedValue({ file, handle });
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes")
        return {
          storageKey: "writable-key",
          manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      if (method === "prepareProjectConfigurationUpdate") {
        const result = new Uint8Array(8 + 7);
        new DataView(result.buffer).setBigUint64(0, 4n, true);
        result.set(new TextEncoder().encode("journal"), 8);
        return result;
      }
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await bridge.writeProjectConfiguration(
      new Uint8Array(),
      "[text]\nreplace_full_width_spaces = true\n",
    );

    expect(bridge.projectConfigurationWritable()).toBe(true);
    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFileBytes",
      "prepareProjectConfigurationUpdate",
    ]);
    expect(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())).toBe(
      "basejournal",
    );
  });

  it("submits and prepares a selected project file before reporting read progress", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const file = new File([Uint8Array.of(1, 2, 3)], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes")
        return {
          storageKey: "selected-key",
          manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      return 1n;
    };
    const submitted = vi.fn();
    const progress = vi.fn();
    const prepareAfterSelection = vi.fn(async () => {
      expect(submitted).toHaveBeenCalledOnce();
      expect(progress).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    });
    const bridge = new BrowserBridge();
    bridge.setProjectProgressListener(progress);

    await bridge.openProjectFile(submitted, prepareAfterSelection);

    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(
      prepareAfterSelection.mock.invocationCallOrder[0],
    );
    expect(progress).toHaveBeenNthCalledWith(1, {
      stage: "scanning",
      completed: 0,
      total: file.size,
    });
    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFileBytes"]);
  });

  it("does not read a selected project file when session preparation fails", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "game.reraproj");
    const slice = vi.spyOn(file, "slice");
    pickBrowserFile.mockResolvedValue(file);

    await expect(
      new BrowserBridge().openProjectFile(undefined, async () => {
        throw new Error("session failed");
      }),
    ).rejects.toThrow("session failed");

    expect(slice).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it.each([
    {
      browser: "macOS Chromium",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      maxTouchPoints: 0,
    },
    {
      browser: "macOS Firefox with overridden touch points",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
      maxTouchPoints: 5,
    },
    {
      browser: "macOS Safari",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      maxTouchPoints: 0,
    },
  ])(
    "keeps $browser on the desktop read path without an OPFS project-file copy",
    async ({ userAgent, maxTouchPoints }) => {
      const storage = new MemoryDirectoryHandle("storage");
      vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => storage },
        userAgent,
        platform: "MacIntel",
        maxTouchPoints,
      });
      const bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
      const file = new File([bytes], "large.reraproj");
      const wholeFileRead = vi.fn(async () => bytes.buffer.slice(0));
      Object.defineProperty(file, "arrayBuffer", { value: wholeFileRead });
      Object.defineProperty(file, "slice", {
        value: (start: number, end: number) => ({
          arrayBuffer: async () => bytes.buffer.slice(start, end),
        }),
      });
      pickBrowserFile.mockResolvedValue(file);
      responseControl.respond = (method) => {
        if (method === "loadProjectFileBytes")
          return {
            storageKey: "large-key",
            manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
            cacheImported: true,
          };
        return 1n;
      };
      const progress = vi.fn();
      const bridge = new BrowserBridge();
      bridge.setProjectProgressListener(progress);

      expect(bridge.prewarmRuntimeOnInitialize).toBe(true);

      await bridge.openProjectFile();

      expect(progress.mock.calls).toEqual([
        [{ stage: "scanning", completed: 0, total: bytes.byteLength }],
        [{ stage: "scanning", completed: 4 * 1024 * 1024, total: bytes.byteLength }],
        [{ stage: "scanning", completed: bytes.byteLength, total: bytes.byteLength }],
        [{ stage: "loading_cache", completed: 0, total: 0 }],
        [{ stage: "loading_cache", completed: 1, total: 1 }],
      ]);
      expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFileBytes"]);
      const transferred = requests[0].message.args[0] as Uint8Array;
      expect(transferred.byteLength).toBe(bytes.byteLength);
      expect(transferred[0]).toBe(7);
      expect(transferred.at(-1)).toBe(7);
      expect(requests[0].transfer).toEqual([transferred.buffer]);
      expect(wholeFileRead).not.toHaveBeenCalled();
      const projectRoot = await (
        await storage.getDirectoryHandle(".rustyera-project-files")
      ).getDirectoryHandle("large-key");
      await expect(projectRoot.getFileHandle("project.reraproj")).rejects.toMatchObject({
        name: "NotFoundError",
      });
    },
  );

  it("preserves a worker-side project read error", async () => {
    const file = new File([Uint8Array.of(1)], "broken.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes") throw new Error("project blob read failed");
      return undefined;
    };

    await expect(new BrowserBridge().openProjectFile()).rejects.toThrow("project blob read failed");

    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFileBytes"]);
  });
});

describe("browser startup bridge", () => {
  beforeEach(resetBrowserBridgeHarness);
  afterEach(cleanupBrowserBridgeHarness);

  it("preserves a worker load error and allows the next upload", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const failed = new File([new Uint8Array(5 * 1024 * 1024)], "failed.reraproj");
    const retry = new File([Uint8Array.of(1, 2, 3)], "retry.reraproj");
    pickBrowserFile.mockResolvedValueOnce(failed).mockResolvedValueOnce(retry);
    let loadCalls = 0;
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes" && loadCalls++ === 0)
        throw new Error("project chunk read failed");
      if (method === "loadProjectFileBytes") {
        return {
          storageKey: "retry-key",
          manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      }
      return undefined;
    };
    const bridge = new BrowserBridge();

    await expect(bridge.openProjectFile()).rejects.toThrow("project chunk read failed");
    await expect(bridge.openProjectFile()).resolves.toMatchObject({ cacheImported: true });

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFileBytes",
      "loadProjectFileBytes",
    ]);
  });

  it("rejects an oversized desktop project file before allocating or contacting the Worker", async () => {
    const file = new File([], "oversized.reraproj");
    Object.defineProperty(file, "size", { value: 0x1_0000_0000 });
    pickBrowserFile.mockResolvedValue(file);

    await expect(new BrowserBridge().openProjectFile()).rejects.toThrow(
      "项目文件大小超出浏览器可处理范围。",
    );
    expect(requests).toEqual([]);
  });

  it("retires the active packaged project when replacement validation fails", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const active = new File([Uint8Array.of(1)], "active.reraproj");
    const broken = new File([Uint8Array.of(2)], "broken.reraproj");
    Object.defineProperty(active, "arrayBuffer", {
      value: async () => Uint8Array.of(1).buffer,
    });
    Object.defineProperty(broken, "arrayBuffer", {
      value: async () => Uint8Array.of(2).buffer,
    });
    pickBrowserFile.mockResolvedValueOnce(active).mockResolvedValueOnce(broken);
    let attempts = 0;
    responseControl.respond = (method) => {
      if (method !== "loadProjectFileBytes") return 1n;
      if (attempts++ > 0) throw new Error("invalid project file");
      return {
        storageKey: "active-key",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        cacheImported: true,
      };
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await expect(bridge.openProjectFile()).rejects.toThrow("invalid project file");

    expect(bridge.projectName()).toBeUndefined();
    expect(requests.at(-1)?.message.method).toBe("loadProjectFileBytes");
  });

  it("retires the active portable project when replacement submission fails", async () => {
    const active = new MemoryDirectoryHandle("active-storage");
    const broken = new MemoryDirectoryHandle("broken-storage");
    const manifest = { project_revision: 1, compatibility: referenceCompatibility(), files: [] };
    pickBrowserDirectory
      .mockResolvedValueOnce({
        handle: active,
        persistHandle: false,
        projectName: "active",
        manifest,
      })
      .mockResolvedValueOnce({
        handle: broken,
        persistHandle: false,
        projectName: "broken",
        manifest,
      });
    let submissions = 0;
    responseControl.respond = (method) => {
      if (method === "loadProjectBinary" && submissions++ > 0) {
        throw new Error("project submission failed");
      }
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProject();
    await expect(bridge.openProject()).rejects.toThrow("project submission failed");

    expect(bridge.projectName()).toBeUndefined();
  });

  it("restarts a portable project from its copy-on-write configuration overlay", async () => {
    const root = new MemoryDirectoryHandle("game-storage");
    const originalText = "FontSize:18\n";
    const originalBytes = new TextEncoder().encode(originalText);
    const source = new File([], "emuera.config");
    Object.defineProperties(source, {
      size: { value: originalBytes.byteLength },
      arrayBuffer: { value: async () => originalBytes.buffer.slice(0) },
      text: { value: async () => originalText },
    });
    const handle = overlayBrowserDirectory(root as any, [{ path: "emuera.config", file: source }]);
    pickBrowserDirectory.mockResolvedValue({
      handle,
      persistHandle: false,
      projectName: "game",
      manifest: {
        project_revision: 1,
        compatibility: referenceCompatibility(),
        files: [
          {
            relative_path: "emuera.config",
            category: "configuration",
            payload: { type: "utf8", value: originalText },
            content_hash: blake3(originalBytes),
          },
        ],
      },
    });
    const bridge = new BrowserBridge();

    await bridge.openProject();
    await bridge.writeProjectConfiguration(new Uint8Array(), "[text]\nfont_size = 20\n");
    await bridge.restartProject();

    const restart = requests
      .filter((request) => request.message.method === "loadProjectBinary")
      .at(-1);
    expect(new TextDecoder().decode(restart?.message.args[0] as Uint8Array)).toContain(
      "font_size = 20",
    );
    expect(await source.text()).toBe(originalText);
  });
});
