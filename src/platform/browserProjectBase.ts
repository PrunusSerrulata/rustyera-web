import { blake3 } from "@noble/hashes/blake3.js";
import { Encoder } from "cbor-x";
import {
  compatibilityCbor,
  requireCompatibilityIdentity,
  type CompatibilityIdentity,
} from "@/core/compatibility";
import { decodeImageMetadata } from "@/core/imageMetadata";
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
  createProjectProgressReporter,
  decodeProjectSource,
  decodeProtocolBytes,
  runBounded,
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
import { scanBrowserProjectFilesOffThread } from "@/platform/browserProjectScanPool";
import type { ScannedFile } from "@/platform/browserProjectScanner";
import { takeProjectFileManifestOwnership } from "@/platform/projectFileManifestTransfer";
import {
  browserProjectFileReadConcurrency,
  isAndroidChromiumHost,
} from "@/platform/browserMemoryPolicy";
import {
  applyProjectFileUpdate,
  cacheIdentityManifest,
  cborHead,
  cborText,
  compareScannedFiles,
  comparePaths,
  emptyPayload,
  emptyScanMetrics,
  equalStringSets,
  identityPayload,
  payloadByteLength,
  prefetchBrowserProjectFiles,
  projectConfigurationDigest,
  projectCategoryCode,
  readFileInChunks,
} from "@/platform/browserProjectSupport";
import type {
  BrowserFullManifestSpool,
  BrowserManifest,
  BrowserProjectScanMetrics,
  FileScanProgress,
  PackagedFileMaterializer,
  PackagedResourceReader,
  ProjectConfigurationUpdatePreparer,
} from "@/platform/browserProject";

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

interface BrowserResourceIdentity {
  signature?: string;
  contentHash: Uint8Array;
  byteLength: number;
}

export class BrowserProjectBase {
  protected readonly files = new Map<string, FileSystemFileHandle>();
  protected readonly embeddedResources = new Map<string, Uint8Array>();
  protected packagedResourceReader?: PackagedResourceReader;
  protected readonly canonicalPaths = new Map<string, string>();
  protected readonly resourceIdentities = new Map<string, BrowserResourceIdentity>();
  protected usesEmbeddedManifest = false;
  protected manifestValue?: BrowserManifest;
  protected pendingSnapshot?: PendingBrowserSnapshot;
  protected packagedFile?: File;
  protected packagedHandle?: FileSystemFileHandle;
  protected materializePackagedHandle?: PackagedFileMaterializer;
  protected prepareConfigurationUpdate?: ProjectConfigurationUpdatePreparer;
  protected importedSnapshot = false;
  protected sourcePayloadsReleased = false;
  protected runtimeManifestSparse = false;
  protected scanMetricsValue: BrowserProjectScanMetrics = emptyScanMetrics();
  protected compatibilityValue?: CompatibilityIdentity;
  protected resolvedConfigurationDigest?: Uint8Array | null;
  protected dataRootValue?: FileSystemDirectoryHandle;

  constructor(
    readonly root: FileSystemDirectoryHandle,
    protected revision = 1,
    readonly name = root.name,
    protected sourceIndexTrusted = false,
  ) {}

  setSourceIndexTrusted(trusted: boolean): void {
    this.sourceIndexTrusted = trusted;
  }

  setCompatibility(value: unknown): void {
    const compatibility = requireCompatibilityIdentity(value);
    if (this.compatibilityValue?.profile !== compatibility.profile) this.dataRootValue = undefined;
    this.compatibilityValue = compatibility;
    if (this.manifestValue) this.manifestValue.compatibility = this.compatibilityValue;
  }

  bindResolvedCompatibility(identity: unknown, digest: unknown): void {
    if (digest != null && !(digest instanceof Uint8Array) && !Array.isArray(digest))
      throw new Error("Runtime 返回了无效的项目配置摘要");
    if (
      Array.isArray(digest) &&
      !digest.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    )
      throw new Error("Runtime 返回了无效的项目配置摘要");
    const bytes = digest == null ? null : decodeProtocolBytes(digest);
    if (bytes != null && bytes.byteLength !== 32)
      throw new Error("Runtime 返回了无效的项目配置摘要");
    this.setCompatibility(identity);
    this.resolvedConfigurationDigest = bytes?.slice() ?? null;
  }

