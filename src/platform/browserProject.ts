import { blake3 } from "@noble/hashes/blake3.js";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type { ProjectReloadScope, ProjectReloadTargets } from "@/core/types";
import {
  equalBytes,
  errorKind,
  hex,
  nativeLineEndings,
  normalizeLineEndings,
  optionalFileHandle,
  safePath,
} from "@/platform/browserProjectFilesystem";
import {
  decodeProjectSource,
  isScriptCategory,
  projectReloadScopeMatches,
  projectReloadSelector,
  runBounded,
  saveSlotName,
  throwIfAborted,
} from "@/platform/browserProjectUtilities";
import { enumerateBrowserProject } from "@/platform/browserProjectEnumeration";
import {
  decodeSourceIndexHash,
  isBrowserSourceIndexIdentity,
  readBrowserSourceIndex,
  removeBrowserSourceIndex,
  sourceIndexesEqual,
  validIndexedImageMetadata,
  type BrowserSourceIndexEntry,
  writeBrowserSourceIndex,
} from "@/platform/browserProjectSourceIndex";
import { dispatchBrowserStorage } from "@/platform/browserProjectStorage";
import { isPackagedProjectFontPath, type ProjectFontSource } from "@/platform/projectFonts";
import { scanBrowserProjectFilesOffThread } from "@/platform/browserProjectScanPool";
import type { ScannedFile } from "@/platform/browserProjectScanner";
import { takeProjectFileManifestOwnership } from "@/platform/projectFileManifestTransfer";

export { scanBrowserProjectFile } from "@/platform/browserProjectScanner";
export type { ScannedFile } from "@/platform/browserProjectScanner";

export {
  decodeProjectSource,
  decodeProtocolBytes,
  normalizeResourceManifest,
  runBounded,
  saveSlotName,
  storageDirectoryName,
} from "@/platform/browserProjectUtilities";

export interface BrowserTraditionalSaveSlot {
  slot: number;
  occupied: boolean;
}

export interface BrowserManifest {
  project_revision: number;
  files: ScannedFile[];
}

export interface BrowserFullManifestSpool {
  totalBytes: number;
  read(offset: number, maximumBytes: number): Promise<Uint8Array>;
  release(): Promise<void>;
}

export type FileScanProgress = (completed: number, total: number) => void;
export type ProjectConfigurationUpdatePreparer = (
  projectFile: Uint8Array,
  expectedDigest: Uint8Array,
  contents: string,
) => Promise<Uint8Array>;
export type PackagedFileMaterializer = () => Promise<FileSystemFileHandle>;
export type PackagedResourceReader = (
  relativePath: string,
  maximumBytes?: number,
) => Promise<Uint8Array>;

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

interface PendingBrowserReload {
  candidate: BrowserProject;
  manifest: BrowserManifest;
  runtimeManifestSparse: boolean;
}

export interface BrowserProjectScanMetrics {
  enumerateMs: number;
  indexReadMs: number;
  indexWriteMs: number;
  statMs: number;
  sourceReadDecodeHashMs: number;
  sourceIndexPresent: boolean;
  sourceIndexTrusted: boolean;
  sourceIndexReusedFiles: number;
  sourceIndexHashedFiles: number;
}

export class BrowserProject {
  private readonly files = new Map<string, FileSystemFileHandle>();
  private readonly embeddedResources = new Map<string, Uint8Array>();
  private packagedResourceReader?: PackagedResourceReader;
  private readonly canonicalPaths = new Map<string, string>();
  private readonly resourceSignatures = new Map<string, string>();
  private usesEmbeddedManifest = false;
  private manifestValue?: BrowserManifest;
  private pendingSnapshot?: PendingBrowserSnapshot;
  private packagedFile?: File;
  private packagedHandle?: FileSystemFileHandle;
  private materializePackagedHandle?: PackagedFileMaterializer;
  private prepareConfigurationUpdate?: ProjectConfigurationUpdatePreparer;
  private importedSnapshot = false;
  private runtimeManifestSparse = false;
  private pendingReload?: PendingBrowserReload;
  private scanMetricsValue: BrowserProjectScanMetrics = emptyScanMetrics();

