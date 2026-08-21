import {
  defaultPreferences,
  type DebugMessage,
  type FrontendBridge,
  type Preferences,
  type ProjectPreferences,
  type ProjectProgress,
  type ProjectOpenMetrics,
  type ProjectReloadScope,
  type ProjectReloadTargets,
  type ProjectSelectionPreparation,
  type ProjectSubmittedListener,
  type PumpBatch,
  type RuntimeMessage,
  type SessionOptions,
  type SystemFontQueryResult,
} from "@/core/types";
import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";
import { yieldToMainThread, yieldToPaint } from "@/platform/mainThread";
import {
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
} from "@/platform/browserDirectory";
import { encodeBrowserManifest } from "@/platform/browserManifestCodec";
import { saveBrowserDiagnosis } from "@/platform/browserBridge/diagnosisSave";
import {
  BrowserProject,
  cacheIdentityManifest,
  type BrowserManifest,
} from "@/platform/browserProject";
import { database, loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { WorkerClient } from "@/platform/workerClient";
import { ProjectFontRegistry } from "@/platform/projectFonts";
import { browserTraditionalSaves } from "@/platform/browserBridge/traditionalSaves";
import { BrowserProjectPreferenceStore } from "@/platform/projectPreferences";
import { needsLowMemoryProjectFileLoad } from "@/platform/browserProjectFilePolicy";
import { validateBrowserProjectFileSize } from "@/platform/projectFileWorker";
import { normalizeProjectFileManifest } from "@/platform/projectFileManifestTransfer";
import { createBrowserSessionDirectory } from "@/platform/browserSessionFilesystem";
import { downloadBrowserBlob } from "@/platform/browserDownload";

const DESKTOP_PROJECT_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const LOW_MEMORY_PROJECT_FILE_READ_CHUNK_BYTES = 1024 * 1024;

export class BrowserBridge implements FrontendBridge {
  readonly kind = "browser" as const;
  private readonly lowMemoryProjectFileLoad = needsLowMemoryProjectFileLoad();
  readonly prewarmRuntimeOnInitialize = true;
  private readonly worker = new WorkerClient();
  readonly traditionalSaves = browserTraditionalSaves({
    project: () => this.requireProject(),
    worker: this.worker,
    download: downloadBrowserFile,
  });
  private readonly projectFontRegistry = new ProjectFontRegistry();
  private project?: BrowserProject;
  private cacheWriter?: FileSystemWritableFileStream;
  private discardCompiledCacheExport = false;
  private projectFileWriter?: FileSystemWritableFileStream;
  private projectFileExportAbort?: AbortController;
  private fullManifestSpool?: import("@/platform/browserProject").BrowserFullManifestSpool;
  private projectFileFallback?:
    | { name: string; chunks: Uint8Array[] }
    | {
        name: string;
        root: FileSystemDirectoryHandle;
        temporaryName: string;
        writer: FileSystemWritableFileStream;
      };
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private preferences = defaultPreferences();
  private projectPreferenceStore?: BrowserProjectPreferenceStore;
  private projectStoragePersistent = true;
  private readonly prepareProjectConfigurationUpdate = (
    projectFile: Uint8Array,
    expectedDigest: Uint8Array,
    contents: string,
  ) =>
    this.worker.callWithTransfer<Uint8Array>(
      "prepareProjectConfigurationUpdate",
      [projectFile, expectedDigest, contents],
      [projectFile.buffer],
    );

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.worker.setProjectProgressListener(listener);
    this.projectProgressListener = listener;
  }

  createSession(options: SessionOptions): Promise<PumpBatch> {
    return this.worker.call("create", options);
  }

  submitRuntime(message: RuntimeMessage, correlationId?: number | bigint): Promise<bigint> {
    return this.worker.call(
      "submitRuntime",
      message,
      correlationId == null ? undefined : BigInt(correlationId),
    );
  }

  submitDebug(message: DebugMessage, correlationId?: number | bigint): Promise<bigint> {
    return this.worker.call(
      "submitDebug",
      message,
      correlationId == null ? undefined : BigInt(correlationId),
    );
  }

  pump(): Promise<PumpBatch> {
    return this.worker.call("pump");
  }

  async openProject(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    this.project?.finalizeReload(false);
    let submittedAtMs = 0;
    const picked = await pickBrowserDirectory(
      (stage, completed, total) => this.projectProgressListener?.({ stage, completed, total }),
      () => {
        submittedAtMs = performance.now();
        onSubmitted?.(submittedAtMs);
      },
      prepareAfterSelection,
    );
    if (!picked) return undefined;
    if (submittedAtMs === 0) {
      submittedAtMs = performance.now();
      onSubmitted?.(submittedAtMs);
    }
    const handle = picked.handle;
    // Playwright supplies an RPC-backed FileSystemDirectoryHandle which intentionally cannot be
    // structured-cloned into IndexedDB. Production handles continue to be persisted normally.
    if (picked.persistHandle && import.meta.env.VITE_RUSTYERA_TEST !== "1")
      await database.handles.put({ key: "last-project", handle });
    this.projectStoragePersistent = true;
    this.projectPreferenceStore = await BrowserProjectPreferenceStore.source(handle);
    const projectPreferences = this.projectPreferenceStore.values();
    const project = new BrowserProject(
      handle,
      1,
      picked.projectName,
      projectPreferences.trustProjectFileMetadata ?? this.preferences.trustProjectFileMetadata,
    );
    project.useConfigurationUpdatePreparer(this.prepareProjectConfigurationUpdate);
    const started = performance.now();
    const sourcesReady = picked.manifest != null;
    const manifest =
      picked.manifest ??
      (await project.scanQuick((completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ));
    if (picked.manifest) {
      project.useImportedManifest(picked.manifest);
      if (picked.scanMetrics) project.useScanMetrics(picked.scanMetrics);
    }
    const quickScanMs = sourcesReady ? 0 : performance.now() - started;
    const loaded = await this.loadSourceProject(project, manifest, sourcesReady);
    this.project = project;
    const projectFonts = await this.projectFontRegistry.replace(project.fontSources());
    const indexStats = project.sourceIndexStats();
    const scanMetrics = project.scanMetrics();
    return {
      submittedAtMs,
      quickScanMs,
      cacheReadMs: loaded.cacheReadMs,
      sourceReadMs: loaded.sourceReadMs,
      submitMs: loaded.submitMs,
      cacheImported: loaded.cacheImported,
      sourceIndexTrusted: indexStats.trusted,
      sourceIndexReusedFiles: indexStats.reusedFiles,
      sourceIndexHashedFiles: indexStats.hashedFiles,
      sourceIndexPresent: scanMetrics.sourceIndexPresent,
      enumerateMs: scanMetrics.enumerateMs,
      indexReadMs: scanMetrics.indexReadMs,
      indexWriteMs: scanMetrics.indexWriteMs,
      statMs: scanMetrics.statMs,
      sourceReadDecodeHashMs: scanMetrics.sourceReadDecodeHashMs + loaded.sourceReadMs,
      submissionTransferMs: loaded.submitMs,
      wasmMode: "single",
      projectFonts,
    } satisfies ProjectOpenMetrics;
  }

  async openProjectFile(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    this.project?.finalizeReload(false);
    const picked = await pickBrowserProjectFile();
    if (!picked) return undefined;
    const { file } = picked;
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await yieldToPaint();
    await prepareAfterSelection?.();
    this.projectProgressListener?.({ stage: "scanning", completed: 0, total: file.size });
    await yieldToPaint();
    const started = performance.now();
    const loaded = await this.loadSelectedProjectFile<{
      manifest: unknown;
      storageKey: string;
      cacheImported: boolean;
    }>(file);
    const manifest = normalizeProjectFileManifest(loaded.manifest);
    const storage = await openPackagedProjectStorage(loaded.storageKey);
    this.projectPreferenceStore = storage.preferences;
    this.projectStoragePersistent = storage.persistent;
    const root = storage.projectRoot;
    this.project = new BrowserProject(
      root,
      manifest.project_revision,
      file.name.replace(/\.reraproj$/i, ""),
    );
    this.project.usePackagedFile(
      file,
      picked.handle,
      this.prepareProjectConfigurationUpdate,
      !picked.handle && !this.lowMemoryProjectFileLoad && storage.persistent
        ? () => materializePackagedProjectFile(root, file)
        : undefined,
    );
    this.project.useOwnedEmbeddedManifest(manifest, (relativePath, maximumBytes) =>
      this.worker.call("readProjectFileResource", relativePath, maximumBytes),
    );
    const projectFonts = await this.projectFontRegistry.replace(this.project.fontSources());
    return {
      submittedAtMs,
      quickScanMs: 0,
      cacheReadMs: 0,
      sourceReadMs: 0,
      submitMs: performance.now() - started,
      cacheImported: loaded.cacheImported,
      wasmMode: "single",
      projectFonts,
    };
  }

  async restartProject(onSubmitted?: ProjectSubmittedListener): Promise<ProjectOpenMetrics> {
    if (!this.project) throw new Error("没有打开的项目");
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    const embedded = this.project.embeddedManifest();
    if (embedded) {
      const file = await this.project.packagedProjectFile();
      if (!file) throw new Error("项目文件缓存缺失");
      this.projectProgressListener?.({ stage: "scanning", completed: 0, total: file.size });
      await yieldToPaint();
      const started = performance.now();
      const loaded = await this.loadSelectedProjectFile<{ cacheImported: boolean }>(file);
      return {
        submittedAtMs,
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: performance.now() - started,
        cacheImported: loaded.cacheImported,
        wasmMode: "single",
        projectFonts: await this.projectFontRegistry.replace(this.project.fontSources()),
      };
    }
    const started = performance.now();
    const imported = this.project.importedManifest();
    const sourcesReady = imported != null;
    const manifest =
      imported ??
      (await this.project.scanQuick((completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ));
    const quickScanMs = sourcesReady ? 0 : performance.now() - started;
    const loaded = await this.loadSourceProject(this.project, manifest, sourcesReady);
    const indexStats = this.project.sourceIndexStats();
    const scanMetrics = this.project.scanMetrics();
    return {
      submittedAtMs,
      quickScanMs,
      cacheReadMs: loaded.cacheReadMs,
      sourceReadMs: loaded.sourceReadMs,
      submitMs: loaded.submitMs,
      cacheImported: loaded.cacheImported,
      sourceIndexTrusted: indexStats.trusted,
      sourceIndexReusedFiles: indexStats.reusedFiles,
      sourceIndexHashedFiles: indexStats.hashedFiles,
      sourceIndexPresent: scanMetrics.sourceIndexPresent,
      enumerateMs: scanMetrics.enumerateMs,
      indexReadMs: scanMetrics.indexReadMs,
      indexWriteMs: scanMetrics.indexWriteMs,
      statMs: scanMetrics.statMs,
      sourceReadDecodeHashMs: scanMetrics.sourceReadDecodeHashMs + loaded.sourceReadMs,
      submissionTransferMs: loaded.submitMs,
      wasmMode: "single",
      projectFonts: await this.projectFontRegistry.replace(this.project.fontSources()),
    };
  }

  async projectReloadTargets(): Promise<ProjectReloadTargets> {
    if (!this.project) throw new Error("没有打开的项目");
    return this.project.projectReloadTargets();
  }

  async prepareProjectReloadBaseline(): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    await this.project.prepareReloadBaseline(this.scanProgress);
  }

  async reloadProject(scope: ProjectReloadScope) {
    if (!this.project) throw new Error("没有打开的项目");
    try {
      const messageId = await this.submitRuntime({
        type: "reload_project",
        value: await this.project.reloadRequest(scope, (completed, total) =>
          this.projectProgressListener?.({ stage: "scanning", completed, total }),
        ),
      });
      return { fonts: [], errors: [], messageId };
    } catch (error) {
      this.project.finalizeReload(false);
      throw error;
    }
  }

  async finalizeProjectReload(success: boolean) {
    const project = this.requireProject();
    project.finalizeReload(success);
    return success
      ? this.projectFontRegistry.replace(project.fontSources())
      : { fonts: [], errors: [] };
  }

  private async loadSourceProject(
    project: BrowserProject,
    manifest: BrowserManifest,
    sourcesReady: boolean,
  ): Promise<{
    cacheReadMs: number;
    sourceReadMs: number;
    submitMs: number;
    cacheImported: boolean;
  }> {
    const cacheStarted = performance.now();
    this.projectProgressListener?.({ stage: "loading_cache", completed: 0, total: 0 });
    const cache = await project.readCompiledCache((completed, total) =>
      this.projectProgressListener?.({ stage: "loading_cache", completed, total }),
    );
    if (!cache) this.projectProgressListener?.({ stage: "loading_cache", completed: 1, total: 1 });
    const cacheReadMs = performance.now() - cacheStarted;
    const submitStarted = performance.now();
    let cacheImported = false;
    let sourceReadMs = 0;
    if (cache) {
      try {
        const identityManifest = await encodeBrowserManifest(cacheIdentityManifest(manifest));
        await this.worker.callWithTransfer(
          "loadProjectWithCompiledCacheBinary",
          [identityManifest, cache],
          [identityManifest.buffer, cache.buffer],
        );
        cacheImported = true;
        project.markRuntimeManifestSparse();
      } catch {
        const sourceStarted = performance.now();
        const sourceManifest = sourcesReady
          ? manifest
          : await project.materialize(this.scanProgress);
        sourceReadMs = performance.now() - sourceStarted;
        await this.submitSourceManifest(sourceManifest);
      }
    } else {
      const sourceStarted = performance.now();
      const sourceManifest = sourcesReady ? manifest : await project.materialize(this.scanProgress);
      sourceReadMs = performance.now() - sourceStarted;
      await this.submitSourceManifest(sourceManifest);
    }
    return {
      cacheReadMs,
      sourceReadMs,
      submitMs: performance.now() - submitStarted - sourceReadMs,
      cacheImported,
    };
  }

  async submitProjectSource(): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    const embedded = this.project.embeddedManifest();
    if (embedded) {
      throw new Error("项目文件与当前 runtime 不兼容，无法回退到外部源码");
    }
    await this.submitSourceManifest(await this.project.materialize(this.scanProgress));
  }

  private readonly scanProgress = (completed: number, total: number) =>
    this.projectProgressListener?.({ stage: "scanning", completed, total });

  private async submitSourceManifest(manifest: BrowserManifest): Promise<void> {
    const encoded = await encodeBrowserManifest(manifest, (completed, total) =>
      this.projectProgressListener?.({ stage: "submitting", completed, total }),
    );
    await this.worker.callWithTransfer("loadProjectBinary", [encoded], [encoded.buffer]);
  }

  readResource(relativePath: string): Promise<Uint8Array> {
    if (!this.project) return Promise.reject(new Error("没有打开的项目"));
    return this.project.readResource(relativePath);
  }

  async readImageMetadata(relativePath: string): Promise<ReturnType<typeof decodeImageMetadata>> {
    if (!this.project) throw new Error("没有打开的项目");
    return decodeImageMetadata(await this.project.readResourcePrefix(relativePath, 1024 * 1024));
  }

  handleStorage(request: any): Promise<any> {
    if (!this.project) return Promise.reject(new Error("没有打开的项目"));
    return this.project.storage(request);
  }

  listFonts(): Promise<SystemFontQueryResult> {
    return queryBrowserSystemFonts(
      window.queryLocalFonts ? () => window.queryLocalFonts!() : undefined,
    );
  }

  async loadPreferences(): Promise<Preferences> {
    this.preferences = await loadBrowserPreferences();
    return this.preferences;
  }

  async savePreferences(preferences: Preferences): Promise<Preferences> {
    this.preferences = await saveBrowserPreferences(preferences);
    this.applyEffectiveMetadataTrust();
    return this.preferences;
  }

  currentProjectPreferences(): ProjectPreferences | undefined {
    return this.projectPreferenceStore?.values();
  }

  async saveProjectPreferences(preferences: ProjectPreferences): Promise<ProjectPreferences> {
    if (!this.projectPreferenceStore) return Promise.reject(new Error("没有打开的项目"));
    const saved = await this.projectPreferenceStore.save(preferences);
    this.applyEffectiveMetadataTrust(saved);
    return saved;
  }

  private applyEffectiveMetadataTrust(project = this.projectPreferenceStore?.values()): void {
    this.project?.setSourceIndexTrusted(
      project?.trustProjectFileMetadata ?? this.preferences.trustProjectFileMetadata,
    );
  }

  projectPreferencesWritable(): boolean {
    return this.projectPreferenceStore?.writable ?? false;
  }

  projectConfigurationWritable(): boolean {
    return this.project?.configurationWritable() ?? false;
  }

  async writeProjectConfiguration(expectedDigest: Uint8Array, contents: string): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    if (this.cacheWriter) {
      const writer = this.cacheWriter;
      this.cacheWriter = undefined;
      this.discardCompiledCacheExport = true;
      await writer.abort().catch(() => undefined);
      await this.project.invalidateCompiledCache();
    }
    await this.project.writeConfiguration(expectedDigest, contents);
  }

  applyProjectConfiguration(): Promise<void> {
    return Promise.resolve();
  }

  projectName(): string | undefined {
    return this.project?.name;
  }

  async openUpload(): Promise<Uint8Array | undefined> {
    const file = await pickBrowserFile(".snapshot,application/octet-stream");
    return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }

  async saveDownload(name: string, bytes: Uint8Array): Promise<boolean> {
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({ name, bytes: new Uint8Array(bytes) });
      return true;
    }
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writer = await handle.createWritable();
      await writer.write(bytes as FileSystemWriteChunkType);
      await writer.close();
      return true;
    }
    downloadBrowserBlob(name, new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    return true;
  }

  async beginProjectFileExport(name: string): Promise<boolean> {
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      this.projectFileFallback = { name, chunks: [] };
      return true;
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [
            {
              description: "RustyEra 项目",
              accept: { "application/octet-stream": [".reraproj"] },
            },
          ],
        });
        this.projectFileWriter = await handle.createWritable({ keepExistingData: false });
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return false;
        throw error;
      }
    }
    try {
      const root = await navigator.storage.getDirectory();
      const temporaryName = `.rustyera-project-export-${crypto.randomUUID()}.tmp`;
      const handle = await root.getFileHandle(temporaryName, { create: true });
      const writer = await handle.createWritable({ keepExistingData: false });
      this.projectFileFallback = { name, root, temporaryName, writer };
    } catch {
      // Some browsers expose OPFS but deny it in private or constrained contexts.
      this.projectFileFallback = { name, chunks: [] };
    }
    return true;
  }

  async stageFullProjectManifest(): Promise<{ totalBytes: number } | undefined> {
    const project = this.requireProject();
    if (project.embeddedManifest()) return undefined;
    const abort = new AbortController();
    this.projectFileExportAbort = abort;
    try {
      await this.releaseFullProjectManifest();
      abort.signal.throwIfAborted();
      this.fullManifestSpool = await project.stageFullManifest(this.scanProgress, abort.signal);
      abort.signal.throwIfAborted();
      return { totalBytes: this.fullManifestSpool.totalBytes };
    } finally {
      if (this.projectFileExportAbort === abort) this.projectFileExportAbort = undefined;
    }
  }

  async readFullProjectManifestChunk(offset: number, maximumBytes: number): Promise<Uint8Array> {
    if (!this.fullManifestSpool) throw new Error("完整项目 manifest 尚未暂存");
    return this.fullManifestSpool.read(offset, maximumBytes);
  }

  async releaseFullProjectManifest(): Promise<void> {
    const spool = this.fullManifestSpool;
    this.fullManifestSpool = undefined;
    await spool?.release();
  }

  async writeProjectFileChunk(
    bytes: Uint8Array,
    _reset: boolean,
    complete: boolean,
  ): Promise<void> {
    if (this.projectFileWriter) {
      await this.projectFileWriter.write(bytes as FileSystemWriteChunkType);
      if (complete) {
        await this.projectFileWriter.close();
        this.projectFileWriter = undefined;
      }
      return;
    }
    const fallback = this.projectFileFallback;
    if (!fallback) throw new Error("项目文件导出尚未开始");
    if ("chunks" in fallback) {
      fallback.chunks.push(new Uint8Array(bytes));
      if (!complete) return;
      const result = new Uint8Array(fallback.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of fallback.chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      downloadBrowserFile(fallback.name, result);
      this.projectFileFallback = undefined;
      return;
    }
    await fallback.writer.write(bytes as FileSystemWriteChunkType);
    if (!complete) return;
    await fallback.writer.close();
    const file = await (await fallback.root.getFileHandle(fallback.temporaryName)).getFile();
    downloadBrowserBlob(fallback.name, file);
    setTimeout(() => {
      void fallback.root.removeEntry(fallback.temporaryName);
    }, 0);
    this.projectFileFallback = undefined;
  }

  async cancelProjectFileExport(): Promise<void> {
    this.projectFileExportAbort?.abort(new DOMException("Export cancelled", "AbortError"));
    this.projectFileExportAbort = undefined;
    await this.releaseFullProjectManifest().catch(() => undefined);
    if (this.projectFileWriter) {
      await this.projectFileWriter.abort().catch(() => undefined);
      this.projectFileWriter = undefined;
    }
    const fallback = this.projectFileFallback;
    this.projectFileFallback = undefined;
    if (fallback && "writer" in fallback) {
      await fallback.writer.abort().catch(() => undefined);
      await fallback.root.removeEntry(fallback.temporaryName).catch(() => undefined);
    }
  }

  private requireProject(): BrowserProject {
    if (!this.project) throw new Error("没有打开的项目");
    return this.project;
  }

  async saveDiagnosis(
    name: string,
    input: DiagnosisArchiveInput,
    reportProgress?: (progress: DiagnosisArchiveProgress) => void,
  ): Promise<boolean> {
    return saveBrowserDiagnosis(this.worker, name, input, reportProgress);
  }

  async writeCompiledCacheChunk(
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    if (reset) {
      this.discardCompiledCacheExport = !this.projectStoragePersistent;
      if (this.discardCompiledCacheExport) {
        this.cacheWriter = undefined;
      } else {
        const privateDirectory = await this.project.root.getDirectoryHandle(".rustyera", {
          create: true,
        });
        const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
        const handle = await cacheDirectory.getFileHandle("compiled-project.reracache", {
          create: true,
        });
        this.cacheWriter = await handle.createWritable({ keepExistingData: false });
      }
    }
    if (this.discardCompiledCacheExport) {
      if (complete) this.discardCompiledCacheExport = false;
      return;
    }
    if (!this.cacheWriter) throw new Error("编译缓存写入尚未开始");
    await this.cacheWriter.write(bytes as FileSystemWriteChunkType);
    if (complete) {
      await this.cacheWriter.close();
      this.cacheWriter = undefined;
      const privateDirectory = await this.project.root.getDirectoryHandle(".rustyera");
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
      await cacheDirectory.removeEntry("compiled-project.reraproj").catch(() => undefined);
    }
  }

  async cancelCompiledCacheExport(): Promise<void> {
    const writer = this.cacheWriter;
    this.cacheWriter = undefined;
    this.discardCompiledCacheExport = false;
    await writer?.abort();
  }

  async close(): Promise<void> {
    this.project?.finalizeReload(false);
    this.projectFontRegistry.clear();
    this.worker.close();
  }

  private async loadSelectedProjectFile<T>(file: File): Promise<T> {
    if (this.lowMemoryProjectFileLoad) {
      return this.worker.call<T>("loadProjectFile", file, {
        chunkBytes: LOW_MEMORY_PROJECT_FILE_READ_CHUNK_BYTES,
      });
    }
    const bytes = await readProjectFile(file, (completed, total) =>
      this.projectProgressListener?.({ stage: "scanning", completed, total }),
    );
    return this.worker.callWithTransfer<T>("loadProjectFileBytes", [bytes], [bytes.buffer]);
  }
}

