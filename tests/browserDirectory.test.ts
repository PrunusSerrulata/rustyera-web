import { afterEach, describe, expect, it, vi } from "vitest";

import {
  importBrowserDirectory,
  pickBrowserDirectory,
  pickBrowserFile,
  removeImportedProjectSources,
  selectedProjectFiles,
} from "@/platform/browserDirectory";

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

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectoryHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryDirectoryHandle) return child;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryDirectoryHandle(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    const child = this.children.get(name);
    if (child instanceof MemoryFileHandle) return child;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryFileHandle(name);
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }

  async *entries() {
    yield* this.children.entries();
  }
}

function projectFile(path: string, contents = ""): File {
  const file = new File([], path.split("/").at(-1)!);
  const bytes = new TextEncoder().encode(contents);
  Object.defineProperties(file, {
    webkitRelativePath: { value: path },
    arrayBuffer: { value: async () => bytes.buffer.slice(0) },
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
    const selection = pickBrowserDirectory(progress);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.webkitdirectory).toBe(true);
    const settled = vi.fn();
    void selection.then(settled, settled);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(input?.isConnected).toBe(true);
    Object.defineProperty(input, "files", { value: [projectFile("game/ERB/main.erb")] });
    input!.dispatchEvent(new Event("change"));

    await expect(selection).resolves.toMatchObject({ projectName: "game", persistHandle: false });
    expect(progress.mock.calls[0]).toEqual(["importing", 0, 0]);
    expect(progress.mock.calls.at(-1)).toEqual(["importing", 1, 1]);
  });

  it("starts progress only after a native directory handle is provided", async () => {
    const handle = new MemoryDirectoryHandle("game");
    const progress = vi.fn();
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => handle),
    );

    await expect(pickBrowserDirectory(progress)).resolves.toMatchObject({
      handle,
      persistHandle: true,
    });

    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith("scanning", 0, 0);
  });

  it("removes OPFS source copies after a project file has been built", async () => {
    const storage = new MemoryDirectoryHandle("root");
    const picked = await importBrowserDirectory(
      [projectFile("game/ERB/main.erb", "@SYSTEM_TITLE\nRETURN\n")],
      storage as any,
    );

    await removeImportedProjectSources(picked.handle);

    const erb = await (picked.handle as any).getDirectoryHandle("ERB");
    await expect(erb.getFileHandle("main.erb")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect((picked.handle as any).getDirectoryHandle(".rustyera")).resolves.toBeDefined();
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

  it("settles a cancelled snapshot file selection", async () => {
    const selection = pickBrowserFile(".snapshot");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".snapshot");

    input.dispatchEvent(new Event("cancel"));

    await expect(selection).resolves.toBeUndefined();
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

    await importBrowserDirectory(
      [projectFile("game/ERB/new.erb", "new"), projectFile("game/sav/save01.dat", "original")],
      storage as unknown as FileSystemDirectoryHandle,
    );

    const scripts = await project.getDirectoryHandle("ERB");
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
