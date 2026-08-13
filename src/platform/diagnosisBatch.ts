import type { DiagnosisArchiveChunk } from "@/core/diagnosis";

// Batch small raw Zstandard blocks to amortize worker and host IPC while keeping memory bounded.
export const DIAGNOSIS_OUTPUT_BATCH_BYTES = 8 * 1024 * 1024;

export type DiagnosisArchiveBatch =
  | DiagnosisArchiveChunk
  | {
      type: "complete";
    };

export class DiagnosisArchiveBatcher {
  constructor(private readonly chunks: Iterator<DiagnosisArchiveChunk>) {}

  next(): DiagnosisArchiveBatch {
    const parts: Uint8Array[] = [];
    let byteLength = 0;
    let progress: DiagnosisArchiveChunk | undefined;
    while (byteLength < DIAGNOSIS_OUTPUT_BATCH_BYTES) {
      const next = this.chunks.next();
      if (next.done) break;
      parts.push(next.value.bytes);
      byteLength += next.value.bytes.length;
      progress = next.value;
    }
    if (!progress) return { type: "complete" };

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { bytes, completed: progress.completed, total: progress.total };
  }
}
