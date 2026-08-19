import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";

const pickBrowserDirectory = vi.hoisted(() => vi.fn());
const pickBrowserFile = vi.hoisted(() => vi.fn());
const pickBrowserProjectFile = vi.hoisted(() => vi.fn());
const streamDiagnosisArchiveInWorker = vi.hoisted(() => vi.fn());

vi.mock("@/platform/browserDirectory", () => ({
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
}));
vi.mock("@/platform/database", () => ({
  database: { handles: { put: vi.fn() } },
  loadBrowserPreferences: vi.fn(),
  saveBrowserPreferences: vi.fn(),
}));
vi.mock("@/platform/diagnosis", () => ({ streamDiagnosisArchiveInWorker }));

import { BrowserBridge } from "@/platform/browserBridge";
import { defaultPreferences } from "@/core/types";
import { loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { overlayBrowserDirectory } from "@/platform/browserDirectoryOverlay";
import { BrowserProject } from "@/platform/browserProject";
import { BrowserProjectPreferenceStore } from "@/platform/projectPreferences";

class MemoryFileHandle {
  readonly kind = "file";
  readonly abort = vi.fn(async () => {});
  private lastModified = 1;

  constructor(
    readonly name: string,
    private bytes = new Uint8Array(),
  ) {}

  async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.bytes);
    const file = new File([], this.name, { lastModified: this.lastModified });
    Object.defineProperties(file, {
      size: { value: bytes.byteLength },
      arrayBuffer: { value: async () => bytes.buffer.slice(0) },
      text: { value: async () => new TextDecoder().decode(bytes) },
      slice: {
        value: (start = 0, end = bytes.byteLength) => {
          const chunk = bytes.slice(start, end);
          return { arrayBuffer: async () => chunk.buffer.slice(0) } as Blob;
        },
      },
    });
    return file;
  }

  async createWritable(options?: { keepExistingData?: boolean }) {
    if (!options?.keepExistingData) this.bytes = new Uint8Array();
    let cursor = 0;
    return {
      write: async (input: string | Uint8Array) => {
        const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
        const end = cursor + bytes.byteLength;
        if (end > this.bytes.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(this.bytes);
          this.bytes = grown;
        }
        this.bytes.set(bytes, cursor);
        cursor = end;
        this.lastModified += 1;
      },
      seek: async (position: number) => {
        cursor = position;
      },
      truncate: async (size: number) => {
        this.bytes = this.bytes.slice(0, size);
        if (cursor > size) cursor = size;
      },
      close: async () => {},
      abort: this.abort,
    };
  }
}

describe("browser project preferences", () => {
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

class MemoryDirectoryHandle {
  readonly kind = "directory";
  private readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectoryHandle) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const directory = new MemoryDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFileHandle) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const file = new MemoryFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }

  async *entries() {
    yield* this.children.entries();
  }
}

interface WorkerRequest {
  message: { id: number; method: string; args: unknown[] };
  transfer: Transferable[];
}

const requests: WorkerRequest[] = [];
let respond: (method: string, args: unknown[]) => unknown;

class MemoryWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;

  constructor(url: URL) {
    if (String(url).includes("browserProjectScan.worker"))
      throw new Error("scan worker unavailable");
  }

  postMessage(message: WorkerRequest["message"], transfer: Transferable[] = []): void {
    requests.push({ message, transfer });
    queueMicrotask(() => {
      try {
        if (message.method === "loadProjectFile") {
          const file = message.args[0] as File;
          this.onmessage?.({
            data: {
              type: "project_progress",
              value: { stage: "scanning", completed: file.size, total: file.size },
            },
          } as MessageEvent);
        }
        this.onmessage?.({
          data: { id: message.id, result: respond(message.method, message.args) },
        } as MessageEvent);
      } catch (error) {
        this.onmessage?.({
          data: { id: message.id, error: error instanceof Error ? error.message : String(error) },
        } as MessageEvent);
      }
    });
  }

  terminate(): void {}
}

async function installCache(root: MemoryDirectoryHandle, bytes: Uint8Array): Promise<void> {
  const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
  const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
  const cache = await cacheDirectory.getFileHandle("compiled-project.reracache", { create: true });
  await (await cache.createWritable()).write(bytes);
}

