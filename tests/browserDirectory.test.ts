import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importBrowserDirectory,
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserFileBytes,
  pickBrowserProjectFile,
  selectedProjectFiles,
} from "@/platform/browserDirectory";
import { BrowserProject } from "@/platform/browserProject";
import { scanBrowserProjectFile } from "@/platform/browserProjectScanner";

class MemoryFileHandle {
  readonly kind = "file";

  constructor(
    readonly name: string,
    private bytes = new Uint8Array(),
  ) {}

  async getFile(): Promise<File> {
    const file = new File([], this.name);
    const bytes = new Uint8Array(this.bytes);
    Object.defineProperties(file, {
      arrayBuffer: { value: async () => bytes.buffer.slice(0) },
      text: { value: async () => new TextDecoder().decode(bytes) },
    });
    return file;
  }

  async createWritable(): Promise<{
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }> {
    return {
      write: async (bytes) => {
        this.bytes = new Uint8Array(bytes);
      },
      close: async () => {},
    };
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory";
  private readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
  entriesCalls = 0;

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectoryHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryDirectoryHandle) return child;
    if (child instanceof MemoryFileHandle)
      throw new DOMException("wrong kind", "TypeMismatchError");
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryDirectoryHandle(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryFileHandle) return child;
    if (child instanceof MemoryDirectoryHandle)
      throw new DOMException("wrong kind", "TypeMismatchError");
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryFileHandle(name);
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }

  async *entries() {
    this.entriesCalls += 1;
    yield* this.children.entries();
  }
}

async function importedStorageProject(
  storage: MemoryDirectoryHandle,
): Promise<MemoryDirectoryHandle> {
  const imports = await storage.getDirectoryHandle(".rustyera-imports");
  for await (const [, handle] of imports.entries()) return handle as MemoryDirectoryHandle;
  throw new Error("imported project storage was not created");
}

