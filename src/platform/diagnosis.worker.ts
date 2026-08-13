import {
  diagnosisArchiveChunks,
  type DiagnosisArchiveChunk,
  type DiagnosisArchiveInput,
} from "@/core/diagnosis";

let chunks: Iterator<DiagnosisArchiveChunk> | undefined;

self.onmessage = (event: MessageEvent<DiagnosisArchiveInput | { type: "continue" }>) => {
  try {
    if ("type" in event.data) {
      if (event.data.type !== "continue" || !chunks)
        throw new Error("诊断归档 Worker 收到了无效的继续请求");
    } else {
      if (chunks) throw new Error("诊断归档 Worker 已经在处理导出");
      chunks = diagnosisArchiveChunks(event.data);
    }
    const next = chunks.next();
    if (next.done) {
      chunks = undefined;
      self.postMessage({ complete: true });
    } else {
      self.postMessage(
        {
          chunk: next.value.bytes,
          completed: next.value.completed,
          total: next.value.total,
        },
        { transfer: [next.value.bytes.buffer] },
      );
    }
  } catch (error) {
    chunks = undefined;
    self.postMessage({ error: String(error) });
  }
};
