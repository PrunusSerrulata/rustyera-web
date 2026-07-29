import type { DiagnosisArchiveInput } from "@/core/diagnosis";

export function createDiagnosisArchiveInWorker(input: DiagnosisArchiveInput): Promise<Uint8Array> {
  const worker = new Worker(new URL("./diagnosis.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ archive?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.archive) resolve(new Uint8Array(event.data.archive));
      else reject(new Error("诊断归档 Worker 返回了无效结果"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "诊断归档 Worker 失败"));
    };
    worker.postMessage(input, [input.snapshot.buffer, input.compiledArtifact.buffer]);
  });
}