function projectFile(path: string, contents = ""): File {
  const file = new File([], path.split("/").at(-1)!);
  const bytes = new TextEncoder().encode(contents);
  Object.defineProperties(file, {
    webkitRelativePath: { value: path },
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

describe("portable browser directory selection", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("waits for a delayed directory confirmation after the window regains focus", async () => {
    vi.useFakeTimers();
    const storage = new MemoryDirectoryHandle("root");
    vi.stubGlobal("showDirectoryPicker", undefined);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const progress = vi.fn();
    const submitted = vi.fn();
    const prepareAfterSelection = vi.fn(async () => {});
    const selection = pickBrowserDirectory(progress, submitted, prepareAfterSelection);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.webkitdirectory).toBe(true);
    const settled = vi.fn();
    void selection.then(settled, settled);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).not.toHaveBeenCalled();
    expect(prepareAfterSelection).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(input?.isConnected).toBe(true);
    Object.defineProperty(input, "files", { value: [projectFile("game/ERB/main.erb")] });
    input!.dispatchEvent(new Event("change"));

    await expect(selection).resolves.toMatchObject({ projectName: "game", persistHandle: false });
    expect(prepareAfterSelection).toHaveBeenCalledOnce();
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(
      prepareAfterSelection.mock.invocationCallOrder[0],
    );
    expect(prepareAfterSelection.mock.invocationCallOrder[0]).toBeLessThan(
      progress.mock.invocationCallOrder[0],
    );
    expect(progress.mock.calls[0]).toEqual(["importing", 0, 0]);
    expect(progress.mock.calls.at(-1)).toEqual(["importing", 1, 1]);
  });

  it("starts progress only after a native directory handle is provided", async () => {
    const handle = new MemoryDirectoryHandle("game");
    const progress = vi.fn();
    const submitted = vi.fn();
    const requestPermission = vi.fn(async () => "granted" as PermissionState);
    Object.assign(handle, { requestPermission });
    const prepareAfterSelection = vi.fn(async () => {});
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => handle),
    );

    await expect(
      pickBrowserDirectory(progress, submitted, prepareAfterSelection),
    ).resolves.toMatchObject({ handle, persistHandle: true });

    expect(progress).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(prepareAfterSelection).toHaveBeenCalledOnce();
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(
      requestPermission.mock.invocationCallOrder[0],
    );
    expect(requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      prepareAfterSelection.mock.invocationCallOrder[0],
    );
    expect(prepareAfterSelection.mock.invocationCallOrder[0]).toBeLessThan(
      progress.mock.invocationCallOrder[0],
    );
    expect(progress).toHaveBeenCalledWith("scanning", 0, 0);
  });

  it("keeps selected source files out of OPFS while exposing them through the project view", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const picked = await importBrowserDirectory(
      [projectFile("game/ERB/main.erb", "@SYSTEM_TITLE\nRETURN\n")],
      storage as any,
    );

    const stored = await importedStorageProject(storage);
    await expect(stored.getDirectoryHandle("ERB")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    const erb = await (picked.handle as any).getDirectoryHandle("ERB");
    await expect(erb.getFileHandle("main.erb")).resolves.toBeDefined();
    await expect((picked.handle as any).getDirectoryHandle(".rustyera")).resolves.toBeDefined();
  });

  it("returns a runtime manifest from the bytes already read during import", async () => {
    const storage = new MemoryDirectoryHandle("root");

    const picked = await importBrowserDirectory(
      [projectFile("game/ERB/main.erb", "@SYSTEM_TITLE\nRETURN\n")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    expect(picked.manifest?.files).toEqual([
      expect.objectContaining({
        relative_path: "ERB/main.erb",
        category: "erb",
        payload: { type: "utf8", value: "@SYSTEM_TITLE\nRETURN\n" },
      }),
    ]);
    expect((await importedStorageProject(storage)).entriesCalls).toBe(1);
  });

  it("uses a short-lived scan worker batch for portable imports", async () => {
    const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
    class ScanWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: (event: ErrorEvent) => void;
      onmessageerror?: (event: MessageEvent) => void;
      readonly terminate = vi.fn();

      constructor() {
        workers.push(this);
      }

      postMessage(message: any) {
        void message.file.arrayBuffer().then((buffer: ArrayBuffer) => {
          this.onmessage?.({
            data: {
              id: message.id,
              ok: true,
              result: scanBrowserProjectFile(
                message.relativePath,
                new Uint8Array(buffer),
                new Set(message.topLevel),
              ),
            },
          } as MessageEvent);
        });
      }
    }
    vi.stubGlobal("Worker", ScanWorker);
    const storage = new MemoryDirectoryHandle("root");

    const picked = await importBrowserDirectory(
      [projectFile("game/ERB/main.erb", "@SYSTEM_TITLE\nRETURN\n")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    expect(picked.manifest?.files).toHaveLength(1);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("returns the same manifest as scanning the final imported directory", async () => {
    const storage = new MemoryDirectoryHandle("root");
    await importBrowserDirectory(
      [projectFile("game/data/override.erb", "@OLD\nRETURN\n")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    const picked = await importBrowserDirectory(
      [
        projectFile("game/data/override.erb", "@NEW\nRETURN\n"),
        projectFile("game/.rustyera/private.config", "FontSize:99\n"),
      ],
      storage as unknown as FileSystemDirectoryHandle,
    );
    const scanned = await new BrowserProject(picked.handle).scan();

    expect(picked.manifest).toEqual(scanned);
    expect(picked.manifest?.files).toEqual([
      expect.objectContaining({
        relative_path: "data/override.erb",
        payload: { type: "utf8", value: "@OLD\nRETURN\n" },
      }),
    ]);
  });

  it("removes legacy OPFS source copies before overlaying a new selection", async () => {
    const storage = new MemoryDirectoryHandle("root");
    await importBrowserDirectory(
      [projectFile("game/ERB/initial.erb", "@INITIAL\nRETURN\n")],
      storage as unknown as FileSystemDirectoryHandle,
    );
    const stored = await importedStorageProject(storage);
    const erb = await stored.getDirectoryHandle("ERB", { create: true });
    const legacy = await erb.getFileHandle("main.erb", { create: true });
    await (await legacy.createWritable()).write(new TextEncoder().encode("@OLD\nRETURN\n"));
    const privateDirectory = await stored.getDirectoryHandle(".rustyera");
    const sourceManifest = await privateDirectory.getFileHandle("imported-sources.json");
    await (
      await sourceManifest.createWritable()
    ).write(new TextEncoder().encode('["ERB/main.erb"]'));

    const picked = await importBrowserDirectory(
      [projectFile("game/ERB/main.erb", "@NEW\nRETURN\n")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    expect(picked.manifest?.files[0].payload).toEqual({
      type: "utf8",
      value: "@NEW\nRETURN\n",
    });
    await expect(erb.getFileHandle("main.erb")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("reads selected resources lazily and copies configuration writes into OPFS", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const configuration = projectFile("game/emuera.config", "FontSize:18\n");
    const picked = await importBrowserDirectory(
      [configuration, projectFile("game/resources/title.png", "image-bytes")],
      storage as unknown as FileSystemDirectoryHandle,
    );
    const project = new BrowserProject(picked.handle, 1, picked.projectName);
    project.useImportedManifest(picked.manifest!);

    await expect(
      project.readResourcePrefix("RESOURCES/TITLE.PNG", 5).then((bytes) => [...bytes]),
    ).resolves.toEqual([...new TextEncoder().encode("image")]);
    await project.writeConfiguration(new Uint8Array(), "[text]\nfont_size = 20\n");

    expect(await configuration.text()).toBe("FontSize:18\n");
    const rescanned = await project.scan();
    expect(rescanned.files.find((file) => file.relative_path === "emuera.config")?.payload).toEqual(
      {
        type: "utf8",
        value: "FontSize:18\n",
      },
    );
    expect(
      rescanned.files.find((file) => file.relative_path === "reraconfig.toml")?.payload,
    ).toEqual({
      type: "utf8",
      value: "[text]\nfont_size = 20\n",
    });
  });

  it("lets an existing OPFS entry win over a conflicting selected directory", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const picked = await importBrowserDirectory(
      [projectFile("game/resources/title.png", "image-bytes")],
      storage as unknown as FileSystemDirectoryHandle,
    );
    const stored = await importedStorageProject(storage);
    const conflict = await stored.getFileHandle("resources", { create: true });
    await (await conflict.createWritable()).write(new TextEncoder().encode("runtime-owned"));

    await expect(picked.handle.getDirectoryHandle("resources")).rejects.toMatchObject({
      name: "TypeMismatchError",
    });
  });

  it("returns no directory when either browser picker is cancelled", async () => {
    vi.stubGlobal("showDirectoryPicker", async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(pickBrowserDirectory()).resolves.toBeUndefined();

    const storage = new MemoryDirectoryHandle("root");
    vi.stubGlobal("showDirectoryPicker", undefined);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const selection = pickBrowserDirectory();
    document
      .querySelector<HTMLInputElement>('input[type="file"]')!
      .dispatchEvent(new Event("cancel"));

    await expect(selection).resolves.toBeUndefined();
  });

  it("does not import selected directory files when session preparation fails", async () => {
    const storage = new MemoryDirectoryHandle("root");
    vi.stubGlobal("showDirectoryPicker", undefined);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } });
    const progress = vi.fn();
    const submitted = vi.fn();
    const selection = pickBrowserDirectory(progress, submitted, async () => {
      throw new Error("session failed");
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [projectFile("game/ERB/main.erb")] });

    input.dispatchEvent(new Event("change"));

    await expect(selection).rejects.toThrow("session failed");
    expect(submitted).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalled();
    await expect(storage.getDirectoryHandle(".rustyera-imports")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("settles a cancelled snapshot file selection", async () => {
    const selection = pickBrowserFile(".snapshot");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".snapshot");

    input.dispatchEvent(new Event("cancel"));

    await expect(selection).resolves.toBeUndefined();
  });

  it("keeps a selected upload mounted until its provider-backed bytes finish reading", async () => {
    let finishRead!: (value: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((resolve) => (finishRead = resolve));
    const file = { arrayBuffer: vi.fn(() => bytes) } as unknown as File;
    const selection = pickBrowserFileBytes(".snapshot");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });

    input.dispatchEvent(new Event("change"));

    expect(document.body.contains(input)).toBe(true);
    input.dispatchEvent(new Event("cancel"));
    expect(document.body.contains(input)).toBe(true);
    finishRead(Uint8Array.of(1, 2, 3).buffer);
    await expect(selection).resolves.toEqual(Uint8Array.of(1, 2, 3));
    expect(document.body.contains(input)).toBe(false);
  });

  it("preserves provider read failures and removes the owning upload", async () => {
    const failure = { reason: "provider unavailable" };
    const file = { arrayBuffer: vi.fn(() => Promise.reject(failure)) } as unknown as File;
    const selection = pickBrowserFileBytes(".snapshot");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });

    input.dispatchEvent(new Event("change"));

    await expect(selection).rejects.toBe(failure);
    expect(document.body.contains(input)).toBe(false);
  });

  it("cleans up when a provider throws before returning its read promise", async () => {
    const failure = { reason: "provider read failed synchronously" };
    const file = {
      arrayBuffer: vi.fn(() => {
        throw failure;
      }),
    } as unknown as File;
    const selection = pickBrowserFileBytes(".snapshot");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });

    input.dispatchEvent(new Event("change"));

    await expect(selection).rejects.toBe(failure);
    expect(document.body.contains(input)).toBe(false);
  });

  it("requests a read-write handle for a directly editable project file", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "game.reraproj");
    const handle = {
      getFile: vi.fn(async () => file),
      requestPermission: vi.fn(async () => "granted" as PermissionState),
    };
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn(async () => [handle]),
    );

    await expect(pickBrowserProjectFile()).resolves.toEqual({ file, handle });
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("falls back to an importable file when direct write permission is denied", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "game.reraproj");
    const handle = {
      getFile: vi.fn(async () => file),
      requestPermission: vi.fn(async () => "denied" as PermissionState),
    };
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn(async () => [handle]),
    );

    await expect(pickBrowserProjectFile()).resolves.toEqual({ file });
  });

  it("strips the shared directory name while retaining nested project paths", () => {
    const result = selectedProjectFiles([
      projectFile("eraTW/CSV/GAMEBASE.csv"),
      projectFile("eraTW/ERB/title.erb"),
    ]);

    expect(result.projectName).toBe("eraTW");
    expect(result.files.map((entry) => entry.path)).toEqual(["CSV/GAMEBASE.csv", "ERB/title.erb"]);
  });

  it("rejects directory traversal from picker metadata", () => {
    expect(() => selectedProjectFiles([projectFile("eraTW/../outside.erb")])).toThrow(
      "路径必须位于项目目录内",
    );
  });

  it("rejects files from different selected directory roots", () => {
    expect(() =>
      selectedProjectFiles([
        projectFile("first/ERB/main.erb"),
        projectFile("second/CSV/GAMEBASE.csv"),
      ]),
    ).toThrow("所选文件必须来自同一个项目目录");
  });

  it("rejects duplicate normalized paths before concurrent import", () => {
    expect(() =>
      selectedProjectFiles([projectFile("game/ERB/main.erb"), projectFile("game/ERB/main.erb")]),
    ).toThrow("重复");
  });

  it("refreshes source files without overwriting browser-persisted saves", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const first = await importBrowserDirectory(
      [projectFile("game/ERB/old.erb", "old"), projectFile("game/sav/save01.dat", "original")],
      storage as unknown as FileSystemDirectoryHandle,
    );
    const project = first.handle as unknown as MemoryDirectoryHandle;
    const saves = await project.getDirectoryHandle("sav");
    const save = await saves.getFileHandle("save01.dat");
    const writer = await save.createWritable();
    await writer.write(new TextEncoder().encode("browser"));
    await writer.close();

    const second = await importBrowserDirectory(
      [projectFile("game/ERB/new.erb", "new"), projectFile("game/sav/save01.dat", "original")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    const scripts = await (second.handle as unknown as MemoryDirectoryHandle).getDirectoryHandle(
      "ERB",
    );
    await expect(scripts.getFileHandle("old.erb")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(
      await (await scripts.getFileHandle("new.erb")).getFile().then((file) => file.text()),
    ).toBe("new");
    expect(await save.getFile().then((file) => file.text())).toBe("browser");
  });

  it("reports each imported file before browser project scanning begins", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const progress = vi.fn();

    await importBrowserDirectory(
      [projectFile("game/ERB/main.erb"), projectFile("game/CSV/GAMEBASE.csv")],
      storage as unknown as FileSystemDirectoryHandle,
      progress,
    );

    expect(progress.mock.calls).toEqual([
      ["importing", 0, 0],
      ["importing", 0, 2],
      ["importing", 1, 2],
      ["importing", 2, 2],
    ]);
  });
});
