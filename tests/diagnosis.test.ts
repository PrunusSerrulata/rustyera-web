import { describe, expect, it } from "vitest";

import {
  createDiagnosisArchive,
  diagnosisArchiveChunks,
  diagnosisArchiveName,
} from "@/core/diagnosis";

describe("diagnosis archive", () => {
  it("matches the TUI name and tar.zst member contract", () => {
    const exportedAt = new Date(2026, 6, 29, 14, 5, 6);
    expect(diagnosisArchiveName("eraThe World", exportedAt)).toBe(
      "eraThe World-diagnosis_20260729-140506.tar.zst",
    );
    const projectFile = new TextEncoder().encode("RERAPROJpayload");

    const archive = createDiagnosisArchive({
      projectName: "eraThe World",
      snapshot: Uint8Array.of(1, 2),
      inputReplay: new TextEncoder().encode('{"record":"header"}\n'),
      logs: "[14:05:06] INFO  ready\n",
      projectFile,
      exportedAt,
    });

    expect(unpackTar(decodeRawZstd(archive))).toEqual({
      "runtime.snapshot": [1, 2],
      "runtime.log": [...new TextEncoder().encode("[14:05:06] INFO  ready\n")],
      "input-replay.jsonl": [...new TextEncoder().encode('{"record":"header"}\n')],
      "eraThe World.reraproj": [...projectFile],
    });
  });

  it("streams bounded archive chunks instead of allocating a complete output buffer", () => {
    const chunks = [
      ...diagnosisArchiveChunks({
        projectName: "unsafe/project",
        snapshot: new Uint8Array(512 * 1024),
        inputReplay: new Uint8Array(512 * 1024),
        logs: "",
        projectFile: new Uint8Array(512 * 1024),
        exportedAt: new Date(2026, 6, 29, 14, 5, 6),
      }),
    ];

    expect(chunks.length).toBeGreaterThan(8);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(128 * 1024 + 3);
    expect(diagnosisArchiveName("unsafe/project", new Date(2026, 6, 29, 14, 5, 6))).toBe(
      "unsafe_project-diagnosis_20260729-140506.tar.zst",
    );
  });
});

function decodeRawZstd(frame: Uint8Array): Uint8Array {
  expect([...frame.slice(0, 5)]).toEqual([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
  const expected = new DataView(frame.buffer, frame.byteOffset).getUint32(5, true);
  const output = new Uint8Array(expected);
  let inputOffset = 9;
  let outputOffset = 0;
  let last = false;
  while (!last) {
    const header =
      frame[inputOffset] | (frame[inputOffset + 1] << 8) | (frame[inputOffset + 2] << 16);
    inputOffset += 3;
    last = Boolean(header & 1);
    expect((header >>> 1) & 3).toBe(0);
    const length = header >>> 3;
    output.set(frame.subarray(inputOffset, inputOffset + length), outputOffset);
    inputOffset += length;
    outputOffset += length;
  }
  expect(outputOffset).toBe(expected);
  return output;
}

function unpackTar(tar: Uint8Array): Record<string, number[]> {
  const decoder = new TextDecoder();
  const members: Record<string, number[]> = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, ""), 8);
    offset += 512;
    members[name] = [...tar.subarray(offset, offset + size)];
    offset += Math.ceil(size / 512) * 512;
  }
  return members;
}
