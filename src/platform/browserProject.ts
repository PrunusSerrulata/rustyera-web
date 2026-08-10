import { blake3 } from "@noble/hashes/blake3.js";

import { isPackagedProjectFontPath, type ProjectFontSource } from "@/platform/projectFonts";

const RESOURCE_SUFFIXES = new Set([
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
  "wav",
  "mp3",
  "ogg",
  "opus",
  "aac",
  "m4a",
  "flac",
]);
const AUDIO_SUFFIXES = new Set(["wav", "mp3", "ogg", "opus", "aac", "m4a", "flac"]);
const FONT_SUFFIXES = new Set(["otf", "ttc", "ttf", "woff", "woff2"]);
const SOURCE_INDEX_VERSION = 1;
const SOURCE_INDEX_NAME = "source-index-v1.json";

export interface ScannedFile {
  relative_path: string;
  category: string;
  payload: { type: "utf8"; value: string } | { type: "bytes"; value: Uint8Array };
  content_hash: Uint8Array;
}

export interface BrowserTraditionalSaveSlot {
  slot: number;
  occupied: boolean;
}

export interface BrowserManifest {
  project_revision: number;
  files: ScannedFile[];
}

export type FileScanProgress = (completed: number, total: number) => void;
export type ProjectConfigurationUpdatePreparer = (
  projectFile: Uint8Array,
  expectedDigest: Uint8Array,
  contents: string,
) => Promise<Uint8Array>;

interface BrowserSourceIndexEntry {
  category: string;
  signature: string;
  hash: string;
  size: number;
}

interface PendingBrowserFile {
  relativePath: string;
  category: string;
  handle: FileSystemFileHandle;
  signature: string;
  prepared?: ScannedFile;
}

interface PendingBrowserSnapshot {
  files: PendingBrowserFile[];
  topLevel: Set<string>;
}

export class BrowserProject {
  private readonly files = new Map<string, FileSystemFileHandle>();
  private readonly embeddedResources = new Map<string, Uint8Array>();
  private readonly canonicalPaths = new Map<string, string>();
  private usesEmbeddedManifest = false;
  private manifestValue?: BrowserManifest;
  private pendingSnapshot?: PendingBrowserSnapshot;
  private packagedFile?: File;
  private packagedHandle?: FileSystemFileHandle;
  private prepareConfigurationUpdate?: ProjectConfigurationUpdatePreparer;
  private importedSnapshot = false;
  private runtimeManifestSparse = false;

  constructor(
    readonly root: FileSystemDirectoryHandle,
    private revision = 1,
    readonly name = root.name,
    private readonly sourceIndexTrusted = false,
  ) {}

  useEmbeddedManifest(manifest: BrowserManifest): void {
    this.revision = manifest.project_revision;
    this.embeddedResources.clear();
    this.usesEmbeddedManifest = true;
    for (const file of manifest.files) {
      if (file.category === "resource" && file.payload.type === "bytes") {
        this.embeddedResources.set(
          safePath(file.relative_path).toLowerCase(),
          new Uint8Array(file.payload.value as Uint8Array),
        );
      }
    }
    this.manifestValue = cacheIdentityManifest(manifest);
  }

  usePackagedFile(
    file: File,
    handle?: FileSystemFileHandle,
    prepareConfigurationUpdate?: ProjectConfigurationUpdatePreparer,
  ): void {
    this.packagedFile = file;
    this.packagedHandle = handle;
    if (prepareConfigurationUpdate) this.prepareConfigurationUpdate = prepareConfigurationUpdate;
  }

  useConfigurationUpdatePreparer(prepare: ProjectConfigurationUpdatePreparer): void {
    this.prepareConfigurationUpdate = prepare;
  }

  useImportedManifest(manifest: BrowserManifest): void {
    this.importedSnapshot = true;
    this.canonicalPaths.clear();
    for (const file of manifest.files) {
      this.canonicalPaths.set(file.relative_path.toLowerCase(), file.relative_path);
    }
    this.manifestValue = manifest;
  }

  importedManifest(): BrowserManifest | undefined {
    return this.importedSnapshot ? this.manifestValue : undefined;
  }