  async validateResolvedConfiguration(manifest: BrowserManifest): Promise<void> {
    const expected = this.resolvedConfigurationDigest;
    if (expected === undefined) throw new Error("项目兼容配置尚未解析");
    const matches = (actual: Uint8Array | null) =>
      expected === null ? actual === null : actual !== null && equalBytes(expected, actual);
    if (!matches(projectConfigurationDigest(manifest)))
      throw new Error("项目根配置在兼容解析后发生变化，请重新打开项目");
    const current = await this.rootConfiguration();
    if (
      !matches(
        projectConfigurationDigest({
          project_revision: manifest.project_revision,
          files: current ? [current] : [],
        }),
      )
    )
      throw new Error("项目根配置在兼容解析后发生变化，请重新打开项目");
  }

  compatibility(): CompatibilityIdentity {
    return requireCompatibilityIdentity(this.compatibilityValue);
  }

  async dataRoot(create = true): Promise<FileSystemDirectoryHandle> {
    if (this.compatibility().profile === "emuera.em") return this.root;
    if (this.dataRootValue) return this.dataRootValue;
    let directory = this.root;
    for (const name of [".rustyera", "profiles", "emuera.skia.snake"])
      directory = await directory.getDirectoryHandle(name, { create });
    this.dataRootValue = directory;
    return this.dataRootValue;
  }

  async cacheDirectory(create = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.dataRoot(create);
    const directory = await root.getDirectoryHandle(".rustyera", { create });
    return directory.getDirectoryHandle("cache", { create });
  }

