type WasmModule = {
  default: () => Promise<void>;
  WasmRuntime: new (options: unknown) => {
    submitRuntime(message: unknown, correlationId?: bigint): bigint;
    submitDebug(message: unknown, correlationId?: bigint): bigint;
    loadProject(manifest: unknown): bigint;
    pump(instructions: number, transitions: number): unknown;
  };
};

let runtime: InstanceType<WasmModule["WasmRuntime"]> | undefined;

self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data as { id: number; method: string; args: unknown[] };
  try {
    let result: unknown;
    if (method === "create") {
      const wasmModuleUrl = "/wasm/era_web_wasm.js";
      const module = (await import(/* @vite-ignore */ wasmModuleUrl)) as WasmModule;
      await module.default();
      runtime = new module.WasmRuntime(args[0]);
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
