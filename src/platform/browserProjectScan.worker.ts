import { scanBrowserProjectFile } from "@/platform/browserProjectScanner";

type ScanWorkerPost = (message: unknown, options?: StructuredSerializeOptions) => void;

export function createBrowserProjectScanHandler(post: ScanWorkerPost) {
  let projectTopLevel = new Set<string>();
  return async (event: MessageEvent) => {
    const { id, relativePath, file, topLevel } = event.data as {
      id: number;
      relativePath: string;
      file: File;
      topLevel?: string[];
    };
    try {
      if (topLevel) projectTopLevel = new Set(topLevel);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = scanBrowserProjectFile(relativePath, bytes, projectTopLevel);
      const transfer = result
        ? [
            result.content_hash.buffer,
            ...(result.payload.type === "bytes" ? [result.payload.value.buffer] : []),
          ]
        : [];
      post({ id, ok: true, result }, { transfer });
    } catch (error) {
      post({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

if (typeof self !== "undefined") {
  self.onmessage = createBrowserProjectScanHandler((message, options) =>
    self.postMessage(message, options),
  );
}
