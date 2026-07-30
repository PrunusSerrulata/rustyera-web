type WasmModule = {
  default: () => Promise<void>;
  WasmRuntime: new (
    options: unknown,
    progress?: (value: unknown) => void,
  ) => {
    submitRuntime(message: unknown, correlationId?: bigint): bigint;
    submitDebug(message: unknown, correlationId?: bigint): bigint;
    loadProject(manifest: unknown): bigint;
    loadProjectWithCompiledCache(manifest: unknown, cache: Uint8Array): bigint;
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
      const wasmModuleUrl = import.meta.env.DEV
        ? "/__rustyera_wasm/era_web_wasm.js"
        : `${import.meta.env.BASE_URL}wasm/era_web_wasm.js`;
      const module = (await import(/* @vite-ignore */ wasmModuleUrl)) as WasmModule;
      await module.default();
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
        case "loadProjectWithCompiledCache":
          result = runtime.loadProjectWithCompiledCache(args[0], args[1] as Uint8Array);
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
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
