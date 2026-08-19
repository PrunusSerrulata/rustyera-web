type SessionEntry = SessionDirectoryHandle | SessionFileHandle;

/**
 * Creates a session-only project directory for browsers where OPFS is unavailable.
 *
 * Packaged projects keep their source bytes in the selected `File` and only need a small writable
 * filesystem for saves and runtime storage. Compiled-cache export is disabled separately so this
 * fallback cannot retain another large project-sized buffer in memory.
 */
export function createBrowserSessionDirectory(name: string): FileSystemDirectoryHandle {
  return new SessionDirectoryHandle(name) as unknown as FileSystemDirectoryHandle;
}

class SessionDirectoryHandle {
  readonly kind = "directory" as const;
  private readonly entriesByName = new Map<string, SessionEntry>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.entriesByName.get(name);
    if (existing instanceof SessionDirectoryHandle)
      return existing as unknown as FileSystemDirectoryHandle;
    if (existing) throw new DOMException("Entry is not a directory", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Directory was not found", "NotFoundError");
    const directory = new SessionDirectoryHandle(name);
    this.entriesByName.set(name, directory);
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<FileSystemFileHandle> {
    const existing = this.entriesByName.get(name);
    if (existing instanceof SessionFileHandle) return existing as unknown as FileSystemFileHandle;
    if (existing) throw new DOMException("Entry is not a file", "TypeMismatchError");
    if (!options?.create) throw new DOMException("File was not found", "NotFoundError");
    const file = new SessionFileHandle(name);
    this.entriesByName.set(name, file);
    return file as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const existing = this.entriesByName.get(name);
    if (!existing) throw new DOMException("Entry was not found", "NotFoundError");
    if (
      existing instanceof SessionDirectoryHandle &&
      existing.entriesByName.size > 0 &&
      !options?.recursive
    ) {
      throw new DOMException("Directory is not empty", "InvalidModificationError");
    }
    this.entriesByName.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
    for (const [name, entry] of this.entriesByName) {
      yield [name, entry as unknown as FileSystemHandle];
    }
  }
}

class SessionFileHandle {
  readonly kind = "file" as const;
  private bytes = new Uint8Array();
  private lastModified = Date.now();

  constructor(readonly name: string) {}

  getFile(): Promise<File> {
    const snapshot = this.bytes.slice();
    const file = new File([snapshot], this.name, { lastModified: this.lastModified });
    Object.defineProperties(file, {
      arrayBuffer: { value: async () => snapshot.buffer.slice(0) },
      text: { value: async () => new TextDecoder().decode(snapshot) },
      slice: {
        value: (start = 0, end = snapshot.byteLength, type = "") =>
          sessionBlob(snapshot.slice(start, end), type),
      },
    });
    return Promise.resolve(file);
  }

  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    const initial = options?.keepExistingData ? this.bytes.slice() : new Uint8Array();
    return Promise.resolve(
      new SessionWritableFileStream(initial, (bytes) => {
        this.bytes = bytes;
        this.lastModified = Math.max(Date.now(), this.lastModified + 1);
      }) as unknown as FileSystemWritableFileStream,
    );
  }
}

class SessionWritableFileStream {
  private cursor = 0;
  private closed = false;

  constructor(
    private bytes: Uint8Array<ArrayBuffer>,
    private readonly commit: (bytes: Uint8Array<ArrayBuffer>) => void,
  ) {}

  async write(chunk: FileSystemWriteChunkType): Promise<void> {
    this.assertOpen();
    if (isWriteCommand(chunk)) {
      if (chunk.type === "seek") {
        if (chunk.position == null) throw new TypeError("Missing seek position");
        await this.seek(chunk.position);
        return;
      }
      if (chunk.type === "truncate") {
        if (chunk.size == null) throw new TypeError("Missing truncate size");
        await this.truncate(chunk.size);
        return;
      }
      if (chunk.position != null) this.cursor = checkedPosition(chunk.position);
      if (chunk.data == null) throw new TypeError("Missing file write data");
      chunk = chunk.data;
    }
    const data = await chunkBytes(chunk);
    const end = this.cursor + data.byteLength;
    if (!Number.isSafeInteger(end))
      throw new DOMException("File is too large", "QuotaExceededError");
    if (end > this.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(data, this.cursor);
    this.cursor = end;
  }

  seek(position: number): Promise<void> {
    this.assertOpen();
    this.cursor = checkedPosition(position);
    return Promise.resolve();
  }

  truncate(size: number): Promise<void> {
    this.assertOpen();
    const nextSize = checkedPosition(size);
    if (nextSize < this.bytes.byteLength) this.bytes = this.bytes.slice(0, nextSize);
    else if (nextSize > this.bytes.byteLength) {
      const grown = new Uint8Array(nextSize);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    if (this.cursor > nextSize) this.cursor = nextSize;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    this.commit(this.bytes);
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.closed) throw new DOMException("Writable stream is closed", "InvalidStateError");
  }
}

function isWriteCommand(chunk: FileSystemWriteChunkType): chunk is WriteParams {
  return (
    typeof chunk === "object" &&
    chunk != null &&
    "type" in chunk &&
    ["write", "seek", "truncate"].includes(String(chunk.type))
  );
}

async function chunkBytes(chunk: FileSystemWriteChunkType): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Blob) return new Uint8Array(await readBlobAsArrayBuffer(chunk));
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return Uint8Array.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  throw new TypeError("Unsupported session file write data");
}

function sessionBlob(bytes: Uint8Array, type = ""): Blob {
  const snapshot = bytes.slice();
  const blob = new Blob([snapshot], { type });
  Object.defineProperties(blob, {
    arrayBuffer: { value: async () => snapshot.buffer.slice(0) },
    text: { value: async () => new TextDecoder().decode(snapshot) },
  });
  return blob;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Session file read failed"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Session file read did not produce binary data"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function checkedPosition(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid file position");
  return value;
}
