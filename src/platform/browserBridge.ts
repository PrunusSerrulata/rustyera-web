import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
} from "@/core/types";
import { BrowserProject } from "@/platform/browserProject";
import { database, loadBrowserPreferences, saveBrowserPreferences } from "@/platform/database";
import { WorkerClient } from "@/platform/workerClient";

export class BrowserBridge implements FrontendBridge {
  readonly kind = "browser" as const;
  private readonly worker = new WorkerClient();
  private project?: BrowserProject;

  createSession(options: SessionOptions): Promise<PumpBatch> {
    return this.worker.call("create", options);
  }

  submitRuntime(message: RuntimeMessage, correlationId?: number): Promise<bigint> {
    return this.worker.call(
      "submitRuntime",
      message,
      correlationId == null ? undefined : BigInt(correlationId),
    );
  }

  submitDebug(message: DebugMessage, correlationId?: number): Promise<bigint> {
    return this.worker.call(
      "submitDebug",
      message,
      correlationId == null ? undefined : BigInt(correlationId),
    );
  }

  pump(): Promise<PumpBatch> {
    return this.worker.call("pump");
  }

  async openProject(): Promise<void> {
    if (!window.showDirectoryPicker)
      throw new Error("此浏览器不支持直接打开目录，请使用桌面 Chromium。");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await handle.requestPermission?.({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("运行完整游戏需要项目目录的读写权限。");
    await database.handles.put({ key: "last-project", handle });
    this.project = new BrowserProject(handle);
    await this.worker.call("loadProject", await this.project.scan());
  }

  async reloadProject(): Promise<void> {
    if (!this.project) throw new Error("没有打开的项目");
    await this.submitRuntime({ type: "reload_project", value: await this.project.reloadRequest() });
  }

  readResource(relativePath: string): Promise<Uint8Array> {
    if (!this.project) return Promise.reject(new Error("没有打开的项目"));
    return this.project.readResource(relativePath);
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

  async saveDownload(name: string, bytes: Uint8Array): Promise<void> {
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async close(): Promise<void> {
    this.worker.close();
  }
}
