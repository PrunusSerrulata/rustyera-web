import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectOpenMetrics,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
} from "@/core/types";

export class TauriBridge implements FrontendBridge {
  readonly kind = "tauri" as const;

  createSession(options: SessionOptions): Promise<PumpBatch> {
    return invoke("create_session", { options });
  }

  submitRuntime(message: RuntimeMessage, correlationId?: number): Promise<number> {
    return invoke("submit_runtime", { message, correlationId });
  }

  submitDebug(message: DebugMessage, correlationId?: number): Promise<number> {
    return invoke("submit_debug", { message, correlationId });
  }

  pump(): Promise<PumpBatch> {
    return invoke("pump");
  }

  async openProject(): Promise<ProjectOpenMetrics | undefined> {
    const path = await open({ directory: true, multiple: false, title: "打开 Era 项目" });
    if (typeof path !== "string") return undefined;
    return invoke("open_project", { path });
  }

  async reloadProject(): Promise<void> {
    await invoke("reload_project");
  }

  async submitProjectSource(): Promise<void> {
    await invoke("submit_project_source");
  }

  async readResource(relativePath: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>("read_resource", { relativePath }));
  }

  async readImageMetadata(relativePath: string): Promise<ReturnType<typeof decodeImageMetadata>> {
    const prefix = await invoke<number[]>("read_resource_prefix", {
      relativePath,
      maximumBytes: 1024 * 1024,
    });
    return decodeImageMetadata(new Uint8Array(prefix));
  }

  handleStorage(request: any): Promise<any> {
    return invoke("storage_request", { request });
  }

  listFonts(): Promise<string[]> {
    return invoke("list_fonts");
  }

  loadPreferences(): Promise<Preferences> {
    return invoke("load_preferences");
  }

  savePreferences(preferences: Preferences): Promise<Preferences> {
    return invoke("save_preferences", { preferences });
  }

  async openUpload(): Promise<Uint8Array | undefined> {
    const path = await open({ directory: false, multiple: false, title: "选择 VM 快照" });
    if (typeof path !== "string") return undefined;
    return new Uint8Array(await invoke<number[]>("read_import", { path }));
  }

  async saveDownload(name: string, bytes: Uint8Array): Promise<void> {
    const path = await save({ defaultPath: name });
    if (path) await invoke("write_export", { path, bytes: [...bytes] });
  }

  async writeCompiledCacheChunk(
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): Promise<void> {
    await invoke("write_compiled_cache_chunk", { bytes: [...bytes], reset, complete });
  }

  async close(): Promise<void> {
    await getCurrentWindow().close();
  }
}
