import { runtimeWorkerResultTransfers } from "@/platform/projectFileManifestTransfer";
import { loadProjectFileInWorker } from "@/platform/projectFileWorker";
import { runtimeWasmAssetUrls } from "@/platform/runtimeWasmAssets";

type WasmModule = {
  default: (input?: { module_or_path: string }) => Promise<unknown>;
  WasmRuntime: new (
    options: unknown,
    progress?: (value: unknown) => void,
  ) => {
    submitRuntime(message: unknown, correlationId?: bigint): bigint;
    submitDebug(message: unknown, correlationId?: bigint): bigint;
    loadProject(manifest: unknown): bigint;
    loadProjectBinary(manifest: Uint8Array): bigint;
    projectFileManifest(bytes: Uint8Array): unknown;
    beginProjectFile(totalBytes: number): void;
    appendProjectFile(bytes: Uint8Array): void;
    finishProjectFile(): unknown;
    loadProjectFileBytes(bytes: Uint8Array): unknown;
    cancelProjectFile(): void;
    readProjectFileResource(relativePath: string, maximumBytes?: number): Uint8Array;
    prepareProjectConfigurationUpdate(
      projectFile: Uint8Array,
      expectedDigest: Uint8Array,
      contents: string,
    ): Uint8Array;
    loadProjectWithCompiledCache(manifest: unknown, cache: Uint8Array): bigint;
    loadProjectWithCompiledCacheBinary(manifest: Uint8Array, cache: Uint8Array): bigint;
    traditionalSaveSlotCount(): number;
    inspectTraditionalSave(bytes: Uint8Array): unknown;
    pump(instructions: number, transitions: number): unknown;
  };
};

let runtime: InstanceType<WasmModule["WasmRuntime"]> | undefined;

self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data as { id: number; method: string; args: unknown[] };
  try {
    let result: unknown;
    if (method === "create") {
      const wasmUrls = runtimeWasmAssetUrls(
        import.meta.env.DEV,
        import.meta.env.BASE_URL,
        import.meta.env.VITE_RUSTYERA_WASM_REVISION,
      );
      const module = (await import(/* @vite-ignore */ wasmUrls.module)) as WasmModule;
      await module.default({ module_or_path: wasmUrls.binary });
      runtime = new module.WasmRuntime(args[0], (value) => {
        self.postMessage({ type: "project_progress", value });
      });
      result = runtime.pump(100_000, 1024);
    } else {
      if (!runtime) throw new Error("WASM runtime 尚未创建");
      switch (method) {
        case "submitRuntime":
          result = runtime.submitRuntime(args[0], args[1] as bigint | undefined);
          break;
        case "submitDebug":
          result = runtime.submitDebug(args[0], args[1] as bigint | undefined);
          break;
        case "loadProject":
          result = runtime.loadProject(args[0]);
          break;
        case "loadProjectBinary":
          result = runtime.loadProjectBinary(args[0] as Uint8Array);
          break;
        case "projectFileManifest":
          result = runtime.projectFileManifest(args[0] as Uint8Array);
          break;
        case "loadProjectFile":
          result = await loadProjectFileInWorker(
            runtime,
            args[0] as File,
            (value) => {
              self.postMessage({ type: "project_progress", value });
            },
            args[1] as import("@/platform/projectFileWorker").ProjectFileReadOptions | undefined,
          );
          break;
        case "loadProjectFileBytes":
          result = runtime.loadProjectFileBytes(args[0] as Uint8Array);
          break;
        case "prepareProjectConfigurationUpdate":
          result = runtime.prepareProjectConfigurationUpdate(
            args[0] as Uint8Array,
            args[1] as Uint8Array,
            args[2] as string,
          );
          break;
        case "finishProjectFile": {
          result = runtime.finishProjectFile();
          break;
        }
        case "cancelProjectFile":
          result = runtime.cancelProjectFile();
          break;
        case "readProjectFileResource":
          result = runtime.readProjectFileResource(
            args[0] as string,
            args[1] as number | undefined,
          );
          break;
        case "loadProjectWithCompiledCache":
          result = runtime.loadProjectWithCompiledCache(args[0], args[1] as Uint8Array);
          break;
        case "loadProjectWithCompiledCacheBinary":
          result = runtime.loadProjectWithCompiledCacheBinary(
            args[0] as Uint8Array,
            args[1] as Uint8Array,
          );
          break;
        case "traditionalSaveSlotCount":
          result = runtime.traditionalSaveSlotCount();
          break;
        case "inspectTraditionalSave":
          result = runtime.inspectTraditionalSave(args[0] as Uint8Array);
          break;
        case "pump":
          result = runtime.pump(100_000, 1024);
          break;
        default:
          throw new Error(`未知 Worker 方法：${method}`);
      }
    }
    const transfer = runtimeWorkerResultTransfers(method, result);
    self.postMessage({ id, result }, { transfer });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
