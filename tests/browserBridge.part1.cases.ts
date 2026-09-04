import {
  BrowserBridge,
  BrowserProject,
  BrowserProjectPreferenceStore,
  MemoryDirectoryHandle,
  ProjectFontRegistry,
  SESSION_OPTIONS,
  afterEach,
  beforeEach,
  blake3,
  cleanupBrowserBridgeHarness,
  deferred,
  describe,
  directoryEntryNames,
  expect,
  flushMicrotasks,
  installCache,
  it,
  metadataRequests,
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
  referenceCompatibility,
  requests,
  resetBrowserBridgeHarness,
  responseControl,
  runtimeWorkers,
  snakeCompatibility,
  vi,
  workerEvents,
} from "./browserBridge.testHarness";

describe("browser project preferences", () => {
  it("treats a missing packaged preference file as an empty writable profile", async () => {
    const storage = new MemoryDirectoryHandle("storage");

    const store = await BrowserProjectPreferenceStore.packaged(
      storage as unknown as FileSystemDirectoryHandle,
      "project-key",
    );

    expect(store.writable).toBe(true);
    expect(store.values()).toEqual({ settings: {} });
    await expect(store.save({ settings: { UseMouse: "NO" } })).resolves.toEqual({
      settings: { UseMouse: "NO" },
    });
  });

  it("keeps packaged project preferences writable for the session without OPFS", async () => {
    const store = BrowserProjectPreferenceStore.session();

    expect(store.writable).toBe(true);
    await expect(store.save({ settings: { UseMouse: "NO" }, imageScale: 1.25 })).resolves.toEqual({
      settings: { UseMouse: "NO" },
      imageScale: 1.25,
    });
    expect(store.values()).toEqual({ settings: { UseMouse: "NO" }, imageScale: 1.25 });
  });

  it("stores source-project preferences in .rustyera and preserves sparse client values", async () => {
    const root = new MemoryDirectoryHandle("game");
    const store = await BrowserProjectPreferenceStore.source(
      root as unknown as FileSystemDirectoryHandle,
    );

    await store.save({
      settings: { UseMouse: "NO" },
      imageScale: 1.5,
      trustProjectFileMetadata: true,
      interactionAssistMode: "on",
    });

    const rustyera = await root.getDirectoryHandle(".rustyera");
    const file = await rustyera.getFileHandle("preferences-v1.json");
    const document = JSON.parse(await (await file.getFile()).text());
    expect(document.profiles.browser).toEqual({
      settings: { UseMouse: "NO" },
      client: {
        imageScale: 1.5,
        trustProjectFileMetadata: true,
        interactionAssistMode: "on",
      },
    });
  });

  it("preserves other client profiles when updating the browser partition", async () => {
    const root = new MemoryDirectoryHandle("game");
    const rustyera = await root.getDirectoryHandle(".rustyera", { create: true });
    const file = await rustyera.getFileHandle("preferences-v1.json", { create: true });
    await (
      await file.createWritable()
    ).write(
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          tui: { settings: { UseMouse: "YES" }, client: { imageScale: 2 } },
          browser: { settings: { UseMouse: "YES" }, client: {} },
        },
      }),
    );
    const store = await BrowserProjectPreferenceStore.source(
      root as unknown as FileSystemDirectoryHandle,
    );

    await store.save({ settings: { UseMouse: "NO" }, masterVolume: 0.25 });

    const document = JSON.parse(await (await file.getFile()).text());
    expect(document.profiles.tui).toEqual({
      settings: { UseMouse: "YES" },
      client: { imageScale: 2 },
    });
    expect(document.profiles.browser).toEqual({
      settings: { UseMouse: "NO" },
      client: { masterVolume: 0.25 },
    });
  });

  it("normalizes legacy menu values in browser project preferences", async () => {
    const root = new MemoryDirectoryHandle("game");
    const rustyera = await root.getDirectoryHandle(".rustyera", { create: true });
    const file = await rustyera.getFileHandle("preferences-v1.json", { create: true });
    await (
      await file.createWritable()
    ).write(
      JSON.stringify({
        schemaVersion: 1,
        profiles: { browser: { settings: { UseMenu: "前" }, client: {} } },
      }),
    );

    const store = await BrowserProjectPreferenceStore.source(
      root as unknown as FileSystemDirectoryHandle,
    );
    expect(store.values().settings).toEqual({ UseMenu: "AUTO" });
    await expect(store.save({ settings: { UseMenu: "後" } })).resolves.toMatchObject({
      settings: { UseMenu: "HIDE" },
    });
  });

  it.each([
    {
      label: "future schema",
      document: { schemaVersion: 2, profiles: {} },
    },
    {
      label: "unknown active-profile field",
      document: {
        schemaVersion: 1,
        profiles: { browser: { settings: {}, client: { futureControl: true } } },
      },
    },
    {
      label: "unknown active-profile top-level field",
      document: {
        schemaVersion: 1,
        profiles: { browser: { settings: {}, client: {}, futureControl: true } },
      },
    },
    {
      label: "out-of-range client value",
      document: {
        schemaVersion: 1,
        profiles: { browser: { settings: {}, client: { imageScale: 9 } } },
      },
    },
    {
      label: "invalid interaction assistance mode",
      document: {
        schemaVersion: 1,
        profiles: { browser: { settings: {}, client: { interactionAssistMode: "sometimes" } } },
      },
    },
  ])("keeps a $label project preference document read-only", async ({ document }) => {
    const root = new MemoryDirectoryHandle("game");
    const rustyera = await root.getDirectoryHandle(".rustyera", { create: true });
    const file = await rustyera.getFileHandle("preferences-v1.json", { create: true });
    const original = `${JSON.stringify(document)}\n`;
    await (await file.createWritable()).write(original);

    const store = await BrowserProjectPreferenceStore.source(
      root as unknown as FileSystemDirectoryHandle,
    );

    expect(store.writable).toBe(false);
    expect(store.error).toContain("无法读取项目偏好");
    await expect(store.save({ settings: {} })).rejects.toThrow("无法读取项目偏好");
    expect(await (await file.getFile()).text()).toBe(original);
  });
});

