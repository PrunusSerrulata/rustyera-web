import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";

export function streamDiagnosisArchiveInWorker(
  input: DiagnosisArchiveInput,
  write: (chunk: Uint8Array) => Promise<void>,
  reportProgress?: (progress: DiagnosisArchiveProgress) => void,
): Promise<number> {
  const worker = new Worker(new URL("./diagnosis.worker.ts", import.meta.url), { type: "module" });
  let totalBytes = 0;
  let lastCompleted = 0;
  let lastReportedPercent = -1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    worker.onmessage = (
      event: MessageEvent<{
        chunk?: Uint8Array;
        completed?: number;
        total?: number;
        complete?: boolean;
        error?: string;
      }>,
    ) => {
      if (event.data.error) {
        fail(new Error(event.data.error));
      } else if (event.data.complete) {
        if (totalBytes <= 0) {
          fail(new Error("诊断归档 Worker 未报告有效的输出大小"));
          return;
        }
        settled = true;
        worker.terminate();
        resolve(totalBytes);
      } else if (event.data.chunk) {
        const { completed, total } = event.data;
        if (
          typeof completed !== "number" ||
          typeof total !== "number" ||
          !Number.isSafeInteger(completed) ||
          !Number.isSafeInteger(total) ||
          total <= 0 ||
          completed < lastCompleted ||
          completed > total ||
          (totalBytes > 0 && total !== totalBytes)
        ) {
          fail(new Error("诊断归档 Worker 返回了无效的字节进度"));
          return;
        }
        const bytes = new Uint8Array(event.data.chunk);
        void Promise.resolve()
          .then(() => write(bytes))
          .then(() => {
            totalBytes = total;
            lastCompleted = completed;
            const percent = Math.floor((completed * 100) / total);
            if (completed < total && percent !== lastReportedPercent) {
              lastReportedPercent = percent;
              reportProgress?.({ completed, total });
            }
          })
          .then(() => worker.postMessage({ type: "continue" }))
          .catch(fail);
      } else {
        fail(new Error("诊断归档 Worker 返回了无效结果"));
      }
    };
    worker.onerror = (event) => {
      fail(new Error(event.message || "诊断归档 Worker 失败"));
    };
    try {
      worker.postMessage(input, [
        input.snapshot.buffer,
        input.inputReplay.buffer,
        input.projectFile.buffer,
      ]);
    } catch (error) {
      fail(error);
    }
  });
}
