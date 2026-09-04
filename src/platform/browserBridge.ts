import {
  type FrontendBridge,
  type Preferences,
  type ProjectPreferences,
  type PumpBatch,
  type SystemFontQueryResult,
} from "@/core/types";

import { decodeImageMetadata } from "@/core/imageMetadata";

import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";

import { pickBrowserFileBytes } from "@/platform/browserDirectory";

import { saveBrowserDiagnosis } from "@/platform/browserBridge/diagnosisSave";

import { BrowserProject } from "@/platform/browserProject";

import { loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";

import { downloadBrowserBlob } from "@/platform/browserDownload";

import {
  BrowserBridgeBase,
  readProjectFile,
  type ProjectOperation,
} from "@/platform/browserBridgeBase";

const CONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES = 1024 * 1024;

const MAXIMUM_IN_MEMORY_PROJECT_EXPORT_BYTES = 64 * 1024 * 1024;

const MAXIMUM_IN_MEMORY_STATE_EXPORT_BYTES = 64 * 1024 * 1024;

const MAXIMUM_STATE_IMPORT_BYTES = 256 * 1024 * 1024;

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

function exactBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

export class BrowserBridge extends BrowserBridgeBase implements FrontendBridge {
  readResource(relativePath: string): Promise<Uint8Array> {
    if (!this.project) return Promise.reject(new Error("没有打开的项目"));
    return this.project.readResource(relativePath);
  }

  async readImageMetadata(relativePath: string): Promise<ReturnType<typeof decodeImageMetadata>> {
    return decodeImageMetadata(
      await this.requireProject().readResourcePrefix(relativePath, 1024 * 1024),
    );
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
    const store = this.projectPreferenceStore;
    if (!store) throw new Error("没有打开的项目");
    const saved = await store.save(preferences);
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
    return pickBrowserFileBytes(".snapshot,application/octet-stream", MAXIMUM_STATE_IMPORT_BYTES);
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

  async beginStateExport(name: string, totalBytes: number): Promise<boolean> {
    await this.cancelStateExport();
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0)
      throw new Error("Runtime 返回了无效的状态导出长度");
    if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
      if (totalBytes > MAXIMUM_IN_MEMORY_STATE_EXPORT_BYTES)
        throw new Error("测试环境的状态导出超过 64 MiB 安全限制");
      this.stateExportFallback = { name, chunks: [], receivedBytes: 0 };
      return true;
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        this.stateExportWriter = await handle.createWritable({ keepExistingData: false });
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return false;
        throw error;
      }
    }
    try {
      const root = await navigator.storage.getDirectory();
      const temporaryName = `.rustyera-state-export-${crypto.randomUUID()}.tmp`;
      const handle = await root.getFileHandle(temporaryName, { create: true });
      const writer = await handle.createWritable({ keepExistingData: false });
      this.stateExportFallback = { name, root, temporaryName, writer };
    } catch {
      if (totalBytes > MAXIMUM_IN_MEMORY_STATE_EXPORT_BYTES)
        throw new Error(
          `当前浏览器没有可用的流式文件写入能力，状态导出超过 ${MAXIMUM_IN_MEMORY_STATE_EXPORT_BYTES / 1024 / 1024} MiB，已拒绝以避免内存耗尽`,
        );
      this.stateExportFallback = { name, chunks: [], receivedBytes: 0 };
    }
    return true;
  }

  async writeStateExportChunk(
    bytes: Uint8Array,
    _reset: boolean,
    complete: boolean,
  ): Promise<void> {
    if (this.stateExportWriter) {
      await this.stateExportWriter.write(bytes as FileSystemWriteChunkType);
      if (complete) {
        await this.stateExportWriter.close();
        this.stateExportWriter = undefined;
      }
      return;
    }
    const fallback = this.stateExportFallback;
    if (!fallback) throw new Error("状态导出尚未开始");
    if ("chunks" in fallback) {
      const nextBytes = fallback.receivedBytes + bytes.byteLength;
      if (nextBytes > MAXIMUM_IN_MEMORY_STATE_EXPORT_BYTES) {
        this.stateExportFallback = undefined;
        fallback.chunks.length = 0;
        throw new Error("浏览器状态导出超过 64 MiB 内存安全限制");
      }
      fallback.receivedBytes = nextBytes;
      if (bytes.byteLength > 0) fallback.chunks.push(exactBlobBuffer(bytes));
      if (!complete) return;
      const blob = new Blob(fallback.chunks, { type: "application/octet-stream" });
      if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
        (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({
          name: fallback.name,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
      } else downloadBrowserBlob(fallback.name, blob);
      fallback.chunks.length = 0;
      this.stateExportFallback = undefined;
      return;
    }
    await fallback.writer.write(bytes as FileSystemWriteChunkType);
    if (!complete) return;
    await fallback.writer.close();
    const file = await (await fallback.root.getFileHandle(fallback.temporaryName)).getFile();
    downloadBrowserBlob(fallback.name, file, () => {
      void fallback.root.removeEntry(fallback.temporaryName).catch(() => undefined);
    });
    this.stateExportFallback = undefined;
  }

  async cancelStateExport(): Promise<void> {
    if (this.stateExportWriter) {
      await this.stateExportWriter.abort().catch(() => undefined);
      this.stateExportWriter = undefined;
    }
    const fallback = this.stateExportFallback;
    this.stateExportFallback = undefined;
    if (!fallback) return;
    if ("chunks" in fallback) fallback.chunks.length = 0;
    else {
      await fallback.writer.abort().catch(() => undefined);
      await fallback.root.removeEntry(fallback.temporaryName).catch(() => undefined);
    }
  }

  async beginProjectFileExport(name: string): Promise<boolean> {
    if (import.meta.env.VITE_RUSTYERA_TEST !== "1" && window.showSaveFilePicker) {
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
      this.projectFileFallback = { name, chunks: [], receivedBytes: 0 };
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
      const spool = await project.stageFullManifest(this.scanProgress, abort.signal);
      if (abort.signal.aborted) {
        await spool.release();
        abort.signal.throwIfAborted();
      }
      this.fullManifestSpool = spool;
      return { totalBytes: spool.totalBytes };
    } finally {
      if (this.memoryConstrained) project.releaseSubmittedSourcePayloads();
      if (this.projectFileExportAbort === abort) this.projectFileExportAbort = undefined;
    }
  }

  fullProjectExportSupported(): boolean {
    return this.project?.embeddedManifest() == null;
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
    const writer = this.projectFileWriter;
    if (writer) {
      await writer.write(bytes as FileSystemWriteChunkType);
      if (this.projectFileWriter !== writer) return;
      if (complete) {
        await writer.close();
        if (this.projectFileWriter !== writer) return;
        this.projectFileWriter = undefined;
      }
      return;
    }
    const fallback = this.projectFileFallback;
    if (!fallback) throw new Error("项目文件导出尚未开始");
    if ("chunks" in fallback) {
      const nextBytes = fallback.receivedBytes + bytes.byteLength;
      if (nextBytes > MAXIMUM_IN_MEMORY_PROJECT_EXPORT_BYTES) {
        this.projectFileFallback = undefined;
        fallback.chunks.length = 0;
        throw new Error(
          `当前浏览器没有可用的流式文件写入能力，项目导出超过 ${MAXIMUM_IN_MEMORY_PROJECT_EXPORT_BYTES / 1024 / 1024} MiB，已停止以避免内存耗尽`,
        );
      }
      fallback.receivedBytes = nextBytes;
      fallback.chunks.push(exactBlobBuffer(bytes));
      if (!complete) return;
      downloadBrowserBlob(
        fallback.name,
        new Blob(fallback.chunks, { type: "application/octet-stream" }),
      );
      fallback.chunks.length = 0;
      this.projectFileFallback = undefined;
      return;
    }
    await fallback.writer.write(bytes as FileSystemWriteChunkType);
    if (this.projectFileFallback !== fallback) return;
    if (!complete) return;
    await fallback.writer.close();
    if (this.projectFileFallback !== fallback) return;
    const handle = await fallback.root.getFileHandle(fallback.temporaryName);
    if (this.projectFileFallback !== fallback) return;
    const file = await handle.getFile();
    if (this.projectFileFallback !== fallback) return;
    downloadBrowserBlob(fallback.name, file, () => {
      void fallback.root.removeEntry(fallback.temporaryName).catch(() => undefined);
    });
    this.projectFileFallback = undefined;
  }

  async cancelProjectFileExport(): Promise<void> {
    this.projectFileExportAbort?.abort(new DOMException("Export cancelled", "AbortError"));
    this.projectFileExportAbort = undefined;
    const writer = this.projectFileWriter;
    this.projectFileWriter = undefined;
    const fallback = this.projectFileFallback;
    this.projectFileFallback = undefined;
    if (fallback && "chunks" in fallback) fallback.chunks.length = 0;
    await this.releaseFullProjectManifest().catch(() => undefined);
    await writer?.abort().catch(() => undefined);
    if (fallback && "writer" in fallback) {
      await fallback.writer.abort().catch(() => undefined);
      await fallback.root.removeEntry(fallback.temporaryName).catch(() => undefined);
    }
  }

  protected requireProject(): BrowserProject {
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
    const project = this.requireProject();
    if (reset) {
      this.discardCompiledCacheExport = !this.projectStoragePersistent;
      if (this.discardCompiledCacheExport) {
        this.cacheWriter = undefined;
      } else {
        const cacheDirectory = await project.cacheDirectory(true);
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
      const cacheDirectory = await project.cacheDirectory();
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
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.projectOperation += 1;
    await this.cancelStateExport().catch(() => undefined);
    await this.cancelProjectFileExport().catch(() => undefined);
    await this.cancelCompiledCacheExport().catch(() => undefined);
    this.retireCommittedProject();
    this.worker.close();
  }

  protected retireCommittedProject(operation?: ProjectOperation): void {
    if (operation) this.assertProjectOperation(operation);
    else this.projectOperation += 1;
    this.project?.finalizeReload(false);
    this.project = undefined;
    this.projectPreferenceStore = undefined;
    this.projectStoragePersistent = true;
    this.projectDirectorySelectionRelease?.();
    this.projectDirectorySelectionRelease = undefined;
    this.projectFontRegistry.clear();
  }

  protected recordRuntimeMemory(batch: PumpBatch): PumpBatch {
    if (batch.memoryBytes != null) this.wasmLinearMemoryBytes = batch.memoryBytes;
    return batch;
  }

  protected async loadSelectedProjectFile<T>(
    file: File,
    compiledCache: Uint8Array | undefined,
    preparedBytes: Uint8Array | undefined,
    operation: ProjectOperation,
  ): Promise<T> {
    if (this.memoryConstrained) {
      return this.projectStep(operation, () =>
        this.worker.call<T>("loadProjectFile", file, {
          chunkBytes: CONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES,
        }),
      );
    }
    const bytes =
      preparedBytes ??
      (
        await this.projectStep(operation, () =>
          readProjectFile(file, (completed, total) =>
            this.projectProgressListener?.({ stage: "scanning", completed, total }),
          ),
        )
      ).bytes;
    if (compiledCache) {
      return this.projectStep(operation, () =>
        this.worker.callWithTransfer<T>(
          "loadProjectFileWithCompiledCacheBytes",
          [bytes, compiledCache],
          [bytes.buffer, compiledCache.buffer],
        ),
      );
    }
    return this.projectStep(operation, () =>
      this.worker.callWithTransfer<T>("loadProjectFileBytes", [bytes], [bytes.buffer]),
    );
  }

  protected async loadSelectedProjectSource(
    file: File,
    operation: ProjectOperation,
  ): Promise<void> {
    if (this.memoryConstrained) {
      await this.projectStep(operation, () =>
        this.worker.call("loadProjectFileSource", file, {
          chunkBytes: CONSTRAINED_PROJECT_FILE_READ_CHUNK_BYTES,
        }),
      );
      return;
    }
    const { bytes } = await this.projectStep(operation, () =>
      readProjectFile(file, (completed, total) =>
        this.projectProgressListener?.({ stage: "scanning", completed, total }),
      ),
    );
    await this.projectStep(operation, () =>
      this.worker.callWithTransfer("loadProjectFileSourceBytes", [bytes], [bytes.buffer]),
    );
  }
}
