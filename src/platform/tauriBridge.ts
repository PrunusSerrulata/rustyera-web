import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput } from "@/core/diagnosis";
import { createDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectProgress,
  ProjectOpenMetrics,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
} from "@/core/types";

const IPC_INTEGER_TAG = "$rustyeraInteger";

function decodeIpcValue<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => decodeIpcValue(item)) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length === 1 &&
      typeof record[IPC_INTEGER_TAG] === "string" &&
      /^-?\d+$/.test(record[IPC_INTEGER_TAG])
    ) {
      return BigInt(record[IPC_INTEGER_TAG]) as T;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeIpcValue(item)]),
    ) as T;
  }
  return value as T;
}

function encodeIpcValue(value: unknown): unknown {
  if (typeof value === "bigint") return { [IPC_INTEGER_TAG]: value.toString() };
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(encodeIpcValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]),
    );
  }
  return value;
}

export class TauriBridge implements FrontendBridge {
  readonly kind = "tauri" as const;
  private projectPath?: string;
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private progressUnlisten?: Promise<UnlistenFn>;

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.projectProgressListener = listener;
    if (listener && !this.progressUnlisten) {
      this.progressUnlisten = listen<ProjectProgress>("project-progress", (event) => {
        this.projectProgressListener?.(event.payload);
      });
    }
  }

  async createSession(options: SessionOptions): Promise<PumpBatch> {
    return decodeIpcValue(await invoke("create_session", { options }));
  }

  async submitRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
  ): Promise<number | bigint> {
    return decodeIpcValue(
      await invoke("submit_runtime", {
        message: encodeIpcValue(message),
        correlationId: encodeIpcValue(correlationId),
      }),
    );
  }

  async submitDebug(
    message: DebugMessage,
    correlationId?: number | bigint,
  ): Promise<number | bigint> {
    return decodeIpcValue(
      await invoke("submit_debug", {
        message: encodeIpcValue(message),
        correlationId: encodeIpcValue(correlationId),
      }),
    );
  }

  async pump(): Promise<PumpBatch> {
    return decodeIpcValue(await invoke("pump"));
  }

  async openProject(): Promise<ProjectOpenMetrics | undefined> {
    const testProject = import.meta.env.VITE_RUSTYERA_TEST_PROJECT;
    if (import.meta.env.VITE_RUSTYERA_TEST === "1" && testProject) {
      this.projectPath = testProject;
      return invoke("open_project", { path: testProject });
    }
    const path = await open({ directory: true, multiple: false, title: "打开 Era 项目" });
    if (typeof path !== "string") return undefined;
    this.projectProgressListener?.({ stage: "scanning", completed: 0, total: 0 });
    if (this.progressUnlisten) await this.progressUnlisten;
    this.projectPath = path;
    return invoke("open_project", { path });
  }

  async restartProject(): Promise<ProjectOpenMetrics> {
    if (!this.projectPath) return Promise.reject(new Error("没有打开的项目"));
    if (this.progressUnlisten) await this.progressUnlisten;
    return invoke("open_project", { path: this.projectPath });
  }

  async reloadProject(): Promise<void> {
    if (this.progressUnlisten) await this.progressUnlisten;
    await invoke("reload_project");
  }

  async submitProjectSource(): Promise<void> {
    if (this.progressUnlisten) await this.progressUnlisten;
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

  projectName(): string | undefined {
    return this.projectPath?.split(/[\\/]/).filter(Boolean).at(-1);
  }

  async openUpload(): Promise<Uint8Array | undefined> {
    const path = await open({ directory: false, multiple: false, title: "选择 VM 快照" });
    if (typeof path !== "string") return undefined;
    return new Uint8Array(await invoke<number[]>("read_import", { path }));
  }

  async saveDownload(name: string, bytes: Uint8Array): Promise<boolean> {
    const path = await save({ defaultPath: name });
    if (!path) return false;
    await invoke("write_export", { path, bytes: [...bytes] });
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
    await invoke("write_compiled_cache_chunk", { bytes: [...bytes], reset, complete });
  }

  async close(): Promise<void> {
    if (this.progressUnlisten) (await this.progressUnlisten)();
    await getCurrentWindow().close();
  }
}
