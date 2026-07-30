import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectOpenMetrics,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
} from "@/core/types";
import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput } from "@/core/diagnosis";
import { pickBrowserDirectory } from "@/platform/browserDirectory";
import { createDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import { BrowserProject, cacheIdentityManifest } from "@/platform/browserProject";
import { database, loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { WorkerClient } from "@/platform/workerClient";

export class BrowserBridge implements FrontendBridge {
  readonly kind = "browser" as const;
  private readonly worker = new WorkerClient();
  private project?: BrowserProject;
  private cacheWriter?: FileSystemWritableFileStream;

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

  async openProject(): Promise<ProjectOpenMetrics | undefined> {
    const picked = await pickBrowserDirectory();
    const handle = picked.handle;
    const permission = await handle.requestPermission?.({ mode: "readwrite" });
    if (permission && permission !== "granted")
      throw new Error("运行完整游戏需要项目目录的读写权限。");
    // Playwright supplies an RPC-backed FileSystemDirectoryHandle which intentionally cannot be
    // structured-cloned into IndexedDB. Production handles continue to be persisted normally.
    if (picked.persistHandle && import.meta.env.VITE_RUSTYERA_TEST !== "1")
      await database.handles.put({ key: "last-project", handle });
    this.project = new BrowserProject(handle, 1, picked.projectName);
    const started = performance.now();
    const manifest = await this.project.scan();
    const sourceReadMs = performance.now() - started;
    const cacheStarted = performance.now();
    const cache = await this.project.readCompiledCache();
    const cacheReadMs = performance.now() - cacheStarted;
    const submitStarted = performance.now();
    let cacheImported = false;
    if (cache) {
      try {
        await this.worker.callWithTransfer(
          "loadProjectWithCompiledCache",
          [cacheIdentityManifest(manifest), cache],
          [cache.buffer],
        );
        cacheImported = true;
      } catch {
        await this.worker.call("loadProject", manifest);
      }
    } else {
      await this.worker.call("loadProject", manifest);
    }
    return {
      quickScanMs: 0,
      cacheReadMs,
      sourceReadMs,
      submitMs: performance.now() - submitStarted,
      cacheImported,
    } satisfies ProjectOpenMetrics;
  }

  async restartProject(): Promise<ProjectOpenMetrics> {
    if (!this.project) throw new Error("没有打开的项目");
    const started = performance.now();
    await this.worker.call("loadProject", await this.project.scan());
    return {
      quickScanMs: 0,
      cacheReadMs: 0,
      sourceReadMs: performance.now() - started,
      submitMs: 0,
      cacheImported: false,
    };
  }

  async reloadProject(): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    await this.submitRuntime({ type: "reload_project", value: await this.project.reloadRequest() });
  }

  async submitProjectSource(): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    await this.worker.call("loadProject", await this.project.scan());
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

  async listFonts(): Promise<string[]> {
    if (!window.queryLocalFonts) return ["system-ui", "sans-serif", "serif", "monospace"];
    const fonts = await window.queryLocalFonts();
    return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
  }

  loadPreferences(): Promise<Preferences> {
    return loadBrowserPreferences();
  }

  savePreferences(preferences: Preferences): Promise<Preferences> {
    return saveBrowserPreferences(preferences);
  }

  projectName(): string | undefined {
    return this.project?.name;
  }

  openUpload(): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".snapshot,application/octet-stream";
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          resolve(file ? new Uint8Array(await file.arrayBuffer()) : undefined);
        } catch (error) {
          reject(error);
        }
      };
      input.click();
    });
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

  createDiagnosisArchive(input: DiagnosisArchiveInput): Promise<Uint8Array> {
    return createDiagnosisArchiveInWorker(input);
  }

  async writeCompiledCacheChunk(
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    if (reset) {
      const privateDirectory = await this.project.root.getDirectoryHandle(".rustyera", {
        create: true,
      });
      const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
      const handle = await cacheDirectory.getFileHandle("compiled-project-v8.bin.zst", {
        create: true,
      });
      this.cacheWriter = await handle.createWritable({ keepExistingData: false });
    }
    if (!this.cacheWriter) throw new Error("编译缓存写入尚未开始");
    await this.cacheWriter.write(bytes as FileSystemWriteChunkType);
    if (complete) {
      await this.cacheWriter.close();
      this.cacheWriter = undefined;
    }
  }

  async close(): Promise<void> {
    this.worker.close();
  }
}