  embeddedManifest(): BrowserManifest | undefined {
    return this.usesEmbeddedManifest ? this.manifestValue : undefined;
  }

  markRuntimeManifestSparse(): void {
    this.runtimeManifestSparse = true;
  }

  configurationWritable(): boolean {
    return (
      !this.usesEmbeddedManifest || Boolean(this.packagedHandle && this.prepareConfigurationUpdate)
    );
  }

  async writeConfiguration(expectedDigest: Uint8Array, contents: string): Promise<void> {
    if (!this.configurationWritable()) throw new Error("当前浏览器无法直接修改项目文件");
    if (this.usesEmbeddedManifest) {
      await this.writePackagedConfiguration(expectedDigest, contents);
      return;
    }
    let handle =
      this.files.get("reraconfig.toml") ??
      (await optionalFileHandle(this.root, ["reraconfig.toml"]));
    let currentDigest = new Uint8Array();
    if (handle) {
      const file = await handle.getFile();
      const text = decodeProjectSource(new Uint8Array(await file.arrayBuffer()), "reraconfig.toml");
      currentDigest = blake3(new TextEncoder().encode(normalizeLineEndings(text)));
    }
    const requestedDigest = blake3(new TextEncoder().encode(normalizeLineEndings(contents)));
    if (equalBytes(currentDigest, requestedDigest)) return;
    if (!equalBytes(currentDigest, expectedDigest))
      throw new Error("reraconfig.toml 已被其他程序修改，请重新打开设置窗口");
    handle ??= await this.root.getFileHandle("reraconfig.toml", { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      await writer.write(
        new TextEncoder().encode(nativeLineEndings(contents)) as FileSystemWriteChunkType,
      );
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    this.files.set("reraconfig.toml", handle);
    this.manifestValue = undefined;
    await this.invalidateCompiledCache();
  }

  private async writePackagedConfiguration(
    expectedDigest: Uint8Array,
    contents: string,
  ): Promise<void> {
    const handle = this.packagedHandle;
    const prepare = this.prepareConfigurationUpdate;
    if (!handle || !prepare) throw new Error("当前浏览器无法直接修改项目文件");
    const current = await handle.getFile();
    const projectBytes = new Uint8Array(await current.arrayBuffer());
    const projectDigest = blake3(projectBytes);
    const update = await prepare(projectBytes, expectedDigest, contents);
    await applyProjectFileUpdate(handle, current.size, projectDigest, update);
    this.packagedFile = await handle.getFile();
    this.updateEmbeddedConfiguration(contents);
  }

  async invalidateCompiledCache(): Promise<void> {
    try {
      const privateDirectory = await this.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      await cacheDirectory.removeEntry("compiled-project.reracache");
    } catch {
      // The cache is derived data. A stale survivor is rejected by its project identity later.
    }
  }

  private updateEmbeddedConfiguration(contents: string): void {
    const manifest = this.manifestValue;
    if (!manifest) return;
    const source = normalizeLineEndings(contents);
    const contentHash = blake3(new TextEncoder().encode(source));
    const existing = manifest.files.find(
      (file) =>
        file.category === "configuration" &&
        file.relative_path.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml",
    );
    if (existing) {
      existing.payload = { type: "utf8", value: source };
      existing.content_hash = contentHash;
      return;
    }
    manifest.files.push({
      relative_path: "reraconfig.toml",
      category: "configuration",
      payload: { type: "utf8", value: source },
      content_hash: contentHash,
    });
  }

  async scan(
    progress?: FileScanProgress,
    preloaded?: ReadonlyMap<string, ScannedFile>,
    signal?: AbortSignal,
  ): Promise<BrowserManifest> {
    throwIfAborted(signal);
    this.files.clear();
    progress?.(0, 0);
    const topLevel = new Set<string>();
    for await (const [name, handle] of this.root.entries()) {
      if (handle.kind === "directory" && name.toLowerCase() !== ".rustyera") {
        topLevel.add(name.toLowerCase());
      }
    }
    const files: ScannedFile[] = [];
    const reads: Array<() => Promise<void>> = [];
    await this.walk(this.root, "", topLevel, files, reads, preloaded);
    progress?.(0, reads.length);
    await runBounded(reads, 8, progress, signal);
    files.sort(compareScannedFiles);
    this.manifestValue = { project_revision: this.revision, files };
    this.pendingSnapshot = undefined;
    return this.manifestValue;
  }

  async scanQuick(progress?: FileScanProgress): Promise<BrowserManifest> {
    this.files.clear();
    progress?.(0, 0);
    const topLevel = new Set<string>();
    for await (const [name, handle] of this.root.entries()) {
      if (handle.kind === "directory" && name.toLowerCase() !== ".rustyera") {
        topLevel.add(name.toLowerCase());
      }
    }
    const candidates: Array<{
      relativePath: string;
      category: string;
      handle: FileSystemFileHandle;
    }> = [];
    await this.walkHandles(this.root, "", topLevel, candidates);
    candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    // File.size/lastModified is only a safe identity shortcut for the app-owned imported copy.
    // A user-controlled directory can preserve both values while replacing its contents.
    const previous = this.sourceIndexTrusted ? await this.readSourceIndex() : {};
    const pending = new Array<PendingBrowserFile>(candidates.length);
    const files = new Array<ScannedFile>(candidates.length);
    const indexEntries = new Array<[string, BrowserSourceIndexEntry]>(candidates.length);
    progress?.(0, candidates.length);
    await runBounded(
      candidates.map((candidate, index) => async () => {
        const file = await candidate.handle.getFile();
        const signature = `${file.size}:${file.lastModified}`;
        const prior = previous[candidate.relativePath];
        let scanned: ScannedFile;
        let prepared: ScannedFile | undefined;
        if (
          isBrowserSourceIndexEntry(prior) &&
          prior.category === candidate.category &&
          prior.signature === signature &&
          prior.size === file.size &&
          /^[0-9a-f]{64}$/i.test(prior.hash)
        ) {
          scanned = {
            relative_path: candidate.relativePath,
            category: candidate.category,
            payload: emptyPayload(candidate.category),
            content_hash: decodeHex(prior.hash),
          };
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          prepared = scanBrowserProjectFile(candidate.relativePath, bytes, topLevel);
          if (!prepared) throw new Error(`无法分类项目文件：${candidate.relativePath}`);
          scanned = prepared;
        }
        files[index] = scanned;
        pending[index] = { ...candidate, signature, prepared };
        indexEntries[index] = [
          candidate.relativePath,
          {
            category: candidate.category,
            signature,
            hash: hex(scanned.content_hash),
            size: file.size,
          },
        ];
      }),
      8,
      progress,
    );
    const next = Object.fromEntries(indexEntries);
    if (this.sourceIndexTrusted && !sourceIndexesEqual(previous, next)) {
      await this.writeSourceIndex(next).catch(() => undefined);
    }
    files.sort(compareScannedFiles);
    pending.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    this.pendingSnapshot = { files: pending, topLevel };
    this.manifestValue = { project_revision: this.revision, files };
    return this.manifestValue;
  }

  async materialize(progress?: FileScanProgress, signal?: AbortSignal): Promise<BrowserManifest> {
    throwIfAborted(signal);
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return this.manifestValue ?? this.scan(progress, undefined, signal);
    this.files.clear();
    const topLevel = new Set<string>();
    for await (const [name, handle] of this.root.entries()) {
      if (handle.kind === "directory" && name.toLowerCase() !== ".rustyera") {
        topLevel.add(name.toLowerCase());
      }
    }
    const current: Array<{
      relativePath: string;
      category: string;
      handle: FileSystemFileHandle;
    }> = [];
    await this.walkHandles(this.root, "", topLevel, current);
    current.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    if (
      !equalStringSets(snapshot.topLevel, topLevel) ||
      current.length !== snapshot.files.length ||
      current.some(
        (entry, index) =>
          entry.relativePath !== snapshot.files[index]?.relativePath ||
          entry.category !== snapshot.files[index]?.category,
      )
    ) {
      return this.scan(progress, undefined, signal);
    }
    const currentFiles = new Array<File>(current.length);
    await runBounded(
      current.map((entry, index) => async () => {
        currentFiles[index] = await entry.handle.getFile();
      }),
      8,
      undefined,
      signal,
    );
    if (
      currentFiles.some(
        (file, index) => `${file.size}:${file.lastModified}` !== snapshot.files[index]?.signature,
      )
    ) {
      return this.scan(progress, undefined, signal);
    }
    const files = new Array<ScannedFile>(snapshot.files.length);
    progress?.(0, snapshot.files.length);
    await runBounded(
      snapshot.files.map((pending, index) => async () => {
        if (pending.prepared) {
          files[index] = pending.prepared;
          return;
        }
        const entry = current[index];
        const bytes = new Uint8Array(await currentFiles[index].arrayBuffer());
        const scanned = scanBrowserProjectFile(entry.relativePath, bytes, topLevel);
        if (!scanned || scanned.category !== entry.category) {
          throw new Error(`项目文件在读取期间发生变化：${entry.relativePath}`);
        }
        files[index] = scanned;
      }),
      8,
      progress,
      signal,
    );
    files.sort(compareScannedFiles);
    this.pendingSnapshot = undefined;
    this.manifestValue = { project_revision: this.revision, files };
    return this.manifestValue;
  }

  async readCompiledCache(progress?: FileScanProgress): Promise<Uint8Array | undefined> {
    if (this.packagedHandle) return readFileInChunks(await this.packagedHandle.getFile(), progress);
    if (this.packagedFile) return readFileInChunks(this.packagedFile, progress);
    try {
      const privateDirectory = await this.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      const handle = await cacheDirectory.getFileHandle("compiled-project.reracache");
      return readFileInChunks(await handle.getFile(), progress);
    } catch (error) {
      if (errorKind(error) === "not_found") return undefined;
      throw error;
    }
  }

  async reloadRequest(progress?: FileScanProgress): Promise<any> {
    if (this.embeddedManifest()) throw new Error("项目文件不包含可热重载的外部源码目录");
    const previous = this.manifestValue ?? (await this.scan(progress));
    this.revision += 1;
    const current = await this.scan(progress);
    const oldByPath = new Map(previous.files.map((file) => [file.relative_path, file]));
    const newByPath = new Map(current.files.map((file) => [file.relative_path, file]));
    const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort();
    const changes: any[] = [];
    if (this.runtimeManifestSparse) {
      this.runtimeManifestSparse = false;
      return {
        base_revision: previous.project_revision,
        target_revision: current.project_revision,
        changes: current.files.map((file) => ({ type: "upsert", file })),
      };
    }
    for (const path of paths) {
      const oldFile = oldByPath.get(path);
      const newFile = newByPath.get(path);
      if (
        oldFile &&
        newFile &&
        oldFile.category === newFile.category &&
        equalBytes(oldFile.content_hash, newFile.content_hash)
      ) {
        continue;
      }
      if (newFile) changes.push({ type: "upsert", file: newFile });
      else if (oldFile)
        changes.push({
          type: "remove",
          category: oldFile.category,
          relative_path: oldFile.relative_path,
        });
    }
    return {
      base_revision: previous.project_revision,
      target_revision: current.project_revision,
      changes,
    };
  }

  async readResource(relativePath: string): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return new Uint8Array(embedded);
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async readResourcePrefix(relativePath: string, maximumBytes: number): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return embedded.slice(0, maximumBytes);
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const file = await handle.getFile();
    return new Uint8Array(await file.slice(0, maximumBytes).arrayBuffer());
  }

  fontSources(): ProjectFontSource[] {
    return (this.manifestValue?.files ?? [])
      .filter(
        (file) => file.category === "resource" && isPackagedProjectFontPath(file.relative_path),
      )
      .map((file) => ({
        relativePath: file.relative_path,
        contentHash: new Uint8Array(file.content_hash),
        read: () => this.readResource(file.relative_path),
      }));
  }

  async listTraditionalSaveSlots(slotCount: number): Promise<BrowserTraditionalSaveSlot[]> {
    const count = checkedSaveSlotCount(slotCount);
    const directory = await this.root.getDirectoryHandle("sav", { create: true });
    const occupied = new Set<number>();
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const match = /^save(\d{2})\.sav$/i.exec(name);
      if (!match) continue;
      const slot = Number.parseInt(match[1], 10);
      if (slot < count) occupied.add(slot);
    }
    return Array.from({ length: count }, (_, slot) => ({ slot, occupied: occupied.has(slot) }));
  }

