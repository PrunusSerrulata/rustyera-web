import { describe, expect, it } from "vitest";

import { importBrowserDirectory, selectedProjectFiles } from "@/platform/browserDirectory";

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
});
