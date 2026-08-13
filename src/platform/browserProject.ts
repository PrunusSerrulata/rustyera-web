import { blake3 } from "@noble/hashes/blake3.js";

import type { ProjectReloadScope, ProjectReloadTargets } from "@/core/types";
import {
  checkPrecondition,
  classify,
  collectEntries,
  conflict,
  equalBytes,
  errorKind,
  getDirectory,
  getFile,
  getFileHandle,
  hex,
  nativeLineEndings,
  normalizeLineEndings,
  optionalFile,
  optionalFileHandle,
  safePath,
} from "@/platform/browserProjectFilesystem";
import {
  decodeProjectSource,
  decodeProtocolBytes,
  isScriptCategory,
  projectReloadScopeMatches,
  projectReloadSelector,
  runBounded,
  saveSlotName,
  storageDirectoryName,
  throwIfAborted,
} from "@/platform/browserProjectUtilities";
import { isPackagedProjectFontPath, type ProjectFontSource } from "@/platform/projectFonts";
import { scanBrowserProjectFilesOffThread } from "@/platform/browserProjectScanPool";
import type { ScannedFile } from "@/platform/browserProjectScanner";

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

const SOURCE_INDEX_VERSION = 1;
const SOURCE_INDEX_NAME = "source-index-v1.json";

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
  private readonly canonicalPaths = new Map<string, string>();
  private usesEmbeddedManifest = false;
  private manifestValue?: BrowserManifest;
  private pendingSnapshot?: PendingBrowserSnapshot;
  private packagedFile?: File;
  private packagedHandle?: FileSystemFileHandle;
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
    const enumerateStarted = performance.now();
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
    const enumerateMs = performance.now() - enumerateStarted;
    const files = new Array<ScannedFile>();
    const requests: Array<{ relativePath: string; file: File }> = [];
    const positions: number[] = [];
    const statStarted = performance.now();
    for (const candidate of candidates) {
      const prepared = preloaded?.get(candidate.relativePath);
      if (prepared) {
        files.push(prepared);
      } else {
        positions.push(files.length);
        files.push(undefined as unknown as ScannedFile);
        requests.push({
          relativePath: candidate.relativePath,
          file: await candidate.handle.getFile(),
        });
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
    files.sort(compareScannedFiles);
    this.scanMetricsValue = {
      ...emptyScanMetrics(),
      enumerateMs,
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
    progress?.(0, 0);
    const enumerateStarted = performance.now();
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
    const enumerateMs = performance.now() - enumerateStarted;
    const indexReadStarted = performance.now();
    const sourceIndex = await this.readSourceIndex();
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
      if (
        this.sourceIndexTrusted &&
        sourceIndex.valid &&
        isBrowserSourceIndexEntry(prior) &&
        prior.category === candidate.category &&
        prior.signature === signature &&
        prior.size === file.size &&
        /^[0-9a-f]{64}$/i.test(prior.hash)
      ) {
        reused[index] = true;
        files[index] = {
          relative_path: candidate.relativePath,
          category: candidate.category,
          payload: emptyPayload(candidate.category),
          content_hash: decodeHex(prior.hash),
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
      const prepared = reused[index] ? undefined : scanned;
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
    }
    progress?.(candidates.length, candidates.length);
    const next = Object.fromEntries(indexEntries);
    let indexWriteMs = 0;
    if (!this.sourceIndexTrusted || !sourceIndexesEqual(previous, next)) {
      const indexWriteStarted = performance.now();
      try {
        await this.writeSourceIndex(next);
      } catch (error) {
        await this.removeSourceIndex();
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
      const parts = request.relative_path ? safePath(request.relative_path).split("/") : [];
      const operation = request.operation;
      const readOnly = ["read", "stat", "read_range", "list"].includes(operation.type);
      const rootReadFallback = readOnly && ["project", "data"].includes(request.namespace);
      let result: any;
      try {
        const primary = await this.namespace(request.namespace, !rootReadFallback);
        result = await operateBrowserStorage(primary, parts, operation);
      } catch (error) {
        if (!rootReadFallback || errorKind(error) !== "not_found") throw error;
        result = await operateBrowserStorage(this.root, parts, operation);
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

  private async readSourceIndex(): Promise<{
    files: Record<string, BrowserSourceIndexEntry>;
    present: boolean;
    valid: boolean;
  }> {
    let file: File;
    try {
      const privateDirectory = await this.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      const handle = await cacheDirectory.getFileHandle(SOURCE_INDEX_NAME);
      file = await handle.getFile();
    } catch {
      return { files: {}, present: false, valid: false };
    }
    try {
      const value = JSON.parse(await file.text()) as {
        version?: unknown;
        files?: unknown;
      };
      const valid = value.version === SOURCE_INDEX_VERSION && isRecord(value.files);
      return {
        files: valid ? (value.files as Record<string, BrowserSourceIndexEntry>) : {},
        present: true,
        valid,
      };
    } catch {
      return { files: {}, present: true, valid: false };
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

  private async removeSourceIndex(): Promise<void> {
    try {
      const privateDirectory = await this.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      await cacheDirectory.removeEntry(SOURCE_INDEX_NAME);
    } catch (error) {
      if (errorKind(error) !== "not_found") throw error;
    }
  }

  private async namespace(namespace: string, create = true): Promise<FileSystemDirectoryHandle> {
    if (namespace === "resource") return this.root;
    return this.root.getDirectoryHandle(storageDirectoryName(namespace), { create });
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
          : file.payload,
      content_hash: [...file.content_hash],
    },
  };
}

async function operateBrowserStorage(
  root: FileSystemDirectoryHandle,
  parts: string[],
  operation: any,
): Promise<any> {
  if (operation.type === "read") {
    const file = await getFile(root, parts);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { type: "read", data: [...bytes], revision: hex(blake3(bytes)) };
  }
  if (operation.type === "write") {
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
    return { type: "written", revision: hex(blake3(bytes)) };
  }
  if (operation.type === "delete") {
    const parent = await getDirectory(root, parts.slice(0, -1), false);
    const handle = await parent.getFileHandle(parts.at(-1)!);
    await checkPrecondition(await optionalFile(handle), operation.precondition);
    await parent.removeEntry(parts.at(-1)!);
    return { type: "deleted" };
  }
  if (operation.type === "stat") {
    const file = await getFile(root, parts);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      type: "metadata",
      byte_length: file.size,
      revision: hex(blake3(bytes)),
    };
  }
  if (operation.type === "read_range") {
    const file = await getFile(root, parts);
    const token = `${file.size}:${file.lastModified}`;
    if (operation.change_token && operation.change_token !== token) throw conflict();
    const offset = Number(operation.offset);
    const end = Math.min(file.size, offset + Number(operation.maximum_bytes));
    const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    return {
      type: "read_chunk",
      data: [...data],
      offset: operation.offset,
      complete: end >= file.size,
      change_token: token,
    };
  }
  if (operation.type === "list") {
    const directory = await getDirectory(root, parts, false);
    const entries: any[] = [];
    const prefix = parts.length ? `${parts.join("/")}/` : "";
    await collectEntries(directory, prefix, operation.recursive, operation.pattern, entries);
    return { type: "listed", entries };
  }
  throw new Error(`不支持的存储操作：${operation.type}`);
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
