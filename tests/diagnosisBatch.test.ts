import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";

import { diagnosisArchiveChunks } from "@/core/diagnosis";
import { DIAGNOSIS_OUTPUT_BATCH_BYTES, DiagnosisArchiveBatcher } from "@/platform/diagnosisBatch";

describe("diagnosis archive worker batching", () => {
  it("preserves bytes and terminal progress across bounded batches", () => {
    const input = {
      projectName: "batching",
      snapshot: Uint8Array.of(1, 0x80, 0xff),
      inputReplay: Uint8Array.of(2),
      logs: "log",
      projectFile: new Uint8Array(DIAGNOSIS_OUTPUT_BATCH_BYTES + 256 * 1024).fill(0xa5),
      exportedAt: new Date(2026, 7, 13, 12, 0, 0),
    };
    const originalChunks = [...diagnosisArchiveChunks(input)];
    const expected = concatenate(originalChunks.map((chunk) => chunk.bytes));
    const maximumGeneratorChunk = Math.max(...originalChunks.map((chunk) => chunk.bytes.length));
    const batcher = new DiagnosisArchiveBatcher(diagnosisArchiveChunks(input));
    const batches = [];

    while (true) {
      const batch = batcher.next();
      if ("type" in batch) {
        expect(batch).toEqual({ type: "complete" });
        break;
      }
      batches.push(batch);
    }

    expect(batches.length).toBeGreaterThan(1);
    const actual = concatenate(batches.map((batch) => batch.bytes));
    expect(actual.length).toBe(expected.length);
    expect(blake3(actual)).toEqual(blake3(expected));
    expect(Math.max(...batches.map((batch) => batch.bytes.length))).toBeLessThanOrEqual(
      DIAGNOSIS_OUTPUT_BATCH_BYTES + maximumGeneratorChunk,
    );
    let completed = 0;
    for (const batch of batches) {
      completed += batch.bytes.length;
      expect(batch.completed).toBe(completed);
      expect(batch.total).toBe(expected.length);
    }
    expect(batches.at(-1)?.completed).toBe(batches.at(-1)?.total);
    expect(batcher.next()).toEqual({ type: "complete" });
  });
});

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
