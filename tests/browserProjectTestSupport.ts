export async function writeFixtureFile(
  directory: SaveDirectoryHandle,
  name: string,
  contents: Uint8Array | string,
): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  await (await file.createWritable()).write(bytes);
}

export class SaveFileHandle {
  readonly kind = "file";
  private lastModified = 1;
  reads = 0;

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
      write: async (bytes: Uint8Array) => {
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
      abort: async () => {},
    };
  }

  replacePreservingMetadata(bytes: Uint8Array): void {
    this.bytes = new Uint8Array(bytes);
  }
}

export class SaveDirectoryHandle {
  readonly kind = "directory";
  private readonly children = new Map<string, SaveDirectoryHandle | SaveFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof SaveDirectoryHandle) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const directory = new SaveDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing instanceof SaveFileHandle) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const file = new SaveFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async *entries() {
    yield* this.children.entries();
  }

  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException("missing", "NotFoundError");
  }
}

export class FailingIndexDirectoryHandle extends SaveDirectoryHandle {
  override async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (name === ".rustyera" && options?.create) {
      throw new DOMException("quota", "QuotaExceededError");
    }
    return super.getDirectoryHandle(name, options);
  }
}
