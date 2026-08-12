import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput } from "@/core/diagnosis";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import { ProjectFontRegistry, type ProjectFontSource } from "@/platform/projectFonts";
import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectProgress,
  ProjectOpenMetrics,
  ProjectReloadScope,
  ProjectReloadTargets,
  ProjectSelectionPreparation,
  ProjectSubmittedListener,
  ProjectConfigurationEntry,
  PumpBatch,
  RuntimeMessage,
  SessionOptions,
  SystemFontQueryResult,
} from "@/core/types";

const IPC_INTEGER_TAG = "$rustyeraInteger";
type HostProjectOpenMetrics = Omit<ProjectOpenMetrics, "submittedAtMs" | "projectFonts">;
type HostProjectFontSource = { relativePath: string; contentHash: number[] };

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

function decodeIpcResponse<T>(value: unknown): T {
  const isArrayBuffer = Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  if (isArrayBuffer || ArrayBuffer.isView(value)) {
    let bytes: Uint8Array;
    if (isArrayBuffer) bytes = new Uint8Array(value as ArrayBuffer);
    else {
      const view = value as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    return decodeIpcValue(JSON.parse(new TextDecoder().decode(bytes)));
  }
  return decodeIpcValue(value);
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
  private projectIsFile = false;
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private progressUnlisten?: Promise<UnlistenFn>;
  private projectFileExportPath?: string;
  private readonly projectFontRegistry = new ProjectFontRegistry();

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.projectProgressListener = listener;
    if (listener && !this.progressUnlisten) {
      this.progressUnlisten = listen<ProjectProgress>("project-progress", (event) => {
        this.projectProgressListener?.(event.payload);
      });
    }
  }

  async createSession(options: SessionOptions): Promise<PumpBatch> {
    return decodeIpcResponse(await invoke("create_session", { options }));
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
    return decodeIpcResponse(await invoke("pump"));
  }

  async openProject(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const testProject = import.meta.env.VITE_RUSTYERA_TEST_PROJECT;
    if (import.meta.env.VITE_RUSTYERA_TEST === "1" && testProject) {
      const submittedAtMs = performance.now();
      onSubmitted?.(submittedAtMs);
      await prepareAfterSelection?.();
      const response = await invoke<HostProjectOpenMetrics>("open_project", { path: testProject });
      const metrics = await this.withProjectFonts(response);
      this.projectPath = testProject;
      this.projectIsFile = false;
      return { ...metrics, submittedAtMs };
    }
    const path = await open({ directory: true, multiple: false, title: "打开 Era 项目" });
    if (typeof path !== "string") return undefined;
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await prepareAfterSelection?.();
    this.projectProgressListener?.({ stage: "scanning", completed: 0, total: 0 });
    if (this.progressUnlisten) await this.progressUnlisten;
    const response = await invoke<HostProjectOpenMetrics>("open_project", { path });
    const metrics = await this.withProjectFonts(response);
    this.projectPath = path;
    this.projectIsFile = false;
    return { ...metrics, submittedAtMs };
  }

  async openProjectFile(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const testProjectFile = import.meta.env.VITE_RUSTYERA_TEST_PROJECT_FILE;
    if (import.meta.env.VITE_RUSTYERA_TEST === "1" && testProjectFile) {
      const submittedAtMs = performance.now();
      onSubmitted?.(submittedAtMs);
      await prepareAfterSelection?.();
      const response = await invoke<HostProjectOpenMetrics>("open_project_file", {
        path: testProjectFile,
      });
      const metrics = await this.withProjectFonts(response);
      this.projectPath = testProjectFile;
      this.projectIsFile = true;
      return { ...metrics, submittedAtMs };
    }
    const path = await open({
      directory: false,
      multiple: false,
      title: "打开 RustyEra 项目文件",
      filters: [{ name: "RustyEra 项目", extensions: ["reraproj"] }],
    });
    if (typeof path !== "string") return undefined;
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await prepareAfterSelection?.();
    const response = await invoke<HostProjectOpenMetrics>("open_project_file", { path });
    const metrics = await this.withProjectFonts(response);
    this.projectPath = path;
    this.projectIsFile = true;
    return { ...metrics, submittedAtMs };
  }

  async restartProject(onSubmitted?: ProjectSubmittedListener): Promise<ProjectOpenMetrics> {
    if (!this.projectPath) return Promise.reject(new Error("没有打开的项目"));
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    if (this.progressUnlisten) await this.progressUnlisten;
    const response = await invoke<HostProjectOpenMetrics>(
      this.projectIsFile ? "open_project_file" : "open_project",
      {
        path: this.projectPath,
      },
    );
    const metrics = await this.withProjectFonts(response);
    return { ...metrics, submittedAtMs };
  }

  private async withProjectFonts(
    response: HostProjectOpenMetrics,
  ): Promise<Omit<ProjectOpenMetrics, "submittedAtMs">> {
    return { ...response, projectFonts: await this.activateProjectFonts() };
  }

  private async activateProjectFonts() {
    try {
      const sources = await invoke<HostProjectFontSource[]>("project_font_sources");
      const projectSources: ProjectFontSource[] = sources.map((source) => ({
        relativePath: source.relativePath,
        contentHash: new Uint8Array(source.contentHash),
        read: async () =>
          new Uint8Array(
            await invoke<number[]>("read_project_font", { relativePath: source.relativePath }),
          ),
      }));
      return await this.projectFontRegistry.replace(projectSources);
    } catch (error) {
      const result = await this.projectFontRegistry.replace([]);
      result.errors.push(
        `无法枚举项目字体：${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
  }

  async projectReloadTargets(): Promise<ProjectReloadTargets> {
    if (this.progressUnlisten) await this.progressUnlisten;
    return invoke<ProjectReloadTargets>("project_reload_targets");
  }

  async prepareProjectReloadBaseline(): Promise<void> {
    if (this.progressUnlisten) await this.progressUnlisten;
    await invoke("prepare_project_reload_baseline");
  }

  async reloadProject(scope: ProjectReloadScope) {
    if (this.progressUnlisten) await this.progressUnlisten;
    const messageId = await invoke<number>("reload_project", { scope });
    return { ...(await this.activateProjectFonts()), messageId };
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

  async listFonts(): Promise<SystemFontQueryResult> {
    try {
      return { kind: "ready", fonts: await invoke<string[]>("list_fonts") };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  loadPreferences(): Promise<Preferences> {
    return invoke("load_preferences");
  }

  savePreferences(preferences: Preferences): Promise<Preferences> {
    return invoke("save_preferences", { preferences });
  }

  projectConfigurationWritable(): boolean {
    return Boolean(this.projectPath);
  }

  writeProjectConfiguration(expectedDigest: Uint8Array, contents: string): Promise<void> {
    return invoke("write_project_configuration", {
      expectedDigest: [...expectedDigest],
      contents,
    });
  }

  async applyProjectConfiguration(
    entries: ProjectConfigurationEntry[],
    viewportChrome: { width: number; height: number },
    changedCodes?: string[],
  ): Promise<void> {
    const relevant = new Set(["WindowMaximixed", "WindowX", "WindowY"]);
    if (changedCodes && !changedCodes.some((code) => relevant.has(code))) return;
    const values = new Map(entries.map((entry) => [entry.code, entry.effective_value]));
    const integer = (code: string): number | undefined => {
      const value = values.get(code);
      if (value == null || !/^-?\d+$/.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    };
    const boolean = (code: string, fallback: boolean): boolean => {
      const value = values.get(code)?.toUpperCase();
      if (value == null) return fallback;
      return value === "YES" || value === "TRUE" || value === "1";
    };
    const window = getCurrentWindow();
    const maximized = boolean("WindowMaximixed", false);
    if (!maximized && (await window.isMaximized())) await window.unmaximize();
    const width = integer("WindowX");
    const height = integer("WindowY");
    if (width != null && height != null && width > 0 && height > 0)
      await window.setSize(
        new LogicalSize(width + viewportChrome.width, height + viewportChrome.height),
      );
    if (maximized) await window.maximize();
  }

  projectName(): string | undefined {
    return this.projectPath
      ?.split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.reraproj$/i, "");
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

  async beginProjectFileExport(name: string): Promise<boolean> {
    const testPath = import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH;
    const path =
      testPath ||
      (await save({
        defaultPath: name,
        filters: [{ name: "RustyEra 项目", extensions: ["reraproj"] }],
      }));
    if (!path) return false;
    this.projectFileExportPath = path;
    return true;
  }

  async stageFullProjectManifest(): Promise<void> {
    if (this.projectIsFile) return;
    await invoke("stage_full_project_manifest");
  }

  async writeProjectFileChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void> {
    const path = this.projectFileExportPath;
    if (!path) throw new Error("项目文件导出尚未开始");
    await invoke("write_export_chunk", { path, bytes: [...bytes], reset, complete });
    if (complete) this.projectFileExportPath = undefined;
  }

  async cancelProjectFileExport(): Promise<void> {
    await invoke("cancel_full_project_export").catch(() => undefined);
    if (!this.projectFileExportPath) return;
    await invoke("cancel_export").catch(() => undefined);
    this.projectFileExportPath = undefined;
  }

  async saveDiagnosis(name: string, input: DiagnosisArchiveInput): Promise<boolean> {
    const testPath =
      import.meta.env.VITE_RUSTYERA_TEST === "1"
        ? import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH
        : undefined;
    const path = testPath || (await save({ defaultPath: name }));
    if (!path) return false;
    let first = true;
    try {
      await streamDiagnosisArchiveInWorker(input, async (chunk) => {
        await invoke("write_export_chunk", {
          path,
          bytes: [...chunk],
          reset: first,
          complete: false,
        });
        first = false;
      });
      await invoke("write_export_chunk", {
        path,
        bytes: [],
        reset: first,
        complete: true,
      });
      return true;
    } catch (error) {
      await invoke("cancel_export").catch(() => undefined);
      throw error;
    }
  }

  async writeCompiledCacheChunk(
    bytes: Uint8Array,
    reset: boolean,
    complete: boolean,
  ): Promise<void> {
    await invoke("write_compiled_cache_chunk", { bytes: [...bytes], reset, complete });
  }

  async cancelCompiledCacheExport(): Promise<void> {
    await invoke("cancel_compiled_cache_export");
  }

  async close(): Promise<void> {
    this.projectFontRegistry.clear();
    if (this.progressUnlisten) (await this.progressUnlisten)();
    await getCurrentWindow().close();
  }
}