interface PackagedProjectStorage {
  projectRoot: FileSystemDirectoryHandle;
  preferences: BrowserProjectPreferenceStore;
  persistent: boolean;
}

async function openPackagedProjectStorage(storageKey: string): Promise<PackagedProjectStorage> {
  const getDirectory = navigator.storage?.getDirectory;
  if (typeof getDirectory !== "function") return sessionPackagedProjectStorage(storageKey);
  try {
    const storageRoot = await getDirectory.call(navigator.storage);
    const preferences = await BrowserProjectPreferenceStore.packaged(storageRoot, storageKey);
    const projects = await storageRoot.getDirectoryHandle(".rustyera-project-files", {
      create: true,
    });
    const projectRoot = await projects.getDirectoryHandle(storageKey, { create: true });
    return { projectRoot, preferences, persistent: true };
  } catch (error) {
    console.warn("Persistent packaged-project storage is unavailable", error);
    return sessionPackagedProjectStorage(storageKey);
  }
}

function sessionPackagedProjectStorage(storageKey: string): PackagedProjectStorage {
  return {
    projectRoot: createBrowserSessionDirectory(storageKey),
    preferences: BrowserProjectPreferenceStore.session(),
    persistent: false,
  };
}

async function readProjectFile(
  file: File,
  progress: (completed: number, total: number) => void,
): Promise<Uint8Array> {
  validateBrowserProjectFileSize(file.size);
  if (file.size === 0) return new Uint8Array(await readBlobAsArrayBuffer(file));
  const output = new Uint8Array(file.size);
  for (let offset = 0; offset < file.size; offset += DESKTOP_PROJECT_FILE_READ_CHUNK_BYTES) {
    const end = Math.min(file.size, offset + DESKTOP_PROJECT_FILE_READ_CHUNK_BYTES);
    output.set(new Uint8Array(await readBlobAsArrayBuffer(file.slice(offset, end))), offset);
    progress(end, file.size);
    await yieldToMainThread();
  }
  return output;
}

