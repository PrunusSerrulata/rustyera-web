import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import { ProjectFontRegistry, type ProjectFontSource } from "@/platform/projectFonts";
import {
  decodeIpcResponse,
  decodeIpcValue,
  encodeIpcBytes,
  encodeIpcValue,
} from "@/platform/tauriBridge/ipcCodec";
import type {
  DebugMessage,
  FrontendBridge,
  Preferences,
  ProjectPreferences,
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
import { defaultProjectPreferences } from "@/core/types";

type HostProjectOpenMetrics = Omit<ProjectOpenMetrics, "submittedAtMs" | "projectFonts">;
type HostProjectFontSource = { relativePath: string; contentHash: number[] };

export class TauriBridge implements FrontendBridge {
  readonly kind = "tauri" as const;
  readonly snapshotRestoreMode = "in_place" as const;
  readonly automaticCompiledCacheExport = true;
  private projectPath?: string;
  private projectIsFile = false;
  private projectPreferences?: ProjectPreferences;
  private projectPreferencesAreWritable = false;
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

  prepareSnapshotRestore(): Promise<void> {
    // Native sessions replace ordinary heap allocations without retaining a WASM linear memory.
    return Promise.resolve();
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
      await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
      const response = await invoke<HostProjectOpenMetrics>("open_project", { path: testProject });
      const metrics = await this.withProjectFonts(response);
      this.projectPath = testProject;
      this.projectIsFile = false;
      await this.loadCurrentProjectPreferences();
      return { ...metrics, submittedAtMs };
    }
    const path = await open({ directory: true, multiple: false, title: "打开 Era 项目" });
    if (typeof path !== "string") {
      await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
      return undefined;
    }
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await prepareAfterSelection?.();
    this.projectProgressListener?.({ stage: "scanning", completed: 0, total: 0 });
    await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
    if (this.progressUnlisten) await this.progressUnlisten;
    const response = await invoke<HostProjectOpenMetrics>("open_project", { path });
    const metrics = await this.withProjectFonts(response);
    this.projectPath = path;
    this.projectIsFile = false;
    await this.loadCurrentProjectPreferences();
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
      await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
      const response = await invoke<HostProjectOpenMetrics>("open_project_file", {
        path: testProjectFile,
      });
      const metrics = await this.withProjectFonts(response);
      this.projectPath = testProjectFile;
      this.projectIsFile = true;
      await this.loadCurrentProjectPreferences();
      return { ...metrics, submittedAtMs };
    }
    const path = await open({
      directory: false,
      multiple: false,
      title: "打开 RustyEra 项目文件",
      filters: [{ name: "RustyEra 项目", extensions: ["reraproj"] }],
    });
    if (typeof path !== "string") {
      await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
      return undefined;
    }
    const submittedAtMs = performance.now();
    onSubmitted?.(submittedAtMs);
    await prepareAfterSelection?.();
    await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
    const response = await invoke<HostProjectOpenMetrics>("open_project_file", { path });
    const metrics = await this.withProjectFonts(response);
    this.projectPath = path;
    this.projectIsFile = true;
    await this.loadCurrentProjectPreferences();
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
    return {
      ...response,
      // Native scanning currently reports its combined quick-scan wall time. Preserve that
      // measurement in the stat bucket until the native scanner exposes finer subphase timers.
      enumerateMs: response.enumerateMs ?? 0,
      indexReadMs: response.indexReadMs ?? 0,
      indexWriteMs: response.indexWriteMs ?? 0,
      statMs: response.statMs ?? response.quickScanMs,
      sourceReadDecodeHashMs: response.sourceReadDecodeHashMs ?? response.sourceReadMs,
      submissionTransferMs: response.submissionTransferMs ?? response.submitMs,
      sourceIndexPresent: response.sourceIndexPresent ?? (response.sourceIndexReusedFiles ?? 0) > 0,
      projectFonts: await this.activateProjectFonts(),
    };
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
    return { fonts: [], errors: [], messageId };
  }

  async finalizeProjectReload(success: boolean) {
    await invoke("finalize_project_reload", { success });
    return success ? this.activateProjectFonts() : { fonts: [], errors: [] };
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

  currentProjectPreferences(): ProjectPreferences | undefined {
    return this.projectPreferences == null
      ? undefined
      : { ...this.projectPreferences, settings: { ...this.projectPreferences.settings } };
  }

  async saveProjectPreferences(preferences: ProjectPreferences): Promise<ProjectPreferences> {
    if (!this.projectPath) throw new Error("没有打开的项目");
    if (!this.projectPreferencesAreWritable) throw new Error("项目偏好为只读");
    this.projectPreferences = await invoke<ProjectPreferences>("save_project_preferences", {
      preferences,
    });
    return this.currentProjectPreferences()!;
  }

  projectPreferencesWritable(): boolean {
    return this.projectPreferencesAreWritable;
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
    const values = new Map(entries.map((entry) => [entry.code, entry.client_effective_value]));
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

  private async loadCurrentProjectPreferences(): Promise<void> {
    if (!this.projectPath) return;
    const loaded = await invoke<{
      preferences: ProjectPreferences;
      writable: boolean;
      error?: string;
    }>("load_project_preferences");
    if (
      loaded == null ||
      typeof loaded !== "object" ||
      loaded.preferences == null ||
      typeof loaded.writable !== "boolean"
    ) {
      this.projectPreferences = defaultProjectPreferences();
      this.projectPreferencesAreWritable = false;
      return;
    }
    this.projectPreferences = loaded.preferences;
    this.projectPreferencesAreWritable = loaded.writable;
  }

  async openUpload(): Promise<Uint8Array | undefined> {
    const path = await open({ directory: false, multiple: false, title: "选择 VM 快照" });
    if (typeof path !== "string") return undefined;
    return new Uint8Array(await invoke<number[]>("read_import", { path }));
  }

  async saveDownload(name: string, bytes: Uint8Array): Promise<boolean> {
    const testPath =
      import.meta.env.VITE_RUSTYERA_TEST === "1"
        ? import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH
        : undefined;
    const path = testPath || (await save({ defaultPath: name }));
    if (!path) return false;
    await invoke("write_export", { path, bytes: encodeIpcBytes(bytes) });
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

  fullProjectExportSupported(): boolean {
    return true;
  }

  async stageFullProjectManifest(): Promise<{ totalBytes: number } | undefined> {
    if (this.projectIsFile) return undefined;
    return invoke<{ totalBytes: number }>("stage_full_project_manifest");
  }

  async readFullProjectManifestChunk(offset: number, maximumBytes: number): Promise<Uint8Array> {
    return new Uint8Array(
      await invoke<number[]>("read_full_project_manifest_chunk", { offset, maximumBytes }),
    );
  }

  async releaseFullProjectManifest(): Promise<void> {
    await invoke("release_full_project_manifest");
  }

  async writeProjectFileChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void> {
    const path = this.projectFileExportPath;
    if (!path) throw new Error("项目文件导出尚未开始");
    await invoke("write_export_chunk", {
      path,
      bytes: encodeIpcBytes(bytes),
      reset,
      complete,
    });
    if (complete) this.projectFileExportPath = undefined;
  }

  async cancelProjectFileExport(): Promise<void> {
    await invoke("cancel_full_project_export").catch(() => undefined);
    await this.releaseFullProjectManifest().catch(() => undefined);
    if (!this.projectFileExportPath) return;
    await invoke("cancel_export").catch(() => undefined);
    this.projectFileExportPath = undefined;
  }

  async saveDiagnosis(
    name: string,
    input: DiagnosisArchiveInput,
    reportProgress?: (progress: DiagnosisArchiveProgress) => void,
  ): Promise<boolean> {
    const testPath =
      import.meta.env.VITE_RUSTYERA_TEST === "1"
        ? import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH
        : undefined;
    const path = testPath || (await save({ defaultPath: name }));
    if (!path) return false;
    let first = true;
    try {
      const totalBytes = await streamDiagnosisArchiveInWorker(
        input,
        async (chunk) => {
          await invoke("write_export_chunk", {
            path,
            bytes: encodeIpcBytes(chunk),
            reset: first,
            complete: false,
          });
          first = false;
        },
        reportProgress,
      );
      await invoke("write_export_chunk", {
        path,
        bytes: encodeIpcBytes(new Uint8Array()),
        reset: first,
        complete: true,
      });
      reportProgress?.({ completed: totalBytes, total: totalBytes });
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
    await invoke("write_compiled_cache_chunk", {
      bytes: encodeIpcBytes(bytes),
      reset,
      complete,
    });
  }

  async cancelCompiledCacheExport(): Promise<void> {
    await invoke("cancel_compiled_cache_export");
  }

  async close(): Promise<void> {
    await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
    this.projectFontRegistry.clear();
    if (this.progressUnlisten) (await this.progressUnlisten)();
    await getCurrentWindow().close();
  }
}
