import type { DiagnosisArchiveInput } from "@/core/diagnosis";

export function streamDiagnosisArchiveInWorker(
  input: DiagnosisArchiveInput,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const worker = new Worker(new URL("./diagnosis.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (
      event: MessageEvent<{
        chunk?: Uint8Array;
        complete?: boolean;
        error?: string;
      }>,
    ) => {
      if (event.data.error) {
        worker.terminate();
        reject(new Error(event.data.error));
      } else if (event.data.complete) {
        worker.terminate();
        resolve();
      } else if (event.data.chunk) {
        void write(new Uint8Array(event.data.chunk)).then(
          () => worker.postMessage({ type: "continue" }),
          (error) => {
            worker.terminate();
            reject(error);
          },
        );
      } else {
        worker.terminate();
        reject(new Error("诊断归档 Worker 返回了无效结果"));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "诊断归档 Worker 失败"));
    };
    worker.postMessage(input, [
      input.snapshot.buffer,
      input.inputReplay.buffer,
      input.projectFile.buffer,
    ]);
  });
}