  constructor(
    readonly root: FileSystemDirectoryHandle,
    private revision = 1,
    readonly name = root.name,
    private sourceIndexTrusted = false,
  ) {}

  setSourceIndexTrusted(trusted: boolean): void {
    this.sourceIndexTrusted = trusted;
  }

  sourceIndexStats(): { trusted: boolean; reusedFiles: number; hashedFiles: number } {
    return {
      trusted: this.sourceIndexTrusted,
      reusedFiles: this.scanMetricsValue.sourceIndexReusedFiles,
      hashedFiles: this.scanMetricsValue.sourceIndexHashedFiles,
    };
  }

  scanMetrics(): BrowserProjectScanMetrics {
    return { ...this.scanMetricsValue };
  }

  useScanMetrics(metrics: BrowserProjectScanMetrics): void {
    this.scanMetricsValue = { ...metrics };
  }

  useEmbeddedManifest(manifest: BrowserManifest): void {
    this.useOwnedEmbeddedManifest(takeProjectFileManifestOwnership(manifest));
  }

  useOwnedEmbeddedManifest(owned: BrowserManifest, resourceReader?: PackagedResourceReader): void {
    this.revision = owned.project_revision;
    this.embeddedResources.clear();
    this.packagedResourceReader = resourceReader;
    this.usesEmbeddedManifest = true;
    for (const file of owned.files) {
      if (file.category === "resource" && file.payload.type === "bytes") {
        if (!(file.payload.value instanceof Uint8Array)) {
          throw new Error(`项目资源不是二进制数据：${file.relative_path}`);
        }
        if (!resourceReader) {
          this.embeddedResources.set(
            safePath(file.relative_path).toLowerCase(),
            file.payload.value,
          );
        }
      }
    }
    this.manifestValue = cacheIdentityManifest(owned);
  }

  usePackagedFile(
    file: File,
    handle?: FileSystemFileHandle,
    prepareConfigurationUpdate?: ProjectConfigurationUpdatePreparer,
    materializeHandle?: PackagedFileMaterializer,
  ): void {
    this.packagedFile = file;
    this.packagedHandle = handle;
    if (prepareConfigurationUpdate) this.prepareConfigurationUpdate = prepareConfigurationUpdate;
    this.materializePackagedHandle = materializeHandle;
  }

