import { diagnosisArchiveChunks, type DiagnosisArchiveInput } from "@/core/diagnosis";
import { DiagnosisArchiveBatcher } from "@/platform/diagnosisBatch";

let batches: DiagnosisArchiveBatcher | undefined;

self.onmessage = (event: MessageEvent<DiagnosisArchiveInput | { type: "continue" }>) => {
  try {
    if ("type" in event.data) {
      if (event.data.type !== "continue" || !batches)
        throw new Error("诊断归档 Worker 收到了无效的继续请求");
    } else {
      if (batches) throw new Error("诊断归档 Worker 已经在处理导出");
      batches = new DiagnosisArchiveBatcher(diagnosisArchiveChunks(event.data));
    }
    const batch = batches.next();
    if ("type" in batch) {
      batches = undefined;
      self.postMessage({ complete: true });
    } else {
      self.postMessage(
        {
          chunk: batch.bytes,
          completed: batch.completed,
          total: batch.total,
        },
        { transfer: [batch.bytes.buffer] },
      );
    }
  } catch (error) {
    batches = undefined;
    self.postMessage({ error: String(error) });
  }
};