async function materializePackagedProjectFile(
  root: FileSystemDirectoryHandle,
  file: File,
): Promise<FileSystemFileHandle> {
  const handle = await root.getFileHandle("project.reraproj", { create: true });
  const writer = await handle.createWritable({ keepExistingData: false });
  try {
    if (file.size === 0) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength) await writer.write(bytes as FileSystemWriteChunkType);
    } else {
      for (let offset = 0; offset < file.size; offset += DESKTOP_PROJECT_FILE_READ_CHUNK_BYTES) {
        const bytes = new Uint8Array(
          await readBlobAsArrayBuffer(
            file.slice(offset, offset + DESKTOP_PROJECT_FILE_READ_CHUNK_BYTES),
          ),
        );
        await writer.write(bytes as FileSystemWriteChunkType);
        await yieldToMainThread();
      }
    }
    await writer.close();
    return handle;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await root.removeEntry("project.reraproj").catch(() => undefined);
    throw error;
  }
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("项目文件读取失败"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("项目文件读取结果不是二进制数据"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

export async function queryBrowserSystemFonts(
  query: Window["queryLocalFonts"],
): Promise<SystemFontQueryResult> {
  if (!query) return { kind: "unsupported" };
  try {
    const available = await query();
    const unique = new Map<string, string>();
    for (const font of available) {
      const family = font.family.trim();
      const key = family.toLowerCase();
      if (family && !unique.has(key)) unique.set(key, family);
    }
    return {
      kind: "ready",
      fonts: [...unique.values()].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
      ),
    };
  } catch (error) {
    const name =
      typeof error === "object" && error != null && "name" in error ? String(error.name) : "";
    if (name === "NotAllowedError" || name === "SecurityError") return { kind: "denied" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function downloadBrowserFile(name: string, bytes: Uint8Array): void {
  if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
    (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({ name, bytes: new Uint8Array(bytes) });
    return;
  }
  downloadBrowserBlob(name, new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
}
