import {
  defaultPreferences,
  type DebugMessage,
  type ProjectProgress,
  type ProjectOpenMetrics,
  type ProjectReloadScope,
  type ProjectReloadTargets,
  type ProjectSelectionPreparation,
  type ProjectSubmittedListener,
  type PumpBatch,
  type RuntimeHostMemoryCounters,
  type RuntimeMessage,
  type SessionOptions,
} from "@/core/types";
import { requireCompatibilityIdentity } from "@/core/compatibility";
import { yieldToMainThread, yieldToPaint } from "@/platform/mainThread";
import { pickBrowserDirectory, pickBrowserProjectFile } from "@/platform/browserDirectory";
import { encodeBrowserManifest, streamBrowserManifestFiles } from "@/platform/browserManifestCodec";
import {
  BrowserProject,
  cacheIdentityManifest,
  type BrowserManifest,
} from "@/platform/browserProject";
import { database } from "@/platform/database";
import { WorkerClient } from "@/platform/workerClient";
import { ProjectFontRegistry } from "@/platform/projectFonts";
import { browserTraditionalSaves } from "@/platform/browserBridge/traditionalSaves";
import { BrowserProjectPreferenceStore } from "@/platform/projectPreferences";
import { isMemoryConstrainedBrowserHost } from "@/platform/browserMemoryPolicy";
import { normalizeProjectFileManifest } from "@/platform/projectFileManifestTransfer";
import { blake3 } from "@noble/hashes/blake3.js";
import { validateBrowserProjectFileSize } from "@/platform/projectFileWorker";
import { createBrowserSessionDirectory } from "@/platform/browserSessionFilesystem";
import { downloadBrowserBlob } from "@/platform/browserDownload";
import { hex } from "@/platform/browserProjectFilesystem";

const UNCONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ProjectOperation {
  id: number;
  session: number;
  worker: number;
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

export async function readProjectFile(
  file: File,
  progress: (completed: number, total: number) => void,
): Promise<{ bytes: Uint8Array; storageKey: string }> {
  validateBrowserProjectFileSize(file.size);
  const hasher = blake3.create();
  if (file.size === 0) {
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(file));
    hasher.update(bytes);
    return { bytes, storageKey: hex(hasher.digest()) };
  }
  const output = new Uint8Array(file.size);
  for (let offset = 0; offset < file.size; offset += UNCONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES) {
    const end = Math.min(file.size, offset + UNCONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES);
    const chunk = new Uint8Array(await readBlobAsArrayBuffer(file.slice(offset, end)));
    output.set(chunk, offset);
    hasher.update(chunk);
    progress(end, file.size);
    await yieldToMainThread();
  }
  return { bytes: output, storageKey: hex(hasher.digest()) };
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
      for (
        let offset = 0;
        offset < file.size;
        offset += UNCONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES
      ) {
        const bytes = new Uint8Array(
          await readBlobAsArrayBuffer(
            file.slice(offset, offset + UNCONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES),
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

function downloadBrowserFile(name: string, bytes: Uint8Array): void {
  if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
    (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({ name, bytes: new Uint8Array(bytes) });
    return;
  }
  downloadBrowserBlob(name, new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
}

export abstract class BrowserBridgeBase {
  protected abstract loadSelectedProjectFile<T>(
    file: File,
    compiledCache: Uint8Array | undefined,
    preparedBytes: Uint8Array | undefined,
    operation: ProjectOperation,
  ): Promise<T>;

  protected abstract loadSelectedProjectSource(
    file: File,
    operation: ProjectOperation,
  ): Promise<void>;

  protected abstract recordRuntimeMemory(batch: PumpBatch): PumpBatch;

  protected abstract requireProject(): BrowserProject;

  protected abstract retireCommittedProject(operation?: ProjectOperation): void;

  readonly kind = "browser" as const;
  readonly directProjectDirectoryAccess = typeof window.showDirectoryPicker === "function";
  readonly memoryConstrained = isMemoryConstrainedBrowserHost();
  readonly snapshotRestoreMode = "fresh_session" as const;
  readonly prewarmRuntimeOnInitialize = true;
  // The cooperative WASM encoder retains the compiled artifact while growing another project-sized
  // buffer. That speculative peak can terminate and reload an otherwise healthy constrained
  // browser immediately after compilation.
  readonly automaticCompiledCacheExport = !this.memoryConstrained;
  protected readonly worker = new WorkerClient();
  readonly traditionalSaves = browserTraditionalSaves({
    project: () => this.requireProject(),
    worker: this.worker,
    download: downloadBrowserFile,
  });
  protected readonly projectFontRegistry = new ProjectFontRegistry();
  protected project?: BrowserProject;
  protected projectOperation = 0;
  protected sessionGeneration = 0;
  protected projectDirectorySelectionRelease?: () => void;
  protected cacheWriter?: FileSystemWritableFileStream;
  protected discardCompiledCacheExport = false;
  protected projectFileWriter?: FileSystemWritableFileStream;
  protected stateExportWriter?: FileSystemWritableFileStream;
  protected projectFileExportAbort?: AbortController;
  protected fullManifestSpool?: import("@/platform/browserProject").BrowserFullManifestSpool;
  protected projectFileFallback?:
    | { name: string; chunks: ArrayBuffer[]; receivedBytes: number }
    | {
        name: string;
        root: FileSystemDirectoryHandle;
        temporaryName: string;
        writer: FileSystemWritableFileStream;
      };
  protected stateExportFallback?:
    | { name: string; chunks: ArrayBuffer[]; receivedBytes: number }
    | {
        name: string;
        root: FileSystemDirectoryHandle;
        temporaryName: string;
        writer: FileSystemWritableFileStream;
      };
  protected projectProgressListener?: (progress: ProjectProgress) => void;
  protected preferences = defaultPreferences();
  protected projectPreferenceStore?: BrowserProjectPreferenceStore;
  protected projectStoragePersistent = true;
  protected wasmLinearMemoryBytes: number | null = null;
  protected readonly prepareProjectConfigurationUpdate = (
    projectFile: Uint8Array,
    expectedDigest: Uint8Array,
    contents: string,
  ) =>
    this.worker.callWithTransfer<Uint8Array>(
      "prepareProjectConfigurationUpdate",
      [projectFile, expectedDigest, contents],
      [projectFile.buffer],
    );

  protected readonly scanProgress = (completed: number, total: number) =>
    this.projectProgressListener?.({ stage: "scanning", completed, total });

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.projectProgressListener = listener;
    this.worker.setProjectProgressListener(
      listener
        ? (progress) => {
            if (progress.memoryBytes != null) this.wasmLinearMemoryBytes = progress.memoryBytes;
            listener(progress);
          }
        : undefined,
    );
  }

  async createSession(options: SessionOptions): Promise<PumpBatch> {
    this.sessionGeneration += 1;
    return this.recordRuntimeMemory(
      await this.worker.call("create", {
        ...options,
        // The browser project remains the authoritative reload source. Keeping a second copy of
        // every decoded script inside WASM adds hundreds of MiB to large desktop projects while
        // providing no recovery capability that the directory/project-file transfer lacks.
        retainProjectSourcePayloads: false,
      }),
    );
  }

  async prepareSessionReplacement(): Promise<void> {
    this.sessionGeneration += 1;
    // WebAssembly linear memory can grow but cannot shrink. Replacing the Rust session inside the
    // same instance therefore cannot return a large old VM's pages. Every whole-session replacement
    // uses a fresh dedicated worker so the old instance and its linear memory are released together.
    try {
      await this.worker.restart(yieldToMainThread);
    } finally {
      this.wasmLinearMemoryBytes = null;
    }
  }

  runtimeMemoryCounters(): RuntimeHostMemoryCounters {
    return {
      workerGeneration: this.worker.generation,
      wasmLinearMemoryBytes: this.wasmLinearMemoryBytes,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    };
  }

  submitRuntime(message: RuntimeMessage, correlationId?: number | bigint): Promise<bigint> {
    const runtimeCorrelationId = correlationId == null ? undefined : BigInt(correlationId);
    const importChunk =
      message.type === "state_import_chunk" && message.value?.data instanceof Uint8Array
        ? message.value.data
        : undefined;
    if (importChunk)
      return this.worker.callWithTransfer(
        "submitRuntime",
        [message, runtimeCorrelationId],
        [importChunk.buffer as ArrayBuffer],
      );
    return this.worker.call("submitRuntime", message, runtimeCorrelationId);
  }

  submitDebug(message: DebugMessage, correlationId?: number | bigint): Promise<bigint> {
    return this.worker.call(
      "submitDebug",
      message,
      correlationId == null ? undefined : BigInt(correlationId),
    );
  }

  async pump(): Promise<PumpBatch> {
    return this.recordRuntimeMemory(await this.worker.call("pump"));
  }

  protected beginProjectOperation(): ProjectOperation {
    return {
      id: ++this.projectOperation,
      session: this.sessionGeneration,
      worker: this.worker.generation,
    };
  }

  protected assertProjectOperation(operation: ProjectOperation): void {
    if (
      operation.id !== this.projectOperation ||
      operation.session !== this.sessionGeneration ||
      operation.worker !== this.worker.generation
    )
      throw new Error("项目打开操作已取消或 Runtime 已替换");
  }

  protected async projectStep<T>(operation: ProjectOperation, task: () => Promise<T>): Promise<T> {
    this.assertProjectOperation(operation);
    const value = await task();
    this.assertProjectOperation(operation);
    return value;
  }

  protected async prepareProjectOpen(
    operation: ProjectOperation,
    prepare?: ProjectSelectionPreparation,
  ): Promise<void> {
    this.assertProjectOperation(operation);
    this.retireCommittedProject(operation);
    if (!prepare) return;
    await prepare();
    // Session creation inside the selected project's preparation is an authorized replacement.
    if (operation.id !== this.projectOperation) throw new Error("项目打开操作已取消");
    operation.session = this.sessionGeneration;
    operation.worker = this.worker.generation;
  }

  async openProject(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const operation = this.beginProjectOperation();
    this.project?.finalizeReload(false);
    let submittedAtMs = 0;
    let selectionPrepared = false;
    const picked = await pickBrowserDirectory(
      (stage, completed, total) => this.projectProgressListener?.({ stage, completed, total }),
      () => {
        this.assertProjectOperation(operation);
        submittedAtMs = performance.now();
        onSubmitted?.(submittedAtMs);
      },
      async () => {
        selectionPrepared = true;
        await this.prepareProjectOpen(operation, prepareAfterSelection);
      },
    );
    if (!picked) return undefined;
    let projectCommitted = false;
    try {
      this.assertProjectOperation(operation);
      if (submittedAtMs === 0) {
        submittedAtMs = performance.now();
        onSubmitted?.(submittedAtMs);
      }
      if (!selectionPrepared) {
        await this.prepareProjectOpen(operation, prepareAfterSelection);
      }
      const handle = picked.handle;
      // Playwright supplies an RPC-backed FileSystemDirectoryHandle which intentionally cannot be
      // structured-cloned into IndexedDB. Production handles continue to be persisted normally.
      if (picked.persistHandle && import.meta.env.VITE_RUSTYERA_TEST !== "1")
        await this.projectStep(operation, () =>
          database.handles.put({ key: "last-project", handle }),
        );
      const projectPreferenceStore = await this.projectStep(operation, () =>
        BrowserProjectPreferenceStore.source(handle),
      );
      const projectPreferences = projectPreferenceStore.values();
      const project = new BrowserProject(
        handle,
        1,
        picked.projectName,
        projectPreferences.trustProjectFileMetadata ?? this.preferences.trustProjectFileMetadata,
      );
      project.useConfigurationUpdatePreparer(this.prepareProjectConfigurationUpdate);
      const started = performance.now();
      const quickScanRequired = picked.manifest == null;
      let sourcesReady = !quickScanRequired;
      const manifest =
        picked.manifest ??
        (await project.scanQuick((completed, total) =>
          this.projectProgressListener?.({ stage: "scanning", completed, total }),
        ));
      this.assertProjectOperation(operation);
      sourcesReady ||= project.quickManifestHasAllSources();
      if (picked.manifest) {
        project.useImportedManifest(picked.manifest);
        if (picked.scanMetrics) project.useScanMetrics(picked.scanMetrics);
      }
      const quickScanMs = quickScanRequired ? performance.now() - started : 0;
      const loaded = await this.loadSourceProject(project, manifest, sourcesReady, operation);
      this.assertProjectOperation(operation);
      const previousRelease = this.projectDirectorySelectionRelease;
      this.projectStoragePersistent = picked.storagePersistent ?? true;
      this.projectPreferenceStore = projectPreferenceStore;
      this.project = project;
      this.projectDirectorySelectionRelease = picked.release;
      projectCommitted = true;
      previousRelease?.();
      const projectFonts = await this.projectStep(operation, () =>
        this.projectFontRegistry.replace(project.fontSources(), () =>
          this.assertProjectOperation(operation),
        ),
      );
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
        memoryConstrained: this.memoryConstrained,
        projectFonts,
      } satisfies ProjectOpenMetrics;
    } catch (error) {
      if (!projectCommitted) picked.release?.();
      throw error;
    }
  }

  async openProjectFile(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const operation = this.beginProjectOperation();
    this.project?.finalizeReload(false);
    const picked = await this.projectStep(operation, () => pickBrowserProjectFile());
    if (!picked) return undefined;
    const { file } = picked;
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await this.projectStep(operation, () => yieldToPaint());
    await this.prepareProjectOpen(operation, prepareAfterSelection);
    this.projectProgressListener?.({ stage: "scanning", completed: 0, total: file.size });
    await this.projectStep(operation, () => yieldToPaint());
    const started = performance.now();
    type LoadedProject = {
      manifest: unknown;
      storageKey: string;
      cacheImported: boolean;
    };
    let cacheReadMs = 0;
    let loaded: LoadedProject;
    let storage: PackagedProjectStorage;
    let project: BrowserProject;
    if (this.memoryConstrained) {
      loaded = await this.loadSelectedProjectFile<LoadedProject>(
        file,
        undefined,
        undefined,
        operation,
      );
      storage = await this.projectStep(operation, () =>
        openPackagedProjectStorage(loaded.storageKey),
      );
      project = new BrowserProject(storage.projectRoot, 1, file.name.replace(/\.reraproj$/i, ""));
    } else {
      const { bytes, storageKey } = await readProjectFile(file, (completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      );
      storage = await this.projectStep(operation, () => openPackagedProjectStorage(storageKey));
      project = new BrowserProject(storage.projectRoot, 1, file.name.replace(/\.reraproj$/i, ""));
      const packageManifest = normalizeProjectFileManifest(
        await this.projectStep(operation, () => this.worker.call("projectFileManifest", bytes)),
      );
      project.useOwnedEmbeddedManifest(packageManifest);
      await this.resolveCompatibility(project, packageManifest, operation);
      const cacheStarted = performance.now();
      this.projectProgressListener?.({ stage: "loading_cache", completed: 0, total: 0 });
      let compiledCache: Uint8Array | undefined;
      try {
        compiledCache = await project.readPersistedCompiledCache((completed, total) =>
          this.projectProgressListener?.({ stage: "loading_cache", completed, total }),
        );
      } catch (error) {
        this.assertProjectOperation(operation);
        console.warn("Ignoring unreadable packaged-project cache", error);
      }
      this.assertProjectOperation(operation);
      if (!compiledCache)
        this.projectProgressListener?.({ stage: "loading_cache", completed: 1, total: 1 });
      cacheReadMs = performance.now() - cacheStarted;
      try {
        loaded = await this.loadSelectedProjectFile<LoadedProject>(
          file,
          compiledCache,
          bytes,
          operation,
        );
      } catch (error) {
        this.assertProjectOperation(operation);
        if (!compiledCache) throw error;
        console.warn("Ignoring unusable packaged-project cache", error);
        compiledCache = undefined;
        loaded = await this.loadSelectedProjectFile<LoadedProject>(
          file,
          undefined,
          undefined,
          operation,
        );
      }
      if (loaded.storageKey !== storageKey) {
        if (compiledCache) throw new Error("项目文件缓存身份与 Runtime 返回值不一致");
        // Retain compatibility if an older Runtime used a different storage-key derivation.
        storage = await this.projectStep(operation, () =>
          openPackagedProjectStorage(loaded.storageKey),
        );
        project = new BrowserProject(storage.projectRoot, 1, file.name.replace(/\.reraproj$/i, ""));
      }
    }
    const manifest = normalizeProjectFileManifest(loaded.manifest);
    const root = storage.projectRoot;
    project.usePackagedFile(
      file,
      picked.handle,
      this.prepareProjectConfigurationUpdate,
      !picked.handle && !this.memoryConstrained && storage.persistent
        ? () => materializePackagedProjectFile(root, file)
        : undefined,
    );
    project.useOwnedEmbeddedManifest(manifest, (relativePath, maximumBytes) =>
      this.worker.call("readProjectFileResource", relativePath, maximumBytes),
    );
    await this.resolveCompatibility(project, manifest, operation);
    this.assertProjectOperation(operation);
    const previousRelease = this.projectDirectorySelectionRelease;
    this.projectPreferenceStore = storage.preferences;
    this.projectStoragePersistent = storage.persistent;
    this.project = project;
    this.projectDirectorySelectionRelease = undefined;
    previousRelease?.();
    const projectFonts = await this.projectStep(operation, () =>
      this.projectFontRegistry.replace(project.fontSources(), () =>
        this.assertProjectOperation(operation),
      ),
    );
    return {
      submittedAtMs,
      quickScanMs: 0,
      cacheReadMs,
      sourceReadMs: 0,
      submitMs: performance.now() - started,
      cacheImported: loaded.cacheImported,
      wasmMode: "single",
      memoryConstrained: this.memoryConstrained,
      projectFonts,
    };
  }

  async restartProject(onSubmitted?: ProjectSubmittedListener): Promise<ProjectOpenMetrics> {
    const operation = this.beginProjectOperation();
    const project = this.requireProject();
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    const embedded = project.embeddedManifest();
    if (embedded) {
      const file = await this.projectStep(operation, () => project.packagedProjectFile());
      if (!file) throw new Error("项目文件缓存缺失");
      this.projectProgressListener?.({ stage: "scanning", completed: 0, total: file.size });
      await this.projectStep(operation, () => yieldToPaint());
      const started = performance.now();
      const cacheStarted = performance.now();
      let compiledCache: Uint8Array | undefined;
      if (!this.memoryConstrained) {
        try {
          compiledCache = await project.readPersistedCompiledCache((completed, total) =>
            this.projectProgressListener?.({ stage: "loading_cache", completed, total }),
          );
        } catch (error) {
          this.assertProjectOperation(operation);
          console.warn("Ignoring unreadable packaged-project cache", error);
        }
      }
      this.assertProjectOperation(operation);
      const cacheReadMs = performance.now() - cacheStarted;
      let loaded: { cacheImported: boolean };
      try {
        loaded = await this.loadSelectedProjectFile(file, compiledCache, undefined, operation);
      } catch (error) {
        this.assertProjectOperation(operation);
        if (!compiledCache) throw error;
        console.warn("Ignoring unusable packaged-project cache", error);
        loaded = await this.loadSelectedProjectFile(file, undefined, undefined, operation);
      }
      return {
        submittedAtMs,
        quickScanMs: 0,
        cacheReadMs,
        sourceReadMs: 0,
        submitMs: performance.now() - started,
        cacheImported: loaded.cacheImported,
        wasmMode: "single",
        memoryConstrained: this.memoryConstrained,
        projectFonts: await this.projectStep(operation, () =>
          this.projectFontRegistry.replace(project.fontSources(), () =>
            this.assertProjectOperation(operation),
          ),
        ),
      };
    }
    const started = performance.now();
    const imported = project.importedManifest();
    const sourcesReady = imported != null;
    const manifest =
      imported ??
      (await project.scanQuick((completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ));
    this.assertProjectOperation(operation);
    const quickScanMs = sourcesReady ? 0 : performance.now() - started;
    const loaded = await this.loadSourceProject(project, manifest, sourcesReady, operation);
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
      memoryConstrained: this.memoryConstrained,
      projectFonts: await this.projectStep(operation, () =>
        this.projectFontRegistry.replace(project.fontSources(), () =>
          this.assertProjectOperation(operation),
        ),
      ),
    };
  }

  async projectReloadTargets(): Promise<ProjectReloadTargets> {
    return this.requireProject().projectReloadTargets();
  }

  async prepareProjectReloadBaseline(): Promise<void> {
    await this.requireProject().prepareReloadBaseline(this.scanProgress);
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
    if (success && this.memoryConstrained) {
      project.markRuntimeManifestSparse();
      project.releaseSubmittedSourcePayloads();
    }
    return success
      ? this.projectFontRegistry.replace(project.fontSources())
      : { fonts: [], errors: [] };
  }

  protected async loadSourceProject(
    project: BrowserProject,
    manifest: BrowserManifest,
    sourcesReady: boolean,
    operation: ProjectOperation,
  ): Promise<{
    cacheReadMs: number;
    sourceReadMs: number;
    submitMs: number;
    cacheImported: boolean;
  }> {
    await this.resolveCompatibility(project, manifest, operation);
    const cacheStarted = performance.now();
    this.projectProgressListener?.({ stage: "loading_cache", completed: 0, total: 0 });
    const cache = this.memoryConstrained
      ? undefined
      : await this.projectStep(operation, () =>
          project.readCompiledCache((completed, total) =>
            this.projectProgressListener?.({ stage: "loading_cache", completed, total }),
          ),
        );
    await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
    if (!cache) this.projectProgressListener?.({ stage: "loading_cache", completed: 1, total: 1 });
    const cacheReadMs = performance.now() - cacheStarted;
    const submitStarted = performance.now();
    let cacheImported = false;
    let sourceReadMs = 0;
    if (cache) {
      const identityManifest = await this.projectStep(operation, () =>
        encodeBrowserManifest(cacheIdentityManifest(manifest)),
      );
      await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
      try {
        await this.projectStep(operation, () =>
          this.worker.callWithTransfer(
            "loadProjectWithCompiledCacheBinary",
            [identityManifest, cache],
            [identityManifest.buffer, cache.buffer],
          ),
        );
        cacheImported = true;
        project.markRuntimeManifestSparse();
      } catch {
        this.assertProjectOperation(operation);
        await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
      }
    }
    if (!cacheImported) {
      const sourceStarted = performance.now();
      const sourceManifest = sourcesReady
        ? manifest
        : await this.projectStep(operation, () => project.materialize(this.scanProgress));
      sourceReadMs = performance.now() - sourceStarted;
      await this.submitSourceManifest(project, sourceManifest, operation);
    }
    this.assertProjectOperation(operation);
    return {
      cacheReadMs,
      sourceReadMs,
      submitMs: performance.now() - submitStarted - sourceReadMs,
      cacheImported,
    };
  }

  async submitProjectSource(): Promise<void> {
    const operation = this.beginProjectOperation();
    const project = this.requireProject();
    const embedded = project.embeddedManifest();
    if (embedded) {
      const file = await this.projectStep(operation, () => project.packagedProjectFile());
      if (!file) throw new Error("项目文件缓存缺失，无法回退到内嵌源码");
      await this.loadSelectedProjectSource(file, operation);
      return;
    }
    const manifest = await this.projectStep(operation, () =>
      project.materialize(this.scanProgress),
    );
    await this.submitSourceManifest(project, manifest, operation);
  }

  protected async resolveCompatibility(
    project: BrowserProject,
    manifest: BrowserManifest,
    operation = this.beginProjectOperation(),
  ): Promise<void> {
    const configuration = await this.projectStep(operation, () => project.rootConfiguration());
    const resolved = await this.projectStep(operation, () =>
      this.worker.call<{
        identity?: unknown;
        configuration_digest?: unknown;
        diagnostics: Array<{ message: string }>;
      }>("resolveProjectCompatibility", configuration ?? null),
    );
    if (resolved.identity == null)
      throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    const identity = requireCompatibilityIdentity(resolved.identity);
    if (
      manifest.compatibility &&
      JSON.stringify(manifest.compatibility) !== JSON.stringify(identity)
    )
      throw new Error("项目文件兼容身份与配置不一致");
    project.bindResolvedCompatibility(identity, resolved.configuration_digest);
    manifest.compatibility = identity;
    await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
  }

  protected async submitSourceManifest(
    project: BrowserProject,
    manifest: BrowserManifest,
    operation: ProjectOperation,
  ): Promise<void> {
    await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
    if (this.memoryConstrained) {
      try {
        await this.projectStep(operation, () =>
          this.worker.call(
            "beginProjectManifest",
            BigInt(manifest.project_revision),
            manifest.files.length,
            requireCompatibilityIdentity(manifest.compatibility),
          ),
        );
        await this.projectStep(operation, () =>
          streamBrowserManifestFiles(
            manifest,
            async (file) => {
              await this.projectStep(operation, () =>
                this.worker.callWithTransfer(
                  "appendProjectManifestFile",
                  [
                    file.source.relative_path,
                    file.category,
                    file.payloadTag,
                    file.payload,
                    file.contentHash,
                  ],
                  [file.payload.buffer, file.contentHash.buffer],
                ),
              );
              project.releaseSubmittedSourceFilePayload(file.source);
            },
            (completed, total) =>
              this.projectProgressListener?.({ stage: "submitting", completed, total }),
          ),
        );
        await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
        await this.projectStep(operation, () => this.worker.call("finishProjectManifest"));
      } catch (error) {
        // A cancelled upload belongs to its old worker; never cancel a replacement's upload.
        if (
          operation.id === this.projectOperation &&
          operation.session === this.sessionGeneration &&
          operation.worker === this.worker.generation
        )
          await this.worker.call("cancelProjectManifest").catch(() => undefined);
        project.releaseSubmittedSourcePayloads();
        throw error;
      }
      project.markRuntimeManifestSparse();
      project.releaseSubmittedSourcePayloads();
      return;
    }
    const encoded = await this.projectStep(operation, () =>
      encodeBrowserManifest(manifest, (completed, total) =>
        this.projectProgressListener?.({ stage: "submitting", completed, total }),
      ),
    );
    await this.projectStep(operation, () => project.validateResolvedConfiguration(manifest));
    await this.projectStep(operation, () =>
      this.worker.callWithTransfer("loadProjectBinary", [encoded], [encoded.buffer]),
    );
  }
}
