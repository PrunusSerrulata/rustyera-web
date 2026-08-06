import { beforeEach, describe, expect, it, vi } from "vitest";

const pickBrowserDirectory = vi.hoisted(() => vi.fn());
const pickBrowserFile = vi.hoisted(() => vi.fn());

vi.mock("@/platform/browserDirectory", () => ({ pickBrowserDirectory, pickBrowserFile }));
vi.mock("@/platform/database", () => ({
  database: { handles: { put: vi.fn() } },
  loadBrowserPreferences: vi.fn(),
  saveBrowserPreferences: vi.fn(),
}));

import { BrowserBridge } from "@/platform/browserBridge";
import { BrowserProject } from "@/platform/browserProject";

class MemoryFileHandle {
  readonly kind = "file";

  constructor(
    readonly name: string,
    private bytes = new Uint8Array(),
  ) {}

  async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.bytes);
    const file = new File([], this.name);
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    return file;
  }

  async createWritable() {
    return {
      write: async (bytes: Uint8Array) => {
        this.bytes = new Uint8Array(bytes);
      },
      close: async () => {},
      abort: async () => {},
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

  postMessage(message: WorkerRequest["message"], transfer: Transferable[] = []): void {
    requests.push({ message, transfer });
    queueMicrotask(() => {
      try {
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
  const cache = await cacheDirectory.getFileHandle("compiled-project.reraproj", { create: true });
  await (await cache.createWritable()).write(bytes);
}

describe("browser startup bridge", () => {
  beforeEach(() => {
    requests.length = 0;
    pickBrowserDirectory.mockReset();
    pickBrowserFile.mockReset();
    respond = () => 1n;
    vi.stubGlobal("Worker", MemoryWorker);
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
      if (method === "loadProjectWithCompiledCache" && cacheAttempts++ === 0)
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
      requests.filter((request) => request.message.method === "loadProjectWithCompiledCache"),
    ).toHaveLength(2);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it("transfers a packaged file once, retains it for restart, and does not copy it to OPFS", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const file = new File([], "game.reraproj");
    const arrayBuffer = vi.fn(async () => bytes.buffer.slice(0));
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile")
        return {
          storageKey: "legacy-key",
          manifest: { project_revision: 3, files: [] },
        };
      return 1n;
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await bridge.restartProject();

    expect(requests.map((request) => request.message.method)).toEqual([
      "loadProjectFile",
      "loadProjectWithCompiledCache",
    ]);
    expect(requests[0].transfer).toHaveLength(1);
    expect(arrayBuffer).toHaveBeenCalledTimes(2);
    const projectRoot = await (
      await storage.getDirectoryHandle(".rustyera-project-files")
    ).getDirectoryHandle("legacy-key");
    await expect(projectRoot.getDirectoryHandle(".rustyera")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("reads large packaged projects in visible chunks before transferring them", async () => {
    const storage = new MemoryDirectoryHandle("storage");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
    const file = new File([bytes], "large.reraproj");
    pickBrowserFile.mockResolvedValue(file);
    respond = (method) => {
      if (method === "loadProjectFile")
        return { storageKey: "large-key", manifest: { project_revision: 1, files: [] } };
      return 1n;
    };
    const progress = vi.fn();
    const bridge = new BrowserBridge();
    bridge.setProjectProgressListener(progress);

    await bridge.openProjectFile();

    expect(progress.mock.calls).toEqual([
      [{ stage: "scanning", completed: 0, total: bytes.byteLength }],
      [{ stage: "scanning", completed: 4 * 1024 * 1024, total: bytes.byteLength }],
      [{ stage: "scanning", completed: bytes.byteLength, total: bytes.byteLength }],
    ]);
    const transferred = requests[0].message.args[0] as Uint8Array;
    expect(transferred).toHaveLength(bytes.byteLength);
    expect(transferred[0]).toBe(7);
    expect(transferred[transferred.byteLength - 1]).toBe(7);
    expect(requests[0].transfer).toHaveLength(1);
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
      return { storageKey: "active-key", manifest: { project_revision: 1, files: [] } };
    };
    const bridge = new BrowserBridge();

    await bridge.openProjectFile();
    await expect(bridge.openProjectFile()).rejects.toThrow("invalid project file");

    expect(bridge.projectName()).toBe("active");
  });
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, start) =>
    needle.every((byte, offset) => haystack[start + offset] === byte),
  );
}