describe("browser startup bridge", () => {
  beforeEach(resetBrowserBridgeHarness);
  afterEach(cleanupBrowserBridgeHarness);

  it("resolves compatibility before cache lookup and binds snake storage", async () => {
    const root = new MemoryDirectoryHandle("game");
    const source = await root.getFileHandle("main.erb", { create: true });
    await (await source.createWritable()).write(new TextEncoder().encode("@MAIN\nRETURN\n"));
    await installCache(root, Uint8Array.of(9, 8, 7));
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
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
    expect(metadataRequests.map((request) => request.message.method)).toEqual([
      "resolveProjectCompatibility",
    ]);
    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectBinary"]);
    const encoded = requests[0].message.args[0] as Uint8Array;
    const view = new DataView(encoded.buffer);
    const identity = JSON.parse(
      new TextDecoder().decode(encoded.subarray(24, 24 + view.getUint32(20, true))),
    );
    expect(identity).toEqual(snakeCompatibility());
    const owned = bridge as unknown as { project: BrowserProject };
    expect(owned.project.compatibility()).toEqual(snakeCompatibility());
    expect((await owned.project.dataRoot()).name).toBe("emuera.skia.snake");
  });

  it("does not bind a late compatibility result after the open was cancelled", async () => {
    const root = new MemoryDirectoryHandle("game");
    const project = new BrowserProject(root as unknown as FileSystemDirectoryHandle);
    const manifest = await project.scanQuick();
    const response = deferred<unknown>();
    responseControl.respond = (method) =>
      method === "resolveProjectCompatibility" ? response.promise : 1n;
    const bridge = new BrowserBridge();
    const pending = (
      bridge as unknown as {
        resolveCompatibility(project: BrowserProject, manifest: unknown): Promise<void>;
      }
    ).resolveCompatibility(project, manifest);
    const rejected = expect(pending).rejects.toThrow(/取消|关闭/);
    await flushMicrotasks();
    await bridge.dispose();
    response.resolve({ request_id: 0, identity: snakeCompatibility(), diagnostics: [] });
    await rejected;
    expect(manifest.compatibility).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("does not resurrect an open whose scan completes after disposal", async () => {
    const root = new MemoryDirectoryHandle("game");
    const release = vi.fn();
    pickBrowserDirectory.mockResolvedValue({ handle: root, persistHandle: false, release });
    const delayed = deferred<Awaited<ReturnType<BrowserProject["scanQuick"]>>>();
    const scan = vi.spyOn(BrowserProject.prototype, "scanQuick").mockReturnValue(delayed.promise);
    const bridge = new BrowserBridge();
    const pending = bridge.openProject();
    const rejected = expect(pending).rejects.toThrow(/取消/);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    await bridge.dispose();
    delayed.resolve({ project_revision: 1, files: [] });
    await rejected;
    expect(metadataRequests).toEqual([]);
    expect(requests).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect((bridge as unknown as { project?: BrowserProject }).project).toBeUndefined();
  });

  it("does not submit a delayed cache result to a replacement session", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({ handle: root, persistHandle: false });
    const delayed = deferred<Uint8Array | undefined>();
    const cache = vi
      .spyOn(BrowserProject.prototype, "readCompiledCache")
      .mockReturnValue(delayed.promise);
    const bridge = new BrowserBridge();
    const pending = bridge.openProject();
    const rejected = expect(pending).rejects.toThrow(/Runtime 已替换/);
    await vi.waitFor(() => expect(cache).toHaveBeenCalledOnce());
    await bridge.createSession(SESSION_OPTIONS);
    delayed.resolve(Uint8Array.of(1, 2, 3));
    await rejected;
    expect(requests.map((request) => request.message.method)).toEqual(["create"]);
    expect((bridge as unknown as { project?: BrowserProject }).project).toBeUndefined();
  });

  it("rejects a same-profile configuration change discovered during materialization", async () => {
    const root = new MemoryDirectoryHandle("game");
    const configuration = await root.getFileHandle("reraconfig.toml", { create: true });
    const original = '[meta]\nschema_version = 4\n[compatibility]\nprofile = "emuera.em"\n';
    await (await configuration.createWritable()).write(original);
    pickBrowserDirectory.mockResolvedValue({ handle: root, persistHandle: false });
    vi.spyOn(BrowserProject.prototype, "quickManifestHasAllSources").mockReturnValue(false);
    const materialize = BrowserProject.prototype.materialize;
    vi.spyOn(BrowserProject.prototype, "materialize").mockImplementation(async function (
      this: BrowserProject,
      ...args
    ) {
      await (await configuration.createWritable()).write(original + "# edited after resolve\n");
      return materialize.apply(this, args);
    });
    const bridge = new BrowserBridge();
    await expect(bridge.openProject()).rejects.toThrow(/兼容解析后发生变化/);
    expect(metadataRequests.map((request) => request.message.method)).toEqual([
      "resolveProjectCompatibility",
    ]);
    expect(requests).toEqual([]);
    expect((bridge as unknown as { project?: BrowserProject }).project).toBeUndefined();
  });

  it("never falls back to source or binds storage after invalid compatibility", async () => {
    const root = new MemoryDirectoryHandle("game");
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
    });
    responseControl.respond = (method) =>
      method === "resolveProjectCompatibility"
        ? {
            request_id: 0,
            identity: null,
            configuration_digest: null,
            diagnostics: [{ message: "unknown profile" }],
          }
        : 1n;
    const bridge = new BrowserBridge();
    await expect(bridge.openProject()).rejects.toThrow("unknown profile");
    expect(requests).toEqual([]);
    expect((bridge as unknown as { project?: BrowserProject }).project).toBeUndefined();
    expect(await directoryEntryNames(root)).not.toContain("profiles");
  });

  it("reloads a constrained packaged project and imports its snapshot only after replacing the old VM worker", async () => {
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
      if (method === "loadProjectFile")
        return {
          storageKey: "ios-restore-key",
          manifest: { project_revision: 3, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      return 1n;
    };
    const bridge = new BrowserBridge();

    expect(bridge.snapshotRestoreMode).toBe("fresh_session");
    expect(bridge.automaticCompiledCacheExport).toBe(false);
    await bridge.createSession(SESSION_OPTIONS);
    expect(requests[0]?.message.args[0]).toMatchObject({ retainProjectSourcePayloads: false });
    await bridge.openProjectFile();
    const first = runtimeWorkers[0]!;

    await bridge.prepareSessionReplacement();
    await bridge.createSession(SESSION_OPTIONS);
    await bridge.restartProject();
    await bridge.submitRuntime({
      type: "state_import_begin",
      value: {
        kind: "vm_snapshot",
        total_bytes: 3,
        digest: new Uint8Array(32),
        artifact_id: null,
      },
    });
    const chunk = Uint8Array.of(5, 6, 7);
    await bridge.submitRuntime({
      type: "state_import_chunk",
      value: { transfer_id: 9, offset: 0, data: chunk },
    });

    expect(runtimeWorkers).toHaveLength(2);
    const second = runtimeWorkers[1]!;
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).not.toHaveBeenCalled();
    expect(
      requests.map(({ worker, message }) => [runtimeWorkers.indexOf(worker), message.method]),
    ).toEqual([
      [0, "create"],
      [0, "loadProjectFile"],
      [1, "create"],
      [1, "loadProjectFile"],
      [1, "submitRuntime"],
      [1, "submitRuntime"],
    ]);
    const terminatedAt = workerEvents.findIndex(
      (event) => event.type === "terminate" && event.worker === first,
    );
    const firstReplacementRequest = workerEvents.findIndex(
      (event) => event.type === "request" && event.worker === second,
    );
    expect(terminatedAt).toBeGreaterThanOrEqual(0);
    expect(terminatedAt).toBeLessThan(firstReplacementRequest);
    expect(requests.at(-1)?.transfer).toEqual([chunk.buffer]);
  });

  it.each([
    {
      host: "Android mobile browser",
      signals: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        deviceMemory: 8,
      },
    },
    {
      host: "4 GiB Chromium desktop",
      signals: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
        platform: "Win32",
        maxTouchPoints: 0,
        deviceMemory: 4,
      },
    },
  ])("applies the complete constrained-memory bridge strategy to $host", async ({ signals }) => {
    const root = new MemoryDirectoryHandle("game");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => new MemoryDirectoryHandle("storage") },
      ...signals,
    });
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
    });
    const bridge = new BrowserBridge();

    expect(bridge.snapshotRestoreMode).toBe("fresh_session");
    expect(bridge.automaticCompiledCacheExport).toBe(false);
    await bridge.createSession(SESSION_OPTIONS);
    await expect(bridge.openProject()).resolves.toMatchObject({ memoryConstrained: true });
    const firstWorker = runtimeWorkers[0]!;
    await bridge.prepareSessionReplacement();

    expect(requests[0]?.message.args[0]).toMatchObject({ retainProjectSourcePayloads: false });
    expect(requests.map((request) => request.message.method)).toEqual([
      "create",
      "beginProjectManifest",
      "finishProjectManifest",
    ]);
    expect(runtimeWorkers).toHaveLength(2);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
  });

  it("retains only the active portable directory selection", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    pickBrowserDirectory
      .mockResolvedValueOnce({
        handle: new MemoryDirectoryHandle("first"),
        persistHandle: false,
        projectName: "first",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        handle: new MemoryDirectoryHandle("second"),
        persistHandle: false,
        projectName: "second",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: secondRelease,
      });
    const bridge = new BrowserBridge();

    await bridge.openProject();
    expect(firstRelease).not.toHaveBeenCalled();
    await bridge.openProject();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    await bridge.close();
    await bridge.close();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it("retires the active portable project when replacement submission fails", async () => {
    const firstRelease = vi.fn();
    const candidateRelease = vi.fn();
    const activeRoot = new MemoryDirectoryHandle("active");
    pickBrowserDirectory
      .mockResolvedValueOnce({
        handle: activeRoot,
        persistHandle: false,
        storagePersistent: true,
        projectName: "active",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        handle: new MemoryDirectoryHandle("candidate"),
        persistHandle: false,
        storagePersistent: false,
        projectName: "candidate",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: candidateRelease,
      });
    const bridge = new BrowserBridge();
    await bridge.openProject();
    responseControl.respond = (method) => {
      if (method === "loadProjectBinary") throw new Error("candidate submission failed");
      return 1n;
    };

    await expect(bridge.openProject()).rejects.toThrow("candidate submission failed");

    expect(bridge.projectName()).toBeUndefined();
    expect(candidateRelease).toHaveBeenCalledOnce();
    expect(firstRelease).toHaveBeenCalledOnce();
    await bridge.close();
    expect(firstRelease).toHaveBeenCalledOnce();
  });

  it("commits a portable project before reporting an unexpected font registration failure", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    pickBrowserDirectory
      .mockResolvedValueOnce({
        handle: new MemoryDirectoryHandle("first"),
        persistHandle: false,
        projectName: "first",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        handle: new MemoryDirectoryHandle("second"),
        persistHandle: false,
        projectName: "second",
        manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
        release: secondRelease,
      });
    vi.spyOn(ProjectFontRegistry.prototype, "replace")
      .mockResolvedValueOnce({ fonts: [], errors: [] })
      .mockRejectedValueOnce(new Error("font registry unavailable"));
    const bridge = new BrowserBridge();
    await bridge.openProject();

    await expect(bridge.openProject()).rejects.toThrow("font registry unavailable");

    expect(bridge.projectName()).toBe("second");
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    await bridge.close();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it("drops a portable lease when a packaged project commits before a font failure", async () => {
    const directoryRelease = vi.fn();
    pickBrowserDirectory.mockResolvedValue({
      handle: new MemoryDirectoryHandle("directory"),
      persistHandle: false,
      projectName: "directory",
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
      release: directoryRelease,
    });
    const file = new File([Uint8Array.of(1, 2, 3)], "packaged.reraproj");
    pickBrowserProjectFile.mockResolvedValue({ file });
    responseControl.respond = (method) => {
      if (method === "loadProjectFileBytes") {
        return {
          storageKey: "packaged-font-failure",
          manifest: { project_revision: 2, compatibility: referenceCompatibility(), files: [] },
          cacheImported: true,
        };
      }
      return 1n;
    };
    vi.spyOn(ProjectFontRegistry.prototype, "replace")
      .mockResolvedValueOnce({ fonts: [], errors: [] })
      .mockRejectedValueOnce(new Error("font registry unavailable"));
    const bridge = new BrowserBridge();
    await bridge.openProject();

    await expect(bridge.openProjectFile()).rejects.toThrow("font registry unavailable");

    expect(bridge.projectName()).toBe("packaged");
    expect(directoryRelease).toHaveBeenCalledOnce();
    await bridge.close();
    expect(directoryRelease).toHaveBeenCalledOnce();
  });

  it("releases a picked directory when submission notification fails", async () => {
    const release = vi.fn();
    pickBrowserDirectory.mockResolvedValue({
      handle: new MemoryDirectoryHandle("candidate"),
      persistHandle: false,
      manifest: { project_revision: 1, compatibility: referenceCompatibility(), files: [] },
      release,
    });

    await expect(
      new BrowserBridge().openProject(() => {
        throw new Error("submission notification failed");
      }),
    ).rejects.toThrow("submission notification failed");

    expect(release).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("transfers snapshot import chunks into the runtime worker", async () => {
    const bridge = new BrowserBridge();
    const data = Uint8Array.of(1, 2, 3);

    await bridge.submitRuntime({
      type: "state_import_chunk",
      value: { transfer_id: 7, offset: 0, data },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.message.args[0]).toMatchObject({
      type: "state_import_chunk",
      value: { transfer_id: 7, offset: 0, data },
    });
    expect(requests[0]!.transfer).toEqual([data.buffer]);
  });

  it("replaces the desktop worker before a whole-session restart", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
      platform: "Win32",
      maxTouchPoints: 0,
      deviceMemory: 8,
    });
    const bridge = new BrowserBridge();

    expect(bridge.snapshotRestoreMode).toBe("fresh_session");
    expect(bridge.automaticCompiledCacheExport).toBe(true);
    await bridge.createSession(SESSION_OPTIONS);
    const firstWorker = runtimeWorkers[0]!;
    await bridge.prepareSessionReplacement();

    expect(runtimeWorkers).toHaveLength(2);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(requests[0]?.message.args[0]).toMatchObject({ retainProjectSourcePayloads: false });
  });

  it("reports the live worker generation and current WASM linear memory", async () => {
    responseControl.respond = (method) => {
      if (method === "create")
        return {
          state: "idle",
          vmInstructions: 0,
          runtimeTransitions: 0,
          memoryBytes: runtimeWorkers.length * 64,
          events: [],
        };
      return 1n;
    };
    const bridge = new BrowserBridge();

    expect(bridge.runtimeMemoryCounters()).toEqual({
      workerGeneration: 1,
      wasmLinearMemoryBytes: null,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });
    await bridge.createSession(SESSION_OPTIONS);
    expect(bridge.runtimeMemoryCounters()).toEqual({
      workerGeneration: 1,
      wasmLinearMemoryBytes: 64,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });

    await bridge.prepareSessionReplacement();
    expect(bridge.runtimeMemoryCounters()).toEqual({
      workerGeneration: 2,
      wasmLinearMemoryBytes: null,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });
    await bridge.createSession(SESSION_OPTIONS);
    expect(bridge.runtimeMemoryCounters()).toEqual({
      workerGeneration: 2,
      wasmLinearMemoryBytes: 128,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });
  });

  it("retires all committed browser-project owners as one state transition", () => {
    const bridge = new BrowserBridge();
    const project = { finalizeReload: vi.fn() };
    const release = vi.fn();
    const owned = bridge as unknown as {
      project?: typeof project;
      projectPreferenceStore?: object;
      projectDirectorySelectionRelease?: () => void;
      retireCommittedProject(): void;
    };
    owned.project = project;
    owned.projectPreferenceStore = {};
    owned.projectDirectorySelectionRelease = release;

    owned.retireCommittedProject();

    expect(project.finalizeReload).toHaveBeenCalledWith(false);
    expect(release).toHaveBeenCalledOnce();
    expect(owned.project).toBeUndefined();
    expect(owned.projectPreferenceStore).toBeUndefined();
    expect(owned.projectDirectorySelectionRelease).toBeUndefined();
  });

  it("releases submitted constrained-browser sources and rescans them for a restart", async () => {
    const root = new MemoryDirectoryHandle("game");
    await installCache(root, Uint8Array.of(9, 8, 7));
    const source = await root.getFileHandle("main.erb", { create: true });
    const other = await root.getFileHandle("other.erb", { create: true });
    const initial = "@SYSTEM_TITLE\nPRINTL OLD\nRETURN\n";
    await (await source.createWritable()).write(new TextEncoder().encode(initial));
    const otherInitial = "@OTHER\nPRINTL OTHER OLD\nRETURN\n";
    await (await other.createWritable()).write(new TextEncoder().encode(otherInitial));
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => new MemoryDirectoryHandle("storage") },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    pickBrowserDirectory.mockResolvedValue({
      handle: root,
      persistHandle: false,
      projectName: "game",
      manifest: {
        project_revision: 1,
        compatibility: referenceCompatibility(),
        files: [
          {
            relative_path: "main.erb",
            category: "erb",
            payload: { type: "utf8", value: initial },
            content_hash: blake3(new TextEncoder().encode(initial)),
          },
          {
            relative_path: "other.erb",
            category: "erb",
            payload: { type: "utf8", value: otherInitial },
            content_hash: blake3(new TextEncoder().encode(otherInitial)),
          },
        ],
      },
    });
    const bridge = new BrowserBridge();

    await expect(bridge.openProject()).resolves.toMatchObject({ memoryConstrained: true });
    await (
      await source.createWritable()
    ).write(new TextEncoder().encode("@SYSTEM_TITLE\nPRINTL PARTIAL\nRETURN\n"));
    await bridge.reloadProject({ type: "script", path: "main.erb" });
    const reload = requests.find(
      (request) =>
        request.message.method === "submitRuntime" &&
        (request.message.args[0] as { type?: string }).type === "reload_project",
    )?.message.args[0] as {
      value: { changes: Array<{ file: { relative_path: string; payload: { value: string } } }> };
    };
    expect(reload.value.changes).toHaveLength(2);
    expect(
      reload.value.changes.find((change) => change.file.relative_path === "other.erb")?.file.payload
        .value,
    ).toContain("OTHER OLD");
    await bridge.finalizeProjectReload(true);
    await (
      await source.createWritable()
    ).write(new TextEncoder().encode("@SYSTEM_TITLE\nPRINTL NEW\nRETURN\n"));
    await bridge.restartProject();
    await bridge.stageFullProjectManifest();
    await bridge.releaseFullProjectManifest();
    await (
      await source.createWritable()
    ).write(new TextEncoder().encode("@SYSTEM_TITLE\nPRINTL EXPORTED\nRETURN\n"));
    await bridge.submitProjectSource();

    const submissions: string[] = [];
    let streamed = "";
    for (const request of requests) {
      if (request.message.method === "beginProjectManifest") streamed = "";
      if (request.message.method === "appendProjectManifestFile") {
        streamed += new TextDecoder().decode(request.message.args[3] as Uint8Array);
        expect(request.transfer).toEqual([
          (request.message.args[3] as Uint8Array).buffer,
          (request.message.args[4] as Uint8Array).buffer,
        ]);
      }
      if (request.message.method === "finishProjectManifest") submissions.push(streamed);
    }
    expect(
      requests.some((request) => request.message.method === "loadProjectWithCompiledCacheBinary"),
    ).toBe(false);
    expect(requests.some((request) => request.message.method === "loadProjectBinary")).toBe(false);
    expect(submissions).toHaveLength(3);
    expect(submissions[0]).toContain("PRINTL OLD");
    expect(submissions[1]).toContain("PRINTL NEW");
    expect(submissions[2]).toContain("PRINTL EXPORTED");
  });
});
