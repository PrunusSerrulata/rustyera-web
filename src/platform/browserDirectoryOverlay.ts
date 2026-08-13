import {
  portableDirectoryTree,
  type PortableDirectoryNode,
} from "@/platform/browserDirectoryOverlay/tree";

export interface PortableBrowserFile {
  readonly path: string;
  readonly file: File;
}

/**
 * Present selected files as a read-only directory layer over the browser-owned OPFS project.
 *
 * Existing and newly written OPFS entries always win. A write through a selected-file handle is
 * copy-on-write: the original `File` remains untouched and every later lookup observes OPFS.
 */
export function overlayBrowserDirectory(
  storage: FileSystemDirectoryHandle,
  portableFiles: readonly PortableBrowserFile[],
): FileSystemDirectoryHandle {
  const root = portableDirectoryTree(portableFiles);
  return new OverlayDirectoryHandle(
    storage.name,
    async () => storage,
    root,
  ) as unknown as FileSystemDirectoryHandle;
}

type StorageDirectoryAccess = (create: boolean) => Promise<FileSystemDirectoryHandle | undefined>;

class OverlayDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    private readonly storage: StorageDirectoryAccess,
    private readonly portable: PortableDirectoryNode,
  ) {}

  async getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    const portable = this.portable.directories.get(name);
    const access = this.childStorage(name);
    if (portable) {
      const storage = await this.storage(false);
      if (storage) {
        try {
          await storage.getFileHandle(name);
          throw new DOMException(`Entry ${name} is a file`, "TypeMismatchError");
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      return new OverlayDirectoryHandle(
        name,
        access,
        portable,
      ) as unknown as FileSystemDirectoryHandle;
    }
    const storage = await access(options?.create ?? false);
    if (!storage) throw notFound(name);
    return storage;
  }

  async getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<FileSystemFileHandle> {
    const storage = await this.storage(false);
    if (storage) {
      try {
        return await storage.getFileHandle(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const portable = this.portable.files.get(name);
    if (portable) {
      return new OverlayFileHandle(this.storage, name, portable) as unknown as FileSystemFileHandle;
    }
    const writableStorage = storage ?? (await this.storage(options?.create ?? false));
    if (!writableStorage) throw notFound(name);
    return writableStorage.getFileHandle(name, options);
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const storage = await this.storage(false);
    if (!storage) throw notFound(name);
    return storage.removeEntry(name, options);
  }

  async *entries(): AsyncIterableIterator<
    [string, FileSystemFileHandle | FileSystemDirectoryHandle]
  > {
    const storageEntries = new Map<string, FileSystemFileHandle | FileSystemDirectoryHandle>();
    const storage = await this.storage(false);
    if (storage) {
      for await (const [name, handle] of storage.entries()) storageEntries.set(name, handle);
    }

    for (const [name, handle] of storageEntries) {
      const portable =
        handle.kind === "directory" ? this.portable.directories.get(name) : undefined;
      yield [
        name,
        portable
          ? (new OverlayDirectoryHandle(
              name,
              async () => handle as FileSystemDirectoryHandle,
              portable,
            ) as unknown as FileSystemDirectoryHandle)
          : handle,
      ];
    }
    for (const [name, portable] of this.portable.directories) {
      if (storageEntries.has(name)) continue;
      yield [
        name,
        new OverlayDirectoryHandle(
          name,
          this.childStorage(name),
          portable,
        ) as unknown as FileSystemDirectoryHandle,
      ];
    }
    for (const [name, file] of this.portable.files) {
      if (storageEntries.has(name)) continue;
      yield [
        name,
        new OverlayFileHandle(this.storage, name, file) as unknown as FileSystemFileHandle,
      ];
    }
  }

  private childStorage(name: string): StorageDirectoryAccess {
    return async (create) => {
      const parent = await this.storage(create);
      if (!parent) return undefined;
      try {
        return await parent.getDirectoryHandle(name, { create });
      } catch (error) {
        if (!create && isNotFound(error)) return undefined;
        throw error;
      }
    };
  }
}

class OverlayFileHandle {
  readonly kind = "file" as const;

  constructor(
    private readonly storage: StorageDirectoryAccess,
    readonly name: string,
    private readonly portable: File,
  ) {}

  async getFile(): Promise<File> {
    const storage = await this.storage(false);
    if (storage) {
      try {
        return await (await storage.getFileHandle(this.name)).getFile();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return this.portable;
  }

  async createWritable(
    options?: FileSystemCreateWritableOptions,
  ): Promise<FileSystemWritableFileStream> {
    const storage = await this.storage(true);
    if (!storage) throw new Error("无法创建项目写入目录");
    const handle = await storage.getFileHandle(this.name, { create: true });
    return handle.createWritable(options);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function notFound(name: string): DOMException {
  return new DOMException(`Entry ${name} was not found`, "NotFoundError");
}
