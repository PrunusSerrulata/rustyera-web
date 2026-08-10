import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectProgress,
  ProjectOpenMetrics,
  ProjectSelectionPreparation,
  ProjectSubmittedListener,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
  SystemFontQueryResult,
  TraditionalSaveAccess,
} from "@/core/types";
import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput } from "@/core/diagnosis";
import {
  pickBrowserDirectory,
  pickBrowserFile,
  pickBrowserProjectFile,
} from "@/platform/browserDirectory";
import { encodeBrowserManifest } from "@/platform/browserManifestCodec";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import {
  BrowserProject,
  cacheIdentityManifest,
  type BrowserManifest,
  saveSlotName,
} from "@/platform/browserProject";
import { database, loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { WorkerClient } from "@/platform/workerClient";
import { ProjectFontRegistry } from "@/platform/projectFonts";

const PROJECT_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export class BrowserBridge implements FrontendBridge {
  readonly kind = "browser" as const;
  readonly traditionalSaves: TraditionalSaveAccess = {
    listSlots: async () => {
      const project = this.requireProject();
      const count = await this.worker.call<number>("traditionalSaveSlotCount");
      return project.listTraditionalSaveSlots(count);
    },
    exportSlot: async (slot) => {
      const bytes = await this.requireProject().readTraditionalSave(slot);
      downloadBrowserFile(saveSlotName(slot), bytes);
    },
    pickImport: async () => {
      const file = await pickBrowserFile(".sav,application/octet-stream");
      return file
        ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
        : undefined;
    },
    inspect: (bytes) => this.worker.call("inspectTraditionalSave", bytes),
    writeSlot: (slot, bytes) => this.requireProject().writeTraditionalSave(slot, bytes),
  };
  private readonly worker = new WorkerClient();
  private readonly projectFontRegistry = new ProjectFontRegistry();
  private project?: BrowserProject;
  private cacheWriter?: FileSystemWritableFileStream;
  private discardCompiledCacheExport = false;
  private projectFileWriter?: FileSystemWritableFileStream;
  private projectFileExportAbort?: AbortController;
  private projectFileFallback?:
    | { name: string; chunks: Uint8Array[] }
    | {
        name: string;
        root: FileSystemDirectoryHandle;
        temporaryName: string;
        writer: FileSystemWritableFileStream;
      };
  private projectProgressListener?: (progress: ProjectProgress) => void;
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
    const project = new BrowserProject(handle, 1, picked.projectName);
    project.useConfigurationUpdatePreparer(this.prepareProjectConfigurationUpdate);
    const started = performance.now();
    const sourcesReady = picked.manifest != null;
    const manifest =
      picked.manifest ??
      (await project.scanQuick((completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ));
    if (picked.manifest) project.useImportedManifest(picked.manifest);
    const quickScanMs = sourcesReady ? 0 : performance.now() - started;
    const loaded = await this.loadSourceProject(project, manifest, sourcesReady);
    this.project = project;
    const projectFonts = await this.projectFontRegistry.replace(project.fontSources());
    return {
      submittedAtMs,
      quickScanMs,
      cacheReadMs: loaded.cacheReadMs,
      sourceReadMs: loaded.sourceReadMs,
      submitMs: loaded.submitMs,
      cacheImported: loaded.cacheImported,
      projectFonts,
    } satisfies ProjectOpenMetrics;
  }

  async openProjectFile(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const picked = await pickBrowserProjectFile();
    if (!picked) return undefined;
    const { file } = picked;
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await prepareAfterSelection?.();
    const started = performance.now();
    const bytes = await readProjectFile(file, (completed, total) =>
      this.projectProgressListener?.({ stage: "scanning", completed, total }),
    );
    const loaded = await this.worker.callWithTransfer<{
      manifest: BrowserManifest;
      storageKey: string;
    }>("loadProjectFile", [bytes], [bytes.buffer]);
    const manifest = loaded.manifest;
    const storageRoot = await navigator.storage.getDirectory();
    const projects = await storageRoot.getDirectoryHandle(".rustyera-project-files", {
      create: true,
    });
    const root = await projects.getDirectoryHandle(loaded.storageKey, { create: true });
    let writableFile = file;
    let writableHandle = picked.handle;
    if (!writableHandle) {
      writableHandle = await root.getFileHandle("project.reraproj", { create: true });
      const writer = await writableHandle.createWritable({ keepExistingData: false });
      try {
        await copyFileToWritable(file, writer);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }
      writableFile = await writableHandle.getFile();
    }
    this.project = new BrowserProject(
      root,
      manifest.project_revision,
      file.name.replace(/\.reraproj$/i, ""),
    );
    this.project.usePackagedFile(
      writableFile,
      writableHandle,
      this.prepareProjectConfigurationUpdate,
    );
    this.project.useEmbeddedManifest(manifest);
    const projectFonts = await this.projectFontRegistry.replace(this.project.fontSources());
    return {
      submittedAtMs,
      quickScanMs: 0,
      cacheReadMs: 0,
      sourceReadMs: 0,
      submitMs: performance.now() - started,
      cacheImported: true,
      projectFonts,
    };
  }

  async restartProject(onSubmitted?: ProjectSubmittedListener): Promise<ProjectOpenMetrics> {
    if (!this.project) throw new Error("没有打开的项目");
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    const embedded = this.project.embeddedManifest();
    if (embedded) {
      const bytes = await this.project.readCompiledCache();
      if (!bytes) throw new Error("项目缓存缺失");
      const started = performance.now();
      await this.worker.callWithTransfer(
        "loadProjectWithCompiledCache",
        [embedded, bytes],
        [bytes.buffer],
      );
      return {
        submittedAtMs,
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: performance.now() - started,
        cacheImported: true,
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
    return {
      submittedAtMs,
      quickScanMs,
      cacheReadMs: loaded.cacheReadMs,
      sourceReadMs: loaded.sourceReadMs,
      submitMs: loaded.submitMs,
      cacheImported: loaded.cacheImported,
      projectFonts: await this.projectFontRegistry.replace(this.project.fontSources()),
    };
  }

  async reloadProject() {
    if (!this.project) throw new Error("没有打开的项目");
    await this.submitRuntime({
      type: "reload_project",
      value: await this.project.reloadRequest((completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ),
    });
    return this.projectFontRegistry.replace(this.project.fontSources());
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
        await this.worker.callWithTransfer(
          "loadProjectWithCompiledCache",
          [cacheIdentityManifest(manifest), cache],
          [cache.buffer],
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

  loadPreferences(): Promise<Preferences> {
    return loadBrowserPreferences();
  }

  savePreferences(preferences: Preferences): Promise<Preferences> {
    return saveBrowserPreferences(preferences);
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
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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

  async stageFullProjectManifest(): Promise<void> {
    const project = this.requireProject();
    if (project.embeddedManifest()) return;
    const abort = new AbortController();
    this.projectFileExportAbort = abort;
    try {
      const manifest = await project.materialize(this.scanProgress, abort.signal);
      abort.signal.throwIfAborted();
      await this.submitRuntime({ type: "full_project_manifest", value: { manifest } });
    } finally {
      if (this.projectFileExportAbort === abort) this.projectFileExportAbort = undefined;
    }
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
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fallback.name;
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      void fallback.root.removeEntry(fallback.temporaryName);
    }, 0);
    this.projectFileFallback = undefined;
  }

  async cancelProjectFileExport(): Promise<void> {
    this.projectFileExportAbort?.abort(new DOMException("Export cancelled", "AbortError"));
    this.projectFileExportAbort = undefined;
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

  async saveDiagnosis(name: string, input: DiagnosisArchiveInput): Promise<boolean> {
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      const prefix = new Uint8Array(4);
      const projectMagic = input.projectFile.slice(0, 8);
      let size = 0;
      await streamDiagnosisArchiveInWorker(input, async (chunk) => {
        const prefixLength = Math.min(chunk.length, prefix.length - Math.min(size, prefix.length));
        if (prefixLength > 0) prefix.set(chunk.subarray(0, prefixLength), size);
        size += chunk.length;
      });
      (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({
        name,
        bytes: prefix,
        size,
        projectMagic,
      });
      return true;
    }

    if (window.showSaveFilePicker) {
      let handle: FileSystemFileHandle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: name });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return false;
        throw error;
      }
      const writer = await handle.createWritable({ keepExistingData: false });
      try {
        await streamDiagnosisArchiveInWorker(input, (chunk) =>
          writer.write(chunk as FileSystemWriteChunkType),
        );
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }
      return true;
    }

    const storageRoot = await navigator.storage.getDirectory();
    const temporaryName = `diagnosis-${crypto.randomUUID()}.tar.zst`;
    const handle = await storageRoot.getFileHandle(temporaryName, { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      await streamDiagnosisArchiveInWorker(input, (chunk) =>
        writer.write(chunk as FileSystemWriteChunkType),
      );
      await writer.close();
      const url = URL.createObjectURL(await handle.getFile());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        void storageRoot.removeEntry(temporaryName);
      }, 0);
      return true;
    } catch (error) {
      await writer.abort().catch(() => undefined);
      await storageRoot.removeEntry(temporaryName).catch(() => undefined);
      throw error;
    }
  }

  async writeCompiledCacheChunk(
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    if (reset) {
      this.discardCompiledCacheExport = false;
      const privateDirectory = await this.project.root.getDirectoryHandle(".rustyera", {
        create: true,
      });
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
      const handle = await cacheDirectory.getFileHandle("compiled-project.reracache", {
        create: true,
      });
      this.cacheWriter = await handle.createWritable({ keepExistingData: false });
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
    this.projectFontRegistry.clear();
    this.worker.close();
  }
}

async function readProjectFile(
  file: File,
  progress: (completed: number, total: number) => void,
): Promise<Uint8Array> {
  if (file.size === 0) return new Uint8Array(await file.arrayBuffer());
  const output = new Uint8Array(file.size);
  progress(0, file.size);
  for (let offset = 0; offset < file.size; offset += PROJECT_FILE_READ_CHUNK_BYTES) {
    const end = Math.min(file.size, offset + PROJECT_FILE_READ_CHUNK_BYTES);
    const blob = file.slice(offset, end);
    const buffer =
      typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await readBlobWithFileReader(blob);
    const chunk = new Uint8Array(buffer);
    output.set(chunk, offset);
    progress(end, file.size);
    await yieldToMainThread();
  }
  return output;
}

async function copyFileToWritable(file: File, writer: FileSystemWritableFileStream): Promise<void> {
  if (file.size === 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength) await writer.write(bytes as FileSystemWriteChunkType);
    return;
  }
  for (let offset = 0; offset < file.size; offset += PROJECT_FILE_READ_CHUNK_BYTES) {
    const end = Math.min(file.size, offset + PROJECT_FILE_READ_CHUNK_BYTES);
    const blob = file.slice(offset, end);
    const buffer =
      typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await readBlobWithFileReader(blob);
    await writer.write(new Uint8Array(buffer) as FileSystemWriteChunkType);
    await yieldToMainThread();
  }
}

function readBlobWithFileReader(blob: Blob): Promise<ArrayBuffer> {
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

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
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
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