  async readTraditionalSave(slot: number): Promise<Uint8Array> {
    const directory = await this.root.getDirectoryHandle("sav");
    const handle = await directory.getFileHandle(saveSlotName(slot));
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async writeTraditionalSave(slot: number, bytes: Uint8Array): Promise<void> {
    const directory = await this.root.getDirectoryHandle("sav", { create: true });
    const handle = await directory.getFileHandle(saveSlotName(slot), { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(bytes as FileSystemWriteChunkType);
    await writable.close();
  }

  async storage(request: any): Promise<any> {
    try {
      const root = await this.namespace(request.namespace);
      const parts = request.relative_path ? safePath(request.relative_path).split("/") : [];
      const operation = request.operation;
      let result: any;
      if (operation.type === "read") {
        const file = await getFile(root, parts);
        const bytes = new Uint8Array(await file.arrayBuffer());
        result = { type: "read", data: [...bytes], revision: hex(blake3(bytes)) };
      } else if (operation.type === "write") {
        // A missing precondition must be checked before creating the destination. Creating the
        // handle first leaves a zero-byte save behind and then makes the precondition fail.
        const existingHandle = await optionalFileHandle(root, parts);
        const current = existingHandle ? await existingHandle.getFile() : undefined;
        await checkPrecondition(current, operation.precondition);
        const handle = existingHandle ?? (await getFileHandle(root, parts, true));
        const writable = await handle.createWritable({ keepExistingData: false });
        const bytes = decodeProtocolBytes(operation.data);
        await writable.write(bytes as FileSystemWriteChunkType);
        await writable.close();
        result = { type: "written", revision: hex(blake3(bytes)) };
      } else if (operation.type === "delete") {
        const parent = await getDirectory(root, parts.slice(0, -1), false);
        const handle = await parent.getFileHandle(parts.at(-1)!);
        await checkPrecondition(await optionalFile(handle), operation.precondition);
        await parent.removeEntry(parts.at(-1)!);
        result = { type: "deleted" };
      } else if (operation.type === "stat") {
        const file = await getFile(root, parts);
        const bytes = new Uint8Array(await file.arrayBuffer());
        result = {
          type: "metadata",
          byte_length: file.size,
          revision: hex(blake3(bytes)),
        };
      } else if (operation.type === "read_range") {
        const file = await getFile(root, parts);
        const token = `${file.size}:${file.lastModified}`;
        if (operation.change_token && operation.change_token !== token) throw conflict();
        const offset = Number(operation.offset);
        const end = Math.min(file.size, offset + Number(operation.maximum_bytes));
        const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        result = {
          type: "read_chunk",
          data: [...data],
          offset: operation.offset,
          complete: end >= file.size,
          change_token: token,
        };
      } else if (operation.type === "list") {
        const directory = await getDirectory(root, parts, false);
        const entries: any[] = [];
        await collectEntries(directory, root, "", operation.recursive, operation.pattern, entries);
        result = { type: "listed", entries };
      } else {
        throw new Error(`不支持的存储操作：${operation.type}`);
      }
      return { request_id: request.request_id, result };
    } catch (error) {
      return {
        request_id: request.request_id,
        result: {
          type: "error",
          error: { kind: errorKind(error), message: String(error) },
        },
      };
    }
  }

  private async walk(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    topLevel: Set<string>,
    output: ScannedFile[],
    reads: Array<() => Promise<void>>,
    preloaded?: ReadonlyMap<string, ScannedFile>,
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      if (name.toLowerCase() === ".rustyera") continue;
      const relative = `${prefix}${name}`.normalize("NFC");
      if (handle.kind === "directory") {
        await this.walk(handle, `${relative}/`, topLevel, output, reads, preloaded);
        continue;
      }
      const category = classify(relative, topLevel);
      if (!category) continue;
      this.files.set(relative.toLowerCase(), handle);
      const prepared = preloaded?.get(relative);
      if (prepared) {
        output.push(prepared);
        continue;
      }
      reads.push(async () => {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        const scanned = scanBrowserProjectFile(relative, bytes, topLevel);
        if (scanned) output.push(scanned);
      });
    }
  }

  private async walkHandles(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    topLevel: Set<string>,
    output: Array<{
      relativePath: string;
      category: string;
      handle: FileSystemFileHandle;
    }>,
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      if (name.toLowerCase() === ".rustyera") continue;
      const relativePath = `${prefix}${name}`.normalize("NFC");
      if (handle.kind === "directory") {
        await this.walkHandles(handle, `${relativePath}/`, topLevel, output);
        continue;
      }
      const category = classify(relativePath, topLevel);
      if (!category) continue;
      this.files.set(relativePath.toLowerCase(), handle);
      output.push({ relativePath, category, handle });
    }
  }

  private async readSourceIndex(): Promise<Record<string, BrowserSourceIndexEntry>> {
    try {
      const privateDirectory = await this.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      const handle = await cacheDirectory.getFileHandle(SOURCE_INDEX_NAME);
      const value = JSON.parse(await (await handle.getFile()).text()) as {
        version?: unknown;
        files?: unknown;
      };
      return value.version === SOURCE_INDEX_VERSION && isRecord(value.files)
        ? (value.files as Record<string, BrowserSourceIndexEntry>)
        : {};
    } catch {
      return {};
    }
  }

  private async writeSourceIndex(files: Record<string, BrowserSourceIndexEntry>): Promise<void> {
    const privateDirectory = await this.root.getDirectoryHandle(".rustyera", { create: true });
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
    const handle = await cacheDirectory.getFileHandle(SOURCE_INDEX_NAME, { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      await writer.write(
        new TextEncoder().encode(
          JSON.stringify({ version: SOURCE_INDEX_VERSION, files }),
        ) as FileSystemWriteChunkType,
      );
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  private async namespace(namespace: string): Promise<FileSystemDirectoryHandle> {
    if (namespace === "resource") return this.root;
    return this.root.getDirectoryHandle(storageDirectoryName(namespace), { create: true });
  }
}

async function applyProjectFileUpdate(
  handle: FileSystemFileHandle,
  expectedSize: number,
  expectedDigest: Uint8Array,
  update: Uint8Array,
): Promise<void> {
  if (update.byteLength < 8) throw new Error("Runtime 返回了无效的项目配置更新");
  const truncate = Number(new DataView(update.buffer, update.byteOffset, 8).getBigUint64(0, true));
  if (!Number.isSafeInteger(truncate) || truncate < 0 || truncate > expectedSize)
    throw new Error("Runtime 返回了无效的项目配置更新位置");
  const current = await handle.getFile();
  if (
    current.size !== expectedSize ||
    !equalBytes(blake3(new Uint8Array(await current.arrayBuffer())), expectedDigest)
  )
    throw new Error("项目文件已被其他程序修改，请重试");
  const writer = await handle.createWritable({ keepExistingData: true });
  try {
    await writer.truncate(truncate);
    await writer.seek(truncate);
    await writer.write(update.subarray(8) as FileSystemWriteChunkType);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

async function readFileInChunks(file: File, progress?: FileScanProgress): Promise<Uint8Array> {
  progress?.(0, file.size);
  if (file.size === 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    progress?.(bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  const bytes = new Uint8Array(file.size);
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    bytes.set(chunk, offset);
    progress?.(Math.min(offset + chunk.byteLength, file.size), file.size);
  }
  return bytes;
}

export function saveSlotName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 99)
    throw new Error("存档槽位必须介于 00 和 99");
  return `save${slot.toString().padStart(2, "0")}.sav`;
}

function checkedSaveSlotCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("存档槽位数量无效");
  return value;
}

export function cacheIdentityManifest(manifest: BrowserManifest): BrowserManifest {
  return {
    project_revision: manifest.project_revision,
    files: manifest.files.map((file) => ({
      ...file,
      payload:
        file.category === "resource"
          ? { type: "bytes", value: new Uint8Array() }
          : { type: "utf8", value: "" },
    })),
  };
}

function emptyPayload(category: string): ScannedFile["payload"] {
  return category === "resource"
    ? { type: "bytes", value: new Uint8Array() }
    : { type: "utf8", value: "" };
}

function compareScannedFiles(left: ScannedFile, right: ScannedFile): number {
  return comparePaths(left.relative_path, right.relative_path);
}

function comparePaths(left: string, right: string): number {
  return (
    compareCodePoints(left.toLowerCase(), right.toLowerCase()) || compareCodePoints(left, right)
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftItem = leftPoints.next();
    const rightItem = rightPoints.next();
    if (leftItem.done || rightItem.done) {
      if (leftItem.done === rightItem.done) return 0;
      return leftItem.done ? -1 : 1;
    }
    const leftPoint = leftItem.value.codePointAt(0)!;
    const rightPoint = rightItem.value.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

function decodeHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrowserSourceIndexEntry(value: unknown): value is BrowserSourceIndexEntry {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    typeof value.signature === "string" &&
    typeof value.hash === "string" &&
    /^[0-9a-f]{64}$/i.test(value.hash) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}

function sourceIndexesEqual(
  left: Record<string, BrowserSourceIndexEntry>,
  right: Record<string, BrowserSourceIndexEntry>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(([path, entry]) => {
      const previous = left[path];
      return (
        isBrowserSourceIndexEntry(previous) &&
        previous.category === entry.category &&
        previous.signature === entry.signature &&
        previous.hash.toLowerCase() === entry.hash.toLowerCase() &&
        previous.size === entry.size
      );
    })
  );
}

function equalStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function scanBrowserProjectFile(
  relativePath: string,
  bytes: Uint8Array,
  topLevel: ReadonlySet<string>,
): ScannedFile | undefined {
  const relative = safePath(relativePath);
  if (relative.split("/", 1)[0]?.toLowerCase() === ".rustyera") return undefined;
  const category = classify(relative, topLevel);
  if (!category) return undefined;
  if (category === "resource") {
    return {
      relative_path: relative,
      category,
      payload: { type: "bytes", value: bytes },
      content_hash: blake3(bytes),
    };
  }
  const decoded = decodeProjectSource(bytes, relative);
  const text = category === "resource_manifest" ? normalizeResourceManifest(decoded) : decoded;
  const normalized = new TextEncoder().encode(text);
  return {
    relative_path: relative,
    category,
    payload: { type: "utf8", value: text },
    content_hash: blake3(normalized),
  };
}

export async function runBounded(
  tasks: Array<() => Promise<void>>,
  maximumConcurrency: number,
  progress?: FileScanProgress,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let completed = 0;
  const errors: unknown[] = new Array(tasks.length);
  const worker = async () => {
    while (next < tasks.length && !signal?.aborted) {
      const index = next++;
      try {
        await tasks[index]();
      } catch (error) {
        errors[index] = error;
      } finally {
        completed += 1;
        if (
          completed === tasks.length ||
          Math.floor((completed * 100) / tasks.length) >
            Math.floor(((completed - 1) * 100) / tasks.length)
        )
          progress?.(completed, tasks.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(tasks.length, maximumConcurrency) }, () => worker()),
  );
  throwIfAborted(signal);
  const firstError = errors.find((error) => error !== undefined);
  if (firstError !== undefined) throw firstError;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Export cancelled", "AbortError");
}

export function decodeProjectSource(bytes: Uint8Array, relativePath: string): string {
  if (relativePath.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      throw new Error("reraconfig.toml 不是有效的 UTF-8 文件");
    }
  }
  for (const encoding of ["utf-8", "shift_jis", "gbk"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      // Try the next legacy encoding accepted by the other frontend.
    }
  }
  throw new Error(`${relativePath} 不是有效的 UTF-8、Windows-31J 或 GBK 文件`);
}

export function decodeProtocolBytes(value: ArrayLike<number | bigint>): Uint8Array {
  return Uint8Array.from(value, (item) => {
    const byte = Number(item);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error("存储操作包含无效字节");
    return byte;
  });
}

export function normalizeResourceManifest(text: string): string {
  return text.replace(/([^\r\n]*)(\r\n|\r|\n|$)/g, (line, body: string, ending: string) => {
    if (!body) return ending;
    const fields = body.split(",");
    const value = fields[1];
    const stripped = value?.replace(/^[ \t]+|[ \t]+$/g, "") ?? "";
    if (value && stripped && stripped.toLowerCase() !== "anime") {
      const leading = value.match(/^[ \t]*/)?.[0] ?? "";
      const trailing = value.match(/[ \t]*$/)?.[0] ?? "";
      fields[1] = `${leading}${stripped.normalize("NFC")}${trailing}`;
    }
    return `${fields.join(",")}${ending}`;
  });
}

export function storageDirectoryName(namespace: string): string {
  const names: Record<string, string> = {
    project: "project",
    save: "sav",
    global_save: "sav",
    data: "data",
    log: "logs",
  };
  return names[namespace] ?? "data";
}

function classify(path: string, roots: ReadonlySet<string>): string | undefined {
  const parts = path.split("/");
  const first = parts[0].toLowerCase();
  const suffix = parts.at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  const name = parts.at(-1)?.toLowerCase() ?? "";
  if (name === "reraconfig.toml" || name === "setting.json") return "configuration";
  if (first === "resources") {
    if (suffix === "csv") return "resource_manifest";
    return RESOURCE_SUFFIXES.has(suffix) ? "resource" : undefined;
  }
  if (first === "sound") return AUDIO_SUFFIXES.has(suffix) ? "resource" : undefined;
  if (first === "font") return FONT_SUFFIXES.has(suffix) ? "resource" : undefined;
  if ((suffix === "erb" || suffix === "erh") && roots.has("erb") && first !== "erb") return;
  if (suffix === "csv" && roots.has("csv") && first !== "csv") return;
  if (suffix === "config" && roots.has("csv") && parts.length > 1 && first !== "csv") return;
  const categories: Record<string, string> = {
    csv: "csv",
    erb: "erb",
    erh: "erh",
    config: "configuration",
  };
  return categories[suffix];
}

function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function nativeLineEndings(contents: string): string {
  const normalized = normalizeLineEndings(contents);
  const windows =
    /^win/i.test(navigator.platform ?? "") || /\bwindows(?: nt)?\b/i.test(navigator.userAgent);
  return windows ? normalized.replaceAll("\n", "\r\n") : normalized;
}

function safePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..")) {
    throw new Error("路径必须位于项目目录内");
  }
  return parts.join("/");
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current;
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  if (!parts.length) throw new Error("文件路径不能为空");
  const directory = await getDirectory(root, parts.slice(0, -1), create);
  return directory.getFileHandle(parts.at(-1)!, { create });
}

async function getFile(root: FileSystemDirectoryHandle, parts: string[]): Promise<File> {
  return (await getFileHandle(root, parts, false)).getFile();
}

async function optionalFile(handle: FileSystemFileHandle): Promise<File | undefined> {
  try {
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

async function optionalFileHandle(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await getFileHandle(root, parts, false);
  } catch (error) {
    if (errorKind(error) === "not_found") return undefined;
    throw error;
  }
}

async function checkPrecondition(file: File | undefined, precondition: any): Promise<void> {
  if (precondition.type === "missing" && file) throw conflict();
  if (precondition.type === "revision") {
    if (!file) throw conflict();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hex(blake3(bytes)) !== precondition.revision) throw conflict();
  }
}

async function collectEntries(
  directory: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
  prefix: string,
  recursive: boolean,
  pattern: string | null,
  entries: any[],
): Promise<void> {
  void root;
  for await (const [name, handle] of directory.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === "directory") {
      if (recursive) await collectEntries(handle, root, `${path}/`, true, pattern, entries);
      continue;
    }
    if (pattern && !wildcard(pattern, name)) continue;
    const file = await handle.getFile();
    entries.push({
      relative_path: path,
      byte_length: file.size,
      revision: null,
      change_token: `${file.size}:${file.lastModified}`,
    });
  }
}

function wildcard(pattern: string, name: string): boolean {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${source}$`, "i").test(name);
}

function conflict(): DOMException {
  return new DOMException("存储前置条件不成立", "InvalidModificationError");
}

function errorKind(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotFoundError") return "not_found";
    if (error.name === "NotAllowedError") return "permission_denied";
    if (error.name === "InvalidModificationError") return "conflict";
  }
  return "other";
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