  async rootConfiguration(): Promise<ScannedFile | undefined> {
    const manifest = this.manifestValue;
    const source = manifest?.files.find(
      (file) => file.relative_path.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml",
    );
    if (!source) {
      if (!this.usesEmbeddedManifest && !this.importedSnapshot) {
        for await (const [name] of this.root.entries())
          if (name.toLowerCase() === "reraconfig.toml")
            throw new Error("项目根配置在扫描后新增，请重新打开项目");
      }
      return undefined;
    }
    if (this.usesEmbeddedManifest || this.importedSnapshot) return source;
    const handle = this.files.get(source.relative_path.toLowerCase());
    if (!handle) throw new Error("项目根配置在扫描后消失");
    const file = await handle.getFile();
    const contents = normalizeLineEndings(
      decodeProjectSource(new Uint8Array(await file.arrayBuffer()), source.relative_path),
    );
    const digest = blake3(new TextEncoder().encode(contents));
    if (!equalBytes(digest, source.content_hash))
      throw new Error("项目根配置在扫描后发生变化，请重新打开项目");
    source.payload = { type: "utf8", value: contents };
    return source;
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

  quickManifestHasAllSources(): boolean {
    return this.pendingSnapshot?.files.every((file) => file.prepared != null) ?? false;
  }

  useScanMetrics(metrics: BrowserProjectScanMetrics): void {
    this.scanMetricsValue = { ...metrics };
  }

  useEmbeddedManifest(manifest: BrowserManifest): void {
    this.useOwnedEmbeddedManifest(takeProjectFileManifestOwnership(manifest));
  }

  useOwnedEmbeddedManifest(owned: BrowserManifest, resourceReader?: PackagedResourceReader): void {
    this.setCompatibility(owned.compatibility);
    this.revision = owned.project_revision;
    this.embeddedResources.clear();
    this.packagedResourceReader = resourceReader;
    this.usesEmbeddedManifest = true;
    this.sourcePayloadsReleased = false;
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
    if (manifest.compatibility) this.setCompatibility(manifest.compatibility);
    this.importedSnapshot = true;
    this.sourcePayloadsReleased = false;
    this.canonicalPaths.clear();
    this.resourceIdentities.clear();
    for (const file of manifest.files) {
      const key = file.relative_path.toLowerCase();
      this.canonicalPaths.set(key, file.relative_path);
      if (file.category === "resource") {
        this.resourceIdentities.set(key, {
          contentHash: file.content_hash,
          byteLength: payloadByteLength(file.payload),
        });
      }
    }
    this.manifestValue = manifest;
  }

  importedManifest(): BrowserManifest | undefined {
    return this.importedSnapshot ? this.manifestValue : undefined;
  }

  /** Retain reload identities after Runtime has taken ownership of every source payload. */
  releaseSubmittedSourcePayloads(): void {
    if (this.usesEmbeddedManifest || !this.manifestValue) return;
    for (const file of this.manifestValue.files) file.payload = identityPayload(file);
    this.pendingSnapshot = undefined;
    this.sourcePayloadsReleased = true;
    // A later restart must rescan the selected directory instead of treating the compact identity
    // manifest as source-ready input.
    this.importedSnapshot = false;
  }

  /** Release one payload after the constrained Runtime has acknowledged direct ownership. */
  releaseSubmittedSourceFilePayload(file: ScannedFile): void {
    if (this.usesEmbeddedManifest) return;
    file.payload = identityPayload(file);
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
    this.updateManifestConfiguration(contents);
    this.pendingSnapshot = undefined;
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
    this.updateManifestConfiguration(contents);
    await this.invalidateCompiledCache();
  }

  async invalidateCompiledCache(): Promise<void> {
    try {
      const cacheDirectory = await this.cacheDirectory();
      await cacheDirectory.removeEntry("compiled-project.reracache");
    } catch {
      // The cache is derived data. A stale survivor is rejected by its project identity later.
    }
  }

  private updateManifestConfiguration(contents: string): void {
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
    this.resourceIdentities.clear();
    progress?.(0, 0);
    const enumerateStarted = performance.now();
    const { files: candidates, topLevel } = await this.enumerateFiles((completed) =>
      progress?.(completed, 0),
    );
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
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (candidate.category !== "resource") continue;
      const file = snapshots[index]!;
      this.resourceIdentities.set(candidate.relativePath.toLowerCase(), {
        signature: `${file.size}:${file.lastModified}`,
        contentHash: files[index]!.content_hash,
        byteLength: file.size,
      });
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
    this.manifestValue = {
      project_revision: this.revision,
      files,
      compatibility: this.compatibilityValue,
    };
    this.pendingSnapshot = undefined;
    this.sourcePayloadsReleased = false;
    return this.manifestValue;
  }

  async scanQuick(progress?: FileScanProgress): Promise<BrowserManifest> {
    this.files.clear();
    this.resourceIdentities.clear();
    progress?.(0, 0);
    const enumerateStarted = performance.now();
    const { files: candidates, topLevel } = await this.enumerateFiles((completed) =>
      progress?.(completed, 0),
    );
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
    const scanWorkTotal = candidates.length * 2;
    progress?.(0, scanWorkTotal);
    const reportScanWork = createProjectProgressReporter(scanWorkTotal, progress);
    const statStarted = performance.now();
    const pipelineProviderReads =
      !this.sourceIndexTrusted &&
      typeof navigator !== "undefined" &&
      isAndroidChromiumHost(navigator);
    let statCompleted = 0;
    let scanCompleted = 0;
    let statFinishedAt = statStarted;
    let prefetchCompleted: Promise<void> | undefined;
    let prefetched: Promise<File>[] | undefined;
    if (pipelineProviderReads) {
      const prefetch = prefetchBrowserProjectFiles(
        candidates,
        browserProjectFileReadConcurrency(),
        (index, file, completed) => {
          snapshots[index] = file;
          signatures[index] = `${file.size}:${file.lastModified}`;
          statCompleted = completed;
          statFinishedAt = performance.now();
          reportScanWork(statCompleted + scanCompleted);
        },
      );
      prefetched = prefetch.files;
      prefetchCompleted = prefetch.completed;
    } else {
      await runBounded(
        candidates.map((candidate, index) => async () => {
          const file = await candidate.handle.getFile();
          snapshots[index] = file;
          signatures[index] = `${file.size}:${file.lastModified}`;
        }),
        browserProjectFileReadConcurrency(),
        (completed) => reportScanWork(completed),
      );
      statCompleted = candidates.length;
      statFinishedAt = performance.now();
    }
    let statMs = statFinishedAt - statStarted;
    const requests: Array<{ relativePath: string; file: File | Promise<File> }> = [];
    const requestIndexes: number[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (pipelineProviderReads) {
        requestIndexes.push(index);
        requests.push({ relativePath: candidate.relativePath, file: prefetched![index]! });
        continue;
      }
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
    const reusedCount = candidates.length - requests.length;
    if (reusedCount > 0) reportScanWork(statCompleted + reusedCount);
    const scannedFiles = await scanBrowserProjectFilesOffThread(
      requests,
      topLevel,
      undefined,
      undefined,
      (completed) => {
        scanCompleted = completed + reusedCount;
        reportScanWork(statCompleted + scanCompleted);
      },
    );
    await prefetchCompleted;
    statMs = statFinishedAt - statStarted;
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
      if (candidate.category === "resource") {
        this.resourceIdentities.set(candidate.relativePath.toLowerCase(), {
          signature,
          contentHash: scanned.content_hash,
          byteLength: file.size,
        });
      }
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
    this.manifestValue = {
      project_revision: this.revision,
      files,
      compatibility: this.compatibilityValue,
    };
    this.sourcePayloadsReleased = false;
    return this.manifestValue;
  }

  async materialize(progress?: FileScanProgress, signal?: AbortSignal): Promise<BrowserManifest> {
    throwIfAborted(signal);
    if (this.sourcePayloadsReleased) return this.scan(progress, undefined, signal);
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return this.manifestValue ?? this.scan(progress, undefined, signal);
    this.files.clear();
    const { files: current, topLevel } = await this.enumerateFiles((completed) =>
      progress?.(completed, 0),
    );
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
      browserProjectFileReadConcurrency(),
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
    this.manifestValue = {
      project_revision: this.revision,
      files,
      compatibility: this.compatibilityValue,
    };
    this.sourcePayloadsReleased = false;
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
    // CBOR emits many one-byte headers. Coalesce them into bounded writes instead
    // of scheduling an OPFS operation for every field of every project file.
    const buffer = new Uint8Array(256 * 1024);
    let buffered = 0;
    const flush = async () => {
      if (!buffered) return;
      throwIfAborted(signal);
      await writer.write(buffer.subarray(0, buffered) as FileSystemWriteChunkType);
      buffered = 0;
    };
    let totalBytes = 0;
    const write = async (bytes: Uint8Array) => {
      totalBytes += bytes.byteLength;
      if (totalBytes > 1024 * 1024 * 1024)
        throw new Error("full project manifest exceeds the 1 GiB transfer limit");
      for (let offset = 0; offset < bytes.byteLength;) {
        throwIfAborted(signal);
        const count = Math.min(buffer.length - buffered, bytes.byteLength - offset);
        buffer.set(bytes.subarray(offset, offset + count), buffered);
        buffered += count;
        offset += count;
        if (buffered === buffer.length) await flush();
      }
    };
    let completed = 0;
    progress?.(completed, manifest.files.length);
    try {
      await write(Uint8Array.of(0xa3, 0x00));
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
      await write(Uint8Array.of(0x02));
      await write(
        // Integer-keyed protocol maps must not acquire cbor-x's explicit-Map extension tag.
        new Encoder({ useRecords: false, mapsAsObjects: false }).encode(
          compatibilityCbor(manifest.compatibility),
        ),
      );
      await flush();
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
    // FileList imports authorize resource bytes by length/hash but do not retain a filesystem
    // change token. Validate any recorded token, then always verify the complete content below.
    const identity = this.resourceIdentities.get(key);
    if (
      !identity ||
      file.size !== source.payload.byteLength ||
      (identity.signature != null && identity.signature !== signature)
    )
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
    const persisted = await this.readPersistedCompiledCache(progress);
    if (persisted) return persisted;
    if (this.packagedHandle) return readFileInChunks(await this.packagedHandle.getFile(), progress);
    if (this.packagedFile) return readFileInChunks(this.packagedFile, progress);
    return undefined;
  }

  async readPersistedCompiledCache(progress?: FileScanProgress): Promise<Uint8Array | undefined> {
    try {
      const cacheDirectory = await this.cacheDirectory();
      const handle = await cacheDirectory.getFileHandle("compiled-project.reracache");
      return readFileInChunks(await handle.getFile(), progress);
    } catch (error) {
      if (errorKind(error) === "not_found") return undefined;
      throw error;
    }
  }

  protected async enumerateFiles(progress?: (visitedEntries: number) => void) {
    const enumeration = await enumerateBrowserProject(this.root, progress);
    for (const file of enumeration.files) {
      this.files.set(file.relativePath.toLowerCase(), file.handle);
    }
    return enumeration;
  }
}