describe("browser startup bridge", () => {
  beforeEach(() => {
    requests.length = 0;
    pickBrowserDirectory.mockReset();
    pickBrowserFile.mockReset();
    pickBrowserProjectFile.mockReset();
    pickBrowserProjectFile.mockImplementation(async () => {
      const file = await pickBrowserFile();
      return file ? { file } : undefined;
    });
    respond = () => 1n;
    streamDiagnosisArchiveInWorker.mockReset();
    vi.mocked(loadBrowserPreferences).mockReset();
    vi.mocked(loadBrowserPreferences).mockResolvedValue(defaultPreferences());
    vi.mocked(saveBrowserPreferences).mockReset();
    vi.mocked(saveBrowserPreferences).mockImplementation(async (value) => value);
    vi.stubGlobal("Worker", MemoryWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

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

  it("falls back with one binary manifest transfer and retries its cache without rescanning", async () => {
    const root = new MemoryDirectoryHandle("game");
    await installCache(root, Uint8Array.of(9, 8, 7));
    const resourcePayload = { type: "bytes" as const, value: Uint8Array.of(1, 2, 3) };
    const secondResourcePayload = { type: "bytes" as const, value: Uint8Array.of(5, 6) };
    const manifest = {
      project_revision: 1,
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
    respond = (method) => {
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
    expect(new TextDecoder().decode(encoded.subarray(0, 8))).toBe("RERMAN01");
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
      manifest: { project_revision: 1, files: [] },
    });
    const bridge = new BrowserBridge();
    await bridge.openProject();

    await bridge.writeCompiledCacheChunk(Uint8Array.of(1, 2, 3), true, false);
    const cache = await (await root.getDirectoryHandle(".rustyera")).getDirectoryHandle("cache");
    const file = await cache.getFileHandle("compiled-project.reracache");
    await bridge.cancelCompiledCacheExport();

    expect(file.abort).toHaveBeenCalledOnce();
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
      manifest: { project_revision: 1, files: [] },
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

  it("imports a fallback packaged file into OPFS for incremental updates and restart", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([bytes], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile")
        return {
          storageKey: "legacy-key",
          manifest: { project_revision: 3, files: [] },
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
    await bridge.restartProject();

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFile",
      "prepareProjectConfigurationUpdate",
      "loadProjectFile",
    ]);
    expect(requests[0].transfer).toEqual([]);
    expect(requests[0].message.args).toEqual([file]);
    const projectRoot = await (
      await storage.getDirectoryHandle(".rustyera-project-files")
    ).getDirectoryHandle("legacy-key");
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

  it("loads the packaged cache on iOS without silently copying the project", async () => {
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
    respond = (method) => {
      if (method === "readProjectFileResource") return Uint8Array.of(4, 5, 6);
      if (method === "loadProjectFile")
        return {
          storageKey: "ios-key",
          manifest: {
            project_revision: 3,
            files: [
              {
                relative_path: "resources/a.bin",
                category: "resource",
                payload: { type: "bytes", value: new Uint8Array() },
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

    await expect(bridge.openProjectFile()).resolves.toMatchObject({ cacheImported: true });
    await expect(bridge.readResource("resources/a.bin")).resolves.toEqual(Uint8Array.of(4, 5, 6));
    await expect(bridge.restartProject()).resolves.toMatchObject({ cacheImported: true });

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFile",
      "readProjectFileResource",
      "loadProjectFile",
    ]);
    expect(requests[0].message.args).toEqual([file]);
    expect(requests[1].message.args).toEqual(["resources/a.bin", undefined]);
    expect(requests[2].message.args).toEqual([file]);
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

  it("routes a writable packaged configuration through the WASM update planner", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const handle = new MemoryFileHandle("game.reraproj", new TextEncoder().encode("base-tail"));
    const file = await handle.getFile();
    pickBrowserProjectFile.mockResolvedValue({ file, handle });
    respond = (method) => {
      if (method === "loadProjectFile")
        return {
          storageKey: "writable-key",
          manifest: { project_revision: 1, files: [] },
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
      "loadProjectFile",
      "prepareProjectConfigurationUpdate",
    ]);
    expect(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())).toBe(
      "basejournal",
    );
  });

  it("submits and prepares a selected project file before reading it", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const file = new File([Uint8Array.of(1, 2, 3)], "game.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile")
        return {
          storageKey: "selected-key",
          manifest: { project_revision: 1, files: [] },
          cacheImported: true,
        };
      return 1n;
    };
    const submitted = vi.fn();
    const progress = vi.fn();
    const prepareAfterSelection = vi.fn(async () => {
      expect(submitted).toHaveBeenCalledOnce();
      expect(progress).toHaveBeenCalledOnce();
      expect(progress).toHaveBeenCalledWith({
        stage: "scanning",
        completed: 0,
        total: file.size,
      });
      expect(requests).toHaveLength(0);
    });
    const bridge = new BrowserBridge();
    bridge.setProjectProgressListener(progress);

    await bridge.openProjectFile(submitted, prepareAfterSelection);

    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(
      prepareAfterSelection.mock.invocationCallOrder[0],
    );
    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFile"]);
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

  it("hands a large packaged File to the worker without reading or transferring it", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
    const file = new File([bytes], "large.reraproj");
    const wholeFileRead = vi.fn(async () => bytes.buffer.slice(0));
    Object.defineProperty(file, "arrayBuffer", { value: wholeFileRead });
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile")
        return {
          storageKey: "large-key",
          manifest: { project_revision: 1, files: [] },
          cacheImported: true,
        };
      return 1n;
    };
    const progress = vi.fn();
    const bridge = new BrowserBridge();
    bridge.setProjectProgressListener(progress);

    await bridge.openProjectFile();

    expect(progress.mock.calls).toEqual([
      [{ stage: "scanning", completed: 0, total: bytes.byteLength }],
      [{ stage: "scanning", completed: bytes.byteLength, total: bytes.byteLength }],
    ]);
    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFile"]);
    expect(requests[0].message.args).toEqual([file]);
    expect(requests[0].transfer).toEqual([]);
    expect(wholeFileRead).not.toHaveBeenCalled();
  });

  it("preserves a worker-side project read error", async () => {
    const file = new File([Uint8Array.of(1)], "broken.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile") throw new Error("project blob read failed");
      return undefined;
    };

    await expect(new BrowserBridge().openProjectFile()).rejects.toThrow("project blob read failed");

    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFile"]);
  });

  it("preserves a worker load error and allows the next upload", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const failed = new File([new Uint8Array(5 * 1024 * 1024)], "failed.reraproj");
    const retry = new File([Uint8Array.of(1, 2, 3)], "retry.reraproj");
    pickBrowserFile.mockResolvedValueOnce(failed).mockResolvedValueOnce(retry);
    let loadCalls = 0;
    respond = (method) => {
      if (method === "loadProjectFile" && loadCalls++ === 0)
        throw new Error("project chunk read failed");
      if (method === "loadProjectFile") {
        return {
          storageKey: "retry-key",
          manifest: { project_revision: 1, files: [] },
          cacheImported: true,
        };
      }
      return undefined;
    };
    const bridge = new BrowserBridge();

    await expect(bridge.openProjectFile()).rejects.toThrow("project chunk read failed");
    await expect(bridge.openProjectFile()).resolves.toMatchObject({ cacheImported: true });

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFile",
      "loadProjectFile",
    ]);
  });

  it("keeps the active packaged project when a replacement fails validation", async () => {
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
    respond = (method) => {
      if (method !== "loadProjectFile") return 1n;
      if (attempts++ > 0) throw new Error("invalid project file");
      return {
        storageKey: "active-key",
        manifest: { project_revision: 1, files: [] },
        cacheImported: true,
      };
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await expect(bridge.openProjectFile()).rejects.toThrow("invalid project file");

    expect(bridge.projectName()).toBe("active");
    expect(requests.at(-1)?.message.method).toBe("loadProjectFile");
  });

  it("keeps the active portable project when a replacement fails submission", async () => {
    const active = new MemoryDirectoryHandle("active-storage");
    const broken = new MemoryDirectoryHandle("broken-storage");
    const manifest = { project_revision: 1, files: [] };
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
    respond = (method) => {
      if (method === "loadProjectBinary" && submissions++ > 0) {
        throw new Error("project submission failed");
      }
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProject();
    await expect(bridge.openProject()).rejects.toThrow("project submission failed");

    expect(bridge.projectName()).toBe("active");
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

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, start) =>
    needle.every((byte, offset) => haystack[start + offset] === byte),
  );
}

function diagnosisInput() {
  return {
    projectName: "eraFL",
    snapshot: Uint8Array.of(1),
    inputReplay: Uint8Array.of(2),
    logs: "log",
    projectFile: Uint8Array.of(3),
    exportedAt: new Date(2026, 7, 13, 12, 0, 0),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
