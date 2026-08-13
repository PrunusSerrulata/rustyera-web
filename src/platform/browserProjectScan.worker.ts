import { scanBrowserProjectFile } from "@/platform/browserProjectScanner";

self.onmessage = async (event: MessageEvent) => {
  const { id, relativePath, file, topLevel } = event.data as {
    id: number;
    relativePath: string;
    file: File;
    topLevel: string[];
  };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = scanBrowserProjectFile(relativePath, bytes, new Set(topLevel));
    const transfer = result
      ? [
          result.content_hash.buffer,
          ...(result.payload.type === "bytes" ? [result.payload.value.buffer] : []),
        ]
      : [];
    self.postMessage({ id, ok: true, result }, { transfer });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