  async packagedProjectFile(): Promise<File | undefined> {
    if (this.packagedHandle) return this.packagedHandle.getFile();
    return this.packagedFile;
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
      !this.usesEmbeddedManifest ||
      Boolean(
        (this.packagedHandle || this.materializePackagedHandle) && this.prepareConfigurationUpdate,
      )
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
    let handle = this.packagedHandle;
    const prepare = this.prepareConfigurationUpdate;
    if (!handle && this.materializePackagedHandle) {
      handle = await this.materializePackagedHandle();
      this.packagedHandle = handle;
      this.packagedFile = await handle.getFile();
    }
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
    this.resourceSignatures.clear();
    progress?.(0, 0);
    const enumerateStarted = performance.now();
    const { files: candidates, topLevel } = await this.enumerateFiles();
    candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    const enumerateMs = performance.now() - enumerateStarted;
    const files = new Array<ScannedFile>();
    const snapshots = new Array<File>(candidates.length);
    const requests: Array<{ relativePath: string; file: File }> = [];
    const positions: number[] = [];
    const statStarted = performance.now();
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const file = await candidate.handle.getFile();
      snapshots[index] = file;
      if (candidate.category === "resource")
        this.resourceSignatures.set(
          candidate.relativePath.toLowerCase(),
          `${file.size}:${file.lastModified}`,
        );
      const prepared = preloaded?.get(candidate.relativePath);
      if (prepared) {
        files.push(prepared);
      } else {
        positions.push(files.length);
        files.push(undefined as unknown as ScannedFile);
        requests.push({ relativePath: candidate.relativePath, file });
      }
    }
    const statMs = performance.now() - statStarted;
    progress?.(0, requests.length);
    const readStarted = performance.now();
    const scanned = await scanBrowserProjectFilesOffThread(requests, topLevel, signal);
    for (let index = 0; index < scanned.length; index += 1) {
      const file = scanned[index];
      if (!file) throw new Error(`无法分类项目文件：${requests[index]!.relativePath}`);
      files[positions[index]!] = file;
    }
    progress?.(requests.length, requests.length);
    const sourceReadDecodeHashMs = performance.now() - readStarted;
    const nextIndex = Object.fromEntries(
      candidates.map((candidate, index) => {
        const file = snapshots[index]!;
        const scannedFile = files[index]!;
        return [
          candidate.relativePath,
          {
            category: candidate.category,
            signature: `${file.size}:${file.lastModified}`,
            hash: hex(scannedFile.content_hash),
            size: file.size,
            imageMetadata:
              scannedFile.payload.type === "external"
                ? scannedFile.payload.imageMetadata
                : undefined,
          } satisfies BrowserSourceIndexEntry,
        ];
      }),
    );
    const indexWriteStarted = performance.now();
    try {
      await writeBrowserSourceIndex(this.root, nextIndex);
    } catch (error) {
      await removeBrowserSourceIndex(this.root);
      console.warn("Unable to refresh browser source index", error);
    }
    const indexWriteMs = performance.now() - indexWriteStarted;
    files.sort(compareScannedFiles);
    this.scanMetricsValue = {
      ...emptyScanMetrics(),
      enumerateMs,
      indexWriteMs,
      statMs,
      sourceReadDecodeHashMs,
      sourceIndexHashedFiles: requests.length,
    };
    this.manifestValue = { project_revision: this.revision, files };
    this.pendingSnapshot = undefined;
    return this.manifestValue;
  }

  async scanQuick(progress?: FileScanProgress): Promise<BrowserManifest> {
    this.files.clear();
    this.resourceSignatures.clear();
    progress?.(0, 0);
    const enumerateStarted = performance.now();
    const { files: candidates, topLevel } = await this.enumerateFiles();
    candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    const enumerateMs = performance.now() - enumerateStarted;
    const indexReadStarted = performance.now();
    const sourceIndex = await readBrowserSourceIndex(this.root);
    const indexReadMs = performance.now() - indexReadStarted;
    const previous = sourceIndex.files;
    const pending = new Array<PendingBrowserFile>(candidates.length);
    const files = new Array<ScannedFile>(candidates.length);
    const indexEntries = new Array<[string, BrowserSourceIndexEntry]>(candidates.length);
    const reused = new Array<boolean>(candidates.length).fill(false);
    const snapshots = new Array<File>(candidates.length);
    const signatures = new Array<string>(candidates.length);
    progress?.(0, candidates.length);
    const statStarted = performance.now();
    await runBounded(
      candidates.map((candidate, index) => async () => {
        const file = await candidate.handle.getFile();
        snapshots[index] = file;
        signatures[index] = `${file.size}:${file.lastModified}`;
      }),
      8,
    );
    const statMs = performance.now() - statStarted;
    const requests: Array<{ relativePath: string; file: File }> = [];
    const requestIndexes: number[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const file = snapshots[index]!;
      const signature = signatures[index]!;
      const prior = previous[candidate.relativePath];
      const reusable =
        this.sourceIndexTrusted &&
        sourceIndex.valid &&
        isBrowserSourceIndexIdentity(prior) &&
        prior.category === candidate.category &&
        prior.signature === signature &&
        prior.size === file.size &&
        /^[0-9a-f]{64}$/i.test(prior.hash);
      if (
        !reusable &&
        import.meta.env.VITE_RUSTYERA_TEST === "1" &&
        this.sourceIndexTrusted &&
        sourceIndex.valid
      ) {
        console.warn(
          "Cross-frontend source-index entry was not reusable",
          JSON.stringify({
            path: candidate.relativePath,
            candidateCategory: candidate.category,
            fileSize: file.size,
            signature,
            prior: prior ?? null,
            identityValid: isBrowserSourceIndexIdentity(prior),
          }),
        );
      }
      if (reusable) {
        reused[index] = true;
        let imageMetadata = validIndexedImageMetadata(prior.imageMetadata);
        if (
          candidate.category === "resource" &&
          !imageMetadata &&
          /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(candidate.relativePath)
        ) {
          try {
            imageMetadata = decodeImageMetadata(
              new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()),
            );
          } catch {
            // Invalid or unsupported image metadata remains a cache miss for Runtime services.
          }
          const current = await candidate.handle.getFile();
          if (`${current.size}:${current.lastModified}` !== signature)
            throw new Error(`项目文件在读取期间发生变化：${candidate.relativePath}`);
        }
        files[index] = {
          relative_path: candidate.relativePath,
          category: candidate.category,
          payload: emptyPayload(candidate.category, file.size, imageMetadata),
          content_hash: decodeSourceIndexHash(prior.hash),
        };
      } else {
        requestIndexes.push(index);
        requests.push({ relativePath: candidate.relativePath, file });
      }
    }
    const readStarted = performance.now();
    const scannedFiles = await scanBrowserProjectFilesOffThread(requests, topLevel);
    for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
      const candidateIndex = requestIndexes[requestIndex]!;
      const scanned = scannedFiles[requestIndex];
      if (!scanned) throw new Error(`无法分类项目文件：${requests[requestIndex]!.relativePath}`);
      files[candidateIndex] = scanned;
    }
    const sourceReadDecodeHashMs = performance.now() - readStarted;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const file = snapshots[index]!;
      const signature = signatures[index]!;
      const scanned = files[index]!;
      if (candidate.category === "resource")
        this.resourceSignatures.set(candidate.relativePath.toLowerCase(), signature);
      const prepared = reused[index] && candidate.category !== "resource" ? undefined : scanned;
      pending[index] = { ...candidate, signature, prepared };
      indexEntries[index] = [
        candidate.relativePath,
        {
          category: candidate.category,
          signature,
          hash: hex(scanned.content_hash),
          size: file.size,
          imageMetadata:
            scanned.payload.type === "external" ? scanned.payload.imageMetadata : undefined,
        },
      ];
    }
    progress?.(candidates.length, candidates.length);
    const next = Object.fromEntries(indexEntries);
    let indexWriteMs = 0;
    if (!this.sourceIndexTrusted || !sourceIndex.portable || !sourceIndexesEqual(previous, next)) {
      const indexWriteStarted = performance.now();
      try {
        await writeBrowserSourceIndex(this.root, next);
      } catch (error) {
        await removeBrowserSourceIndex(this.root);
        console.warn("Unable to refresh browser source index", error);
      }
      indexWriteMs = performance.now() - indexWriteStarted;
    }
    files.sort(compareScannedFiles);
    pending.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    this.pendingSnapshot = { files: pending, topLevel };
    this.scanMetricsValue = {
      enumerateMs,
      indexReadMs,
      indexWriteMs,
      statMs,
      sourceReadDecodeHashMs,
      sourceIndexPresent: sourceIndex.present,
      sourceIndexTrusted: this.sourceIndexTrusted,
      sourceIndexReusedFiles: reused.filter(Boolean).length,
      sourceIndexHashedFiles: reused.filter((value) => !value).length,
    };
    this.manifestValue = { project_revision: this.revision, files };
    return this.manifestValue;
  }

  async materialize(progress?: FileScanProgress, signal?: AbortSignal): Promise<BrowserManifest> {
    throwIfAborted(signal);
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return this.manifestValue ?? this.scan(progress, undefined, signal);
    this.files.clear();
    const { files: current, topLevel } = await this.enumerateFiles();
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
    const requests: Array<{ relativePath: string; file: File }> = [];
    const requestIndexes: number[] = [];
    for (let index = 0; index < snapshot.files.length; index += 1) {
      const pending = snapshot.files[index]!;
      if (pending.prepared) files[index] = pending.prepared;
      else {
        requestIndexes.push(index);
        requests.push({ relativePath: current[index]!.relativePath, file: currentFiles[index]! });
      }
    }
    const scannedFiles = await scanBrowserProjectFilesOffThread(requests, topLevel, signal);
    for (let requestIndex = 0; requestIndex < scannedFiles.length; requestIndex += 1) {
      const index = requestIndexes[requestIndex]!;
      const scanned = scannedFiles[requestIndex];
      const entry = current[index]!;
      if (!scanned || scanned.category !== entry.category)
        throw new Error(`项目文件在读取期间发生变化：${entry.relativePath}`);
      files[index] = scanned;
    }
    progress?.(snapshot.files.length, snapshot.files.length);
    files.sort(compareScannedFiles);
    this.pendingSnapshot = undefined;
    this.manifestValue = { project_revision: this.revision, files };
    return this.manifestValue;
  }

  async stageFullManifest(
    progress?: FileScanProgress,
    signal?: AbortSignal,
  ): Promise<BrowserFullManifestSpool> {
    const manifest = await this.materialize(progress, signal);
    const root = await navigator.storage.getDirectory();
    const name = `.rustyera-full-manifest-${crypto.randomUUID()}.cbor`;
    const handle = await root.getFileHandle(name, { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    let totalBytes = 0;
    const write = async (bytes: Uint8Array) => {
      totalBytes += bytes.byteLength;
      if (totalBytes > 1024 * 1024 * 1024)
        throw new Error("full project manifest exceeds the 1 GiB transfer limit");
      await writer.write(bytes as FileSystemWriteChunkType);
    };
    let completed = 0;
    progress?.(completed, manifest.files.length);
    try {
      await write(Uint8Array.of(0xa2, 0x00));
      await write(cborHead(0, manifest.project_revision));
      await write(Uint8Array.of(0x01));
      await write(cborHead(4, manifest.files.length));
      for (const file of manifest.files) {
        throwIfAborted(signal);
        await write(cborHead(5, 4));
        await write(Uint8Array.of(0x00));
        await write(cborText(file.relative_path));
        await write(Uint8Array.of(0x01));
        await write(cborHead(0, projectCategoryCode(file.category)));
        await write(Uint8Array.of(0x02, 0x82));
        if (file.payload.type === "utf8") {
          await write(Uint8Array.of(0x00, 0x81));
          await write(cborText(file.payload.value));
        } else if (file.payload.type === "bytes") {
          await write(Uint8Array.of(0x01, 0x81));
          await write(cborHead(2, file.payload.value.byteLength));
          await write(file.payload.value);
        } else {
          await write(Uint8Array.of(0x01, 0x81));
          await write(cborHead(2, file.payload.byteLength));
          await this.writeResourceToSpool(file, write, signal);
        }
        await write(Uint8Array.of(0x03));
        await write(cborHead(2, file.content_hash.byteLength));
        await write(file.content_hash);
        completed += 1;
        progress?.(completed, manifest.files.length);
      }
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      await root.removeEntry(name).catch(() => undefined);
      throw error;
    }
    return {
      totalBytes,
      async read(offset, maximumBytes) {
        const file = await handle.getFile();
        return new Uint8Array(
          await file.slice(offset, Math.min(file.size, offset + maximumBytes)).arrayBuffer(),
        );
      },
      async release() {
        await root.removeEntry(name).catch((error) => {
          if (errorKind(error) !== "not_found") throw error;
        });
      },
    };
  }

  private async writeResourceToSpool(
    source: ScannedFile,
    write: (bytes: Uint8Array) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (source.payload.type !== "external") throw new Error("resource descriptor is missing");
    const normalized = safePath(source.relative_path);
    const key = normalized.toLowerCase();
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${source.relative_path}`);
    const file = await handle.getFile();
    const signature = `${file.size}:${file.lastModified}`;
    if (file.size !== source.payload.byteLength || this.resourceSignatures.get(key) !== signature)
      throw new Error(`资源在项目扫描后发生变化：${source.relative_path}`);
    const hasher = blake3.create();
    for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
      throwIfAborted(signal);
      const bytes = new Uint8Array(
        await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer(),
      );
      hasher.update(bytes);
      await write(bytes);
    }
    const current = await handle.getFile();
    if (
      `${current.size}:${current.lastModified}` !== signature ||
      !equalBytes(hasher.digest(), source.content_hash)
    )
      throw new Error(`资源在项目扫描后发生变化：${source.relative_path}`);
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

  async projectReloadTargets(): Promise<ProjectReloadTargets> {
    if (this.embeddedManifest()) return { folders: [], scripts: [] };
    const paths = new Set(
      (this.manifestValue?.files ?? [])
        .filter((file) => isScriptCategory(file.category))
        .map((file) => file.relative_path),
    );
    const { files: current } = await this.enumerateFiles();
    for (const file of current) {
      if (isScriptCategory(file.category)) paths.add(file.relativePath);
    }
    const scripts = [...paths].sort(comparePaths);
    const folders = [
      ...new Set(scripts.map((path) => path.slice(0, path.lastIndexOf("/") + 1).slice(0, -1))),
    ]
      .filter(Boolean)
      .sort(comparePaths);
    return { folders, scripts };
  }

  async prepareReloadBaseline(progress?: FileScanProgress): Promise<void> {
    if (this.embeddedManifest()) return;
    await this.materialize(progress);
  }

  async reloadRequest(scope: ProjectReloadScope, progress?: FileScanProgress): Promise<any> {
    if (this.embeddedManifest()) throw new Error("项目文件不包含可热重载的外部源码目录");
    if (this.pendingReload) throw new Error("已有项目热重载正在等待 Runtime 确认");
    const selector = projectReloadSelector(scope);
    const previous = this.manifestValue ?? (await this.scan(progress));
    const candidate = new BrowserProject(
      this.root,
      this.revision + 1,
      this.name,
      this.sourceIndexTrusted,
    );
    let current = await candidate.scan(progress);
    if (this.runtimeManifestSparse && selector.type === "all") {
      current = await candidate.materialize(progress);
    }
    const oldByPath = new Map(previous.files.map((file) => [file.relative_path, file]));
    const newByPath = new Map(current.files.map((file) => [file.relative_path, file]));
    const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort(comparePaths);
    const changes: any[] = [];
    if (this.runtimeManifestSparse && selector.type === "all") {
      this.pendingReload = { candidate, manifest: current, runtimeManifestSparse: false };
      return {
        base_revision: previous.project_revision,
        target_revision: current.project_revision,
        changes: current.files.map((file) => runtimeReloadUpsert(file)),
      };
    }
    if (this.runtimeManifestSparse) {
      const files = [
        ...previous.files.filter(
          (file) => !projectReloadScopeMatches(selector, file.relative_path, file.category),
        ),
        ...current.files
          .filter((file) => projectReloadScopeMatches(selector, file.relative_path, file.category))
          .map((file) => {
            const baseline = oldByPath.get(file.relative_path);
            return baseline &&
              baseline.category === file.category &&
              equalBytes(baseline.content_hash, file.content_hash)
              ? baseline
              : file;
          }),
      ].sort(compareScannedFiles);
      const hydratedPaths = new Set(files.map((file) => file.relative_path));
      changes.push(...files.map((file) => ({ type: "upsert", file })));
      changes.push(
        ...previous.files
          .filter(
            (file) =>
              projectReloadScopeMatches(selector, file.relative_path, file.category) &&
              !hydratedPaths.has(file.relative_path),
          )
          .map((file) => ({
            type: "remove",
            category: file.category,
            relative_path: file.relative_path,
          })),
      );
      this.pendingReload = {
        candidate,
        manifest: { project_revision: current.project_revision, files },
        runtimeManifestSparse: false,
      };
      return {
        base_revision: previous.project_revision,
        target_revision: current.project_revision,
        changes: changes.map(runtimeReloadChange),
      };
    }
    for (const path of paths) {
      const oldFile = oldByPath.get(path);
      const newFile = newByPath.get(path);
      const category = newFile?.category ?? oldFile?.category;
      if (!category || !projectReloadScopeMatches(selector, path, category)) continue;
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
    if (selector.type !== "all") {
      const files = [
        ...previous.files.filter(
          (file) => !projectReloadScopeMatches(selector, file.relative_path, file.category),
        ),
        ...current.files.filter((file) =>
          projectReloadScopeMatches(selector, file.relative_path, file.category),
        ),
      ].sort(compareScannedFiles);
      this.pendingReload = {
        candidate,
        manifest: { project_revision: current.project_revision, files },
        runtimeManifestSparse: false,
      };
    } else {
      this.pendingReload = { candidate, manifest: current, runtimeManifestSparse: false };
    }
    return {
      base_revision: previous.project_revision,
      target_revision: current.project_revision,
      changes: changes.map(runtimeReloadChange),
    };
  }

  finalizeReload(success: boolean): void {
    const pending = this.pendingReload;
    this.pendingReload = undefined;
    if (!success || !pending) return;
    const candidate = pending.candidate;
    this.revision = pending.manifest.project_revision;
    this.manifestValue = pending.manifest;
    this.pendingSnapshot = undefined;
    this.runtimeManifestSparse = pending.runtimeManifestSparse;
    this.files.clear();
    this.canonicalPaths.clear();
    const activePaths = new Set(
      pending.manifest.files.map((file) => file.relative_path.toLowerCase()),
    );
    for (const [path, handle] of candidate.files) {
      if (activePaths.has(path)) this.files.set(path, handle);
    }
    for (const [path, canonical] of candidate.canonicalPaths) {
      if (activePaths.has(path)) this.canonicalPaths.set(path, canonical);
    }
  }

  hasPendingReload(): boolean {
    return this.pendingReload != null;
  }

  async readResource(relativePath: string): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return new Uint8Array(embedded);
    if (this.usesEmbeddedManifest && this.packagedResourceReader) {
      return this.packagedResourceReader(normalized);
    }
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const current = await handle.getFile();
    const bytes = new Uint8Array(await current.arrayBuffer());
    const expected = this.manifestValue?.files.find(
      (file) => file.category === "resource" && file.relative_path.toLowerCase() === key,
    )?.content_hash;
    const expectedSignature = this.resourceSignatures.get(key);
    if (
      !expected ||
      (expectedSignature != null &&
        `${current.size}:${current.lastModified}` !== expectedSignature) ||
      !equalBytes(blake3(bytes), expected)
    )
      throw new Error(`资源在项目扫描后发生变化：${relativePath}`);
    return bytes;
  }

  async readResourcePrefix(relativePath: string, maximumBytes: number): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return embedded.slice(0, maximumBytes);
    if (this.usesEmbeddedManifest && this.packagedResourceReader) {
      return this.packagedResourceReader(normalized, maximumBytes);
    }
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const file = await handle.getFile();
    const expectedSignature = this.resourceSignatures.get(key);
    const signature = `${file.size}:${file.lastModified}`;
    if (expectedSignature && signature !== expectedSignature)
      throw new Error(`资源在项目扫描后发生变化：${relativePath}`);
    const bytes = new Uint8Array(await file.slice(0, maximumBytes).arrayBuffer());
    const current = await handle.getFile();
    if (`${current.size}:${current.lastModified}` !== signature)
      throw new Error(`资源在项目扫描后发生变化：${relativePath}`);
    if (!expectedSignature) this.resourceSignatures.set(key, signature);
    return bytes;
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
      const result = await dispatchBrowserStorage(
        this.root,
        request.namespace,
        request.relative_path,
        request.operation,
      );
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

  private async enumerateFiles() {
    const enumeration = await enumerateBrowserProject(this.root);
    for (const file of enumeration.files) {
      this.files.set(file.relativePath.toLowerCase(), file.handle);
    }
    return enumeration;
  }
}

function runtimeReloadChange(change: any): any {
  return change.type === "upsert" ? runtimeReloadUpsert(change.file) : change;
}

function runtimeReloadUpsert(file: ScannedFile): any {
  return {
    type: "upsert",
    file: {
      ...file,
      payload:
        file.payload.type === "bytes"
          ? { type: "bytes", value: [...file.payload.value] }
          : file.payload.type === "external"
            ? {
                type: "external_resource",
                value: {
                  byte_length: file.payload.byteLength,
                  image_metadata: file.payload.imageMetadata
                    ? {
                        width: file.payload.imageMetadata.width,
                        height: file.payload.imageMetadata.height,
                        format: file.payload.imageMetadata.format,
                        animated: file.payload.imageMetadata.animated,
                      }
                    : null,
                },
              }
            : file.payload,
      content_hash: [...file.content_hash],
    },
  };
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
          ? file.payload.type === "external"
            ? file.payload
            : { type: "bytes", value: new Uint8Array() }
          : { type: "utf8", value: "" },
    })),
  };
}

function emptyPayload(
  category: string,
  byteLength = 0,
  imageMetadata?: Extract<ScannedFile["payload"], { type: "external" }>["imageMetadata"],
): ScannedFile["payload"] {
  return category === "resource"
    ? { type: "external", byteLength, imageMetadata }
    : { type: "utf8", value: "" };
}

function emptyScanMetrics(): BrowserProjectScanMetrics {
  return {
    enumerateMs: 0,
    indexReadMs: 0,
    indexWriteMs: 0,
    statMs: 0,
    sourceReadDecodeHashMs: 0,
    sourceIndexPresent: false,
    sourceIndexTrusted: false,
    sourceIndexReusedFiles: 0,
    sourceIndexHashedFiles: 0,
  };
}

function compareScannedFiles(left: ScannedFile, right: ScannedFile): number {
  return comparePaths(left.relative_path, right.relative_path);
}

function projectCategoryCode(category: string): number {
  const code = {
    csv: 0,
    erh: 1,
    erb: 2,
    resource_manifest: 3,
    resource: 4,
    configuration: 5,
  }[category];
  if (code == null) throw new Error(`未知项目文件类别：${category}`);
  return code;
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const header = cborHead(3, encoded.byteLength);
  const result = new Uint8Array(header.byteLength + encoded.byteLength);
  result.set(header);
  result.set(encoded, header.byteLength);
  return result;
}

function cborHead(major: number, value: number | bigint): Uint8Array {
  const integer = BigInt(value);
  if (integer < 0n) throw new Error("CBOR length cannot be negative");
  if (integer < 24n) return Uint8Array.of((major << 5) | Number(integer));
  if (integer <= 0xffn) return Uint8Array.of((major << 5) | 24, Number(integer));
  const bytes = integer <= 0xffffn ? 2 : integer <= 0xffff_ffffn ? 4 : 8;
  const result = new Uint8Array(1 + bytes);
  result[0] = (major << 5) | (bytes === 2 ? 25 : bytes === 4 ? 26 : 27);
  const view = new DataView(result.buffer);
  if (bytes === 2) view.setUint16(1, Number(integer));
  else if (bytes === 4) view.setUint32(1, Number(integer));
  else view.setBigUint64(1, integer);
  return result;
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

function equalStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
