import {
  referenceCompatibility as createReferenceCompatibility,
  snakeCompatibility as createSnakeCompatibility,
} from "./compatibilityTestSupport";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blake3 as hashBlake3 } from "@noble/hashes/blake3.js";

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

import { BrowserBridge as BrowserBridgeImplementation } from "@/platform/browserBridge";

import { defaultPreferences as createDefaultPreferences, type SessionOptions } from "@/core/types";

import {
  loadBrowserPreferences as loadStoredBrowserPreferences,
  saveBrowserPreferences as saveStoredBrowserPreferences,
} from "@/platform/database";

import { overlayBrowserDirectory as overlayDirectory } from "@/platform/browserDirectoryOverlay";

import { BrowserProject as BrowserProjectImplementation } from "@/platform/browserProject";

import { BrowserProjectPreferenceStore as ProjectPreferenceStore } from "@/platform/projectPreferences";

import {
  BROWSER_FILE_SAVE_EVENT as browserFileSaveEvent,
  type BrowserFileSaveRequest,
} from "@/platform/browserDownload";

import { ProjectFontRegistry as FontRegistry } from "@/platform/projectFonts";

const BrowserBridge = BrowserBridgeImplementation;
const referenceCompatibility = createReferenceCompatibility;
const snakeCompatibility = createSnakeCompatibility;
const blake3 = hashBlake3;
const defaultPreferences = createDefaultPreferences;
const loadBrowserPreferences = loadStoredBrowserPreferences;
const saveBrowserPreferences = saveStoredBrowserPreferences;
const overlayBrowserDirectory = overlayDirectory;
const BrowserProject = BrowserProjectImplementation;
const BrowserProjectPreferenceStore = ProjectPreferenceStore;
const BROWSER_FILE_SAVE_EVENT = browserFileSaveEvent;
const ProjectFontRegistry = FontRegistry;
type BrowserProject = BrowserProjectImplementation;

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

const responseControl: {
  respond: (method: string, args: unknown[]) => unknown;
} = { respond: () => 1n };

function workerResponse(method: string, args: unknown[]): unknown {
  const result = responseControl.respond(method, args);
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

function resetBrowserBridgeHarness(): void {
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
  responseControl.respond = () => 1n;
  streamDiagnosisArchiveInWorker.mockReset();
  vi.mocked(loadBrowserPreferences).mockReset();
  vi.mocked(loadBrowserPreferences).mockResolvedValue(defaultPreferences());
  vi.mocked(saveBrowserPreferences).mockReset();
  vi.mocked(saveBrowserPreferences).mockImplementation(async (value) => value);
  vi.stubGlobal("Worker", MemoryWorker);
}

function cleanupBrowserBridgeHarness(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.__RUSTYERA_TEST_DOWNLOADS__ = undefined;
}

export {
  BROWSER_FILE_SAVE_EVENT,
  BrowserBridge,
  BrowserProject,
  BrowserProjectPreferenceStore,
  MemoryDirectoryHandle,
  MemoryFileHandle,
  ProjectFontRegistry,
  SESSION_OPTIONS,
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
  metadataRequests,
  overlayBrowserDirectory,
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
  referenceCompatibility,
  requests,
  resetBrowserBridgeHarness,
  responseControl,
  runtimeWorkers,
  snakeCompatibility,
  streamDiagnosisArchiveInWorker,
  vi,
  workerEvents,
};
export type { BrowserFileSaveRequest, SessionOptions, WorkerRequest };
