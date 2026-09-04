import { referenceCompatibility, snakeCompatibility } from "./compatibilityTestSupport";
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
import { defaultPreferences, type SessionOptions } from "@/core/types";
import { loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { overlayBrowserDirectory } from "@/platform/browserDirectoryOverlay";
import { BrowserProject } from "@/platform/browserProject";
import { BrowserProjectPreferenceStore } from "@/platform/projectPreferences";
import { BROWSER_FILE_SAVE_EVENT, type BrowserFileSaveRequest } from "@/platform/browserDownload";
import { ProjectFontRegistry } from "@/platform/projectFonts";

const SESSION_OPTIONS: SessionOptions = {
  clientName: "test",
  availableFonts: [],
  preferredLocales: [],
  audioAvailable: true,
  debugScopeMask: 0,
  maximumEnvelopeBytes: 1024,
  configurationProfile: "browser",
};

class MemoryFileHandle {
  readonly kind = "file";
  readonly abort = vi.fn(async () => {});
  reads = 0;
  private lastModified = 1;

  constructor(
    readonly name: string,
    private bytes = new Uint8Array(),
  ) {}

  async getFile(): Promise<File> {
    this.reads += 1;
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

async function directoryEntryNames(directory: MemoryDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names;
}

interface WorkerRequest {
  worker: MemoryWorker;
  message: { id: number; method: string; args: unknown[] };
  transfer: Transferable[];
}

const requests: WorkerRequest[] = [];
// Metadata preflights are asserted separately from the existing byte-transfer contract.
const metadataRequests: WorkerRequest[] = [];
const runtimeWorkers: MemoryWorker[] = [];
const workerEvents: Array<
  | { type: "request"; worker: MemoryWorker; method: string }
  | { type: "terminate"; worker: MemoryWorker }
> = [];
let respond: (method: string, args: unknown[]) => unknown;

function workerResponse(method: string, args: unknown[]): unknown {
  const result = respond(method, args);
  if (method === "resolveProjectCompatibility" && (result == null || typeof result !== "object"))
    return {
      request_id: 0,
      identity: referenceCompatibility(),
      configuration_digest:
        (args[0] as { payload?: { value?: string } } | null)?.payload?.value == null
          ? null
          : blake3(
              new TextEncoder().encode(
                (args[0] as { payload: { value: string } }).payload.value
                  .replace(/^\uFEFF+/, "")
                  .replace(/\r\n?/g, "\n"),
              ),
            ),
      diagnostics: [],
    };
  if (method === "projectFileManifest" && (result == null || typeof result !== "object"))
    return { project_revision: 1, compatibility: referenceCompatibility(), files: [] };
  return result;
}

class MemoryWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  readonly terminate = vi.fn(() => workerEvents.push({ type: "terminate", worker: this }));

  constructor(url: URL) {
    if (String(url).includes("browserProjectScan.worker"))
      throw new Error("scan worker unavailable");
    runtimeWorkers.push(this);
  }

  postMessage(message: WorkerRequest["message"], transfer: Transferable[] = []): void {
    const destination = ["resolveProjectCompatibility", "projectFileManifest"].includes(
      message.method,
    )
      ? metadataRequests
      : requests;
    destination.push({ worker: this, message, transfer });
    workerEvents.push({ type: "request", worker: this, method: message.method });
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
          data: { id: message.id, result: workerResponse(message.method, message.args) },
        } as MessageEvent);
      } catch (error) {
        this.onmessage?.({
          data: { id: message.id, error: error instanceof Error ? error.message : String(error) },
        } as MessageEvent);
      }
    });
  }
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
    metadataRequests.length = 0;
    runtimeWorkers.length = 0;
    workerEvents.length = 0;
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
    respond = (method) =>
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
    respond = (method) => (method === "resolveProjectCompatibility" ? response.promise : 1n);
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
    respond = (method) =>
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
      if (method === "finishProjectManifest" && failReplacementFinish) {
        failReplacementFinish = false;
        throw new Error("replacement failed");
      }
      return 1n;
    };

    await expect(bridge.openProject()).rejects.toThrow("replacement failed");
    respond = () => 1n;
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

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.__RUSTYERA_TEST_DOWNLOADS__ = undefined;
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
    respond = (method) =>
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
      respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
      respond = (method) => {
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
    respond = (method) => {
      if (method === "loadProjectFileBytes") throw new Error("project blob read failed");
      return undefined;
    };

    await expect(new BrowserBridge().openProjectFile()).rejects.toThrow("project blob read failed");

    expect(requests.map((request) => request.message.method)).toEqual(["loadProjectFileBytes"]);
  });

  it("preserves a worker load error and allows the next upload", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const failed = new File([new Uint8Array(5 * 1024 * 1024)], "failed.reraproj");
    const retry = new File([Uint8Array.of(1, 2, 3)], "retry.reraproj");
    pickBrowserFile.mockResolvedValueOnce(failed).mockResolvedValueOnce(retry);
    let loadCalls = 0;
    respond = (method) => {
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
    respond = (method) => {
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
    respond = (method) => {
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
