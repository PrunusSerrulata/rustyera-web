import {
  nextServiceLifecycleProject,
  takeServiceLifecycleDiagnosisExportPath,
} from "@/testing/serviceLifecycle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import { decodeImageMetadata } from "@/core/imageMetadata";
import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import { normalizeProjectFileIdentity } from "@/platform/projectFileManifestTransfer";
import { ProjectFontRegistry, type ProjectFontSource } from "@/platform/projectFonts";
import {
  decodeIpcResponse,
  decodeIpcValue,
  encodeIpcBytes,
  encodeIpcValue,
} from "@/platform/tauriBridge/ipcCodec";
import { ipcBytes } from "@/platform/tauriBridge/ipcBytes";
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
  RuntimeHostMemoryCounters,
  RuntimeMessage,
  SessionOptions,
  SubmittedPumpBatch,
  SystemFontQueryResult,
} from "@/core/types";
import { defaultProjectPreferences } from "@/core/types";

type HostProjectOpenMetrics = Omit<ProjectOpenMetrics, "submittedAtMs" | "projectFonts">;
type HostProjectFontSource = { relativePath: string; contentHash: number[]; byteLength: number };

export class TauriBridge implements FrontendBridge {
  readonly kind = "tauri" as const;
  readonly snapshotRestoreMode = "fresh_session" as const;
  readonly automaticCompiledCacheExport = true;
  private processMemory: Omit<
    RuntimeHostMemoryCounters,
    "workerGeneration" | "wasmLinearMemoryBytes"
  > = emptyNativeMemoryCounters();
  private memorySnapshotPending?: Promise<void>;
  private lastMemorySnapshotRequestedAt = Number.NEGATIVE_INFINITY;
  private projectPath?: string;
  private projectIsFile = false;
  private projectPreferences?: ProjectPreferences;
  private projectPreferencesAreWritable = false;
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private progressUnlisten?: Promise<UnlistenFn>;
  private projectFileExportPath?: string;
  private stateExportPath?: string;
  private readonly projectFontRegistry = new ProjectFontRegistry();
  // Tauri commands are separate IPC futures. Serialize runtime submissions so
  // the native Mutex cannot observe a later input before an earlier device edge.
  private runtimeSubmissionTail: Promise<void> = Promise.resolve();

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.projectProgressListener = listener;
    if (listener && !this.progressUnlisten) {
      this.progressUnlisten = listen<ProjectProgress>("project-progress", (event) => {
        this.projectProgressListener?.(event.payload);
      });
    }
  }

  async createSession(options: SessionOptions): Promise<PumpBatch> {
    try {
      return decodeIpcResponse(await invoke("create_session", { options }));
    } finally {
      this.refreshMemorySnapshot();
    }
  }

  async prepareSessionReplacement(): Promise<void> {
    await this.runtimeSubmissionTail;
    await invoke<void>("destroy_session");
  }

  runtimeMemoryCounters(): RuntimeHostMemoryCounters {
    return {
      workerGeneration: null,
      wasmLinearMemoryBytes: null,
      ...this.processMemory,
    };
  }

  private refreshMemorySnapshot(): void {
    const requestedAt = Date.now();
    if (this.memorySnapshotPending || requestedAt - this.lastMemorySnapshotRequestedAt < 5_000)
      return;
    this.lastMemorySnapshotRequestedAt = requestedAt;
    const operation = invoke<
      Omit<RuntimeHostMemoryCounters, "workerGeneration" | "wasmLinearMemoryBytes">
    >("memory_snapshot")
      .then((snapshot) => {
        this.processMemory = normalizeNativeMemoryCounters(snapshot);
      })
      .catch(() => undefined);
    this.memorySnapshotPending = operation;
    void operation.finally(() => {
      if (this.memorySnapshotPending === operation) this.memorySnapshotPending = undefined;
    });
  }

  async submitRuntime(
    message: RuntimeMessage,
    correlationId?: number | bigint,
  ): Promise<number | bigint> {
    return this.enqueueRuntimeSubmission(async () =>
      decodeIpcValue(
        await invoke("submit_runtime", {
          message: encodeIpcValue(message),
          correlationId: encodeIpcValue(correlationId),
        }),
      ),
    );
  }

  async submitRuntimeAndPump(
    message: RuntimeMessage,
    correlationId?: number | bigint,
  ): Promise<SubmittedPumpBatch> {
    return this.enqueueRuntimeSubmission(async () => {
      if (import.meta.env.VITE_RUSTYERA_TEST === "1")
        performance.mark("rustyera:settlement-invoke-start");
      const response = await invoke("submit_runtime_and_pump", {
        message: encodeIpcValue(message),
        correlationId: encodeIpcValue(correlationId),
      });
      if (import.meta.env.VITE_RUSTYERA_TEST === "1")
        performance.mark("rustyera:settlement-invoke-resolved");
      const decoded = decodeIpcResponse<SubmittedPumpBatch>(response);
      if (import.meta.env.VITE_RUSTYERA_TEST === "1")
        performance.mark("rustyera:settlement-decode-finished");
      return decoded;
    });
  }

  private enqueueRuntimeSubmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runtimeSubmissionTail.then(operation, operation);
    this.runtimeSubmissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    try {
      return decodeIpcResponse(await invoke("pump"));
    } finally {
      this.refreshMemorySnapshot();
    }
  }

  async openProject(
    onSubmitted?: ProjectSubmittedListener,
    prepareAfterSelection?: ProjectSelectionPreparation,
  ): Promise<ProjectOpenMetrics | undefined> {
    const testProject =
      import.meta.env.VITE_RUSTYERA_TEST === "1" && import.meta.env.VITE_RUSTYERA_TEST_PROJECT
        ? nextServiceLifecycleProject(import.meta.env.VITE_RUSTYERA_TEST_PROJECT)
        : undefined;
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
        byteLength: source.byteLength,
        read: async () =>
          ipcBytes(
            await invoke<Uint8Array>("read_project_font", {
              relativePath: source.relativePath,
            }),
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
    return ipcBytes(await invoke<Uint8Array>("read_resource", { relativePath }));
  }

  async readImageMetadata(relativePath: string): Promise<ReturnType<typeof decodeImageMetadata>> {
    const prefix = await invoke<Uint8Array>("read_resource_prefix", {
      relativePath,
      maximumBytes: 1024 * 1024,
    });
    return decodeImageMetadata(ipcBytes(prefix));
  }

  async handleStorage(request: any): Promise<any> {
    const encoded = encodeIpcValue(request) as Record<string, unknown>;
    const operation = request?.operation;
    if (operation?.type === "write") {
      if (!ArrayBuffer.isView(operation.data))
        throw new TypeError("storage write data must be a byte view");
      const view = operation.data as ArrayBufferView;
      const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      encoded.operation = {
        ...(encoded.operation as Record<string, unknown>),
        data: encodeIpcBytes(data),
      };
    }
    return decodeIpcResponse(await invoke("storage_request", { request: encoded }));
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
    return ipcBytes(await invoke<Uint8Array>("read_import", { path }));
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

  async beginStateExport(name: string, totalBytes: number): Promise<boolean> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0)
      throw new Error("Runtime 返回了无效的状态导出长度");
    await this.cancelStateExport();
    const testPath =
      import.meta.env.VITE_RUSTYERA_TEST === "1"
        ? import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH
        : undefined;
    const path = testPath || (await save({ defaultPath: name }));
    if (!path) return false;
    this.stateExportPath = path;
    return true;
  }

  async writeStateExportChunk(bytes: Uint8Array, reset: boolean, complete: boolean): Promise<void> {
    const path = this.stateExportPath;
    if (!path) throw new Error("状态导出尚未开始");
    await invoke("write_export_chunk", {
      path,
      bytes: encodeIpcBytes(bytes),
      reset,
      complete,
    });
    if (complete) this.stateExportPath = undefined;
  }

  async cancelStateExport(): Promise<void> {
    if (!this.stateExportPath) return;
    await invoke("cancel_export").catch(() => undefined);
    this.stateExportPath = undefined;
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
    return ipcBytes(
      await invoke<Uint8Array>("read_full_project_manifest_chunk", { offset, maximumBytes }),
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
        ? (takeServiceLifecycleDiagnosisExportPath() ??
          import.meta.env.VITE_RUSTYERA_TAURI_EXPORT_PATH)
        : undefined;
    const path = testPath || (await save({ defaultPath: name }));
    if (!path) return false;
    let first = true;
    try {
      const projectIdentity =
        import.meta.env.VITE_RUSTYERA_TEST === "1"
          ? normalizeProjectFileIdentity(
              await invoke("inspect_project_file_identity", {
                bytes: encodeIpcBytes(input.projectFile),
              }),
            )
          : undefined;
      // The worker takes ownership of these buffers. Retain only the bounded test evidence
      // before transfer, and publish it only after the native archive commit succeeds.
      const downloadEvidence = projectIdentity
        ? { projectMagic: input.projectFile.slice(0, 8), inputReplay: input.inputReplay.slice() }
        : undefined;
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
      if (projectIdentity)
        (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({
          name,
          bytes: new Uint8Array(),
          size: totalBytes,
          ...downloadEvidence,
          projectIdentity,
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
    await this.dispose();
    await getCurrentWindow().close();
  }

  async dispose(): Promise<void> {
    await this.cancelStateExport().catch(() => undefined);
    await invoke("finalize_project_reload", { success: false }).catch(() => undefined);
    this.projectFontRegistry.clear();
    const progressUnlisten = this.progressUnlisten;
    this.progressUnlisten = undefined;
    if (progressUnlisten) (await progressUnlisten)();
    this.projectProgressListener = undefined;
    await this.runtimeSubmissionTail;
    await invoke("destroy_session").catch(() => undefined);
  }
}

function emptyNativeMemoryCounters(): Omit<
  RuntimeHostMemoryCounters,
  "workerGeneration" | "wasmLinearMemoryBytes"
> {
  return {
    residentBytes: null,
    physicalFootprintBytes: null,
    virtualBytes: null,
    privateBytes: null,
    committedBytes: null,
    anonymousBytes: null,
  };
}

function normalizeNativeMemoryCounters(
  value:
    | Partial<Omit<RuntimeHostMemoryCounters, "workerGeneration" | "wasmLinearMemoryBytes">>
    | null
    | undefined,
): Omit<RuntimeHostMemoryCounters, "workerGeneration" | "wasmLinearMemoryBytes"> {
  const counter = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : null;
  return {
    residentBytes: counter(value?.residentBytes),
    physicalFootprintBytes: counter(value?.physicalFootprintBytes),
    virtualBytes: counter(value?.virtualBytes),
    privateBytes: counter(value?.privateBytes),
    committedBytes: counter(value?.committedBytes),
    anonymousBytes: counter(value?.anonymousBytes),
  };
}
