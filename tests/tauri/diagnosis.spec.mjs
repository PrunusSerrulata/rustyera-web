import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_DIAGNOSIS ? describe : describe.skip;
const timeout = 180_000;

enabled("Tauri diagnosis archive", () => {
  it("exports the core replay unchanged with the snapshot, log, and project", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "18446744073709551615" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "diagnosis fixture did not reach its first input",
      totalTimeout: timeout,
      accept: (state) => state?.canInteract && state.output.includes("REPLAY_DIAGNOSIS_READY"),
    });

    await $(".prompt-bar input").setValue("7");
    await $(".prompt-bar button[type=submit]").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "diagnosis fixture did not accept its semantic input",
      totalTimeout: timeout,
      accept: (state) => state?.canInteract && state.output.includes("REPLAY_DIAGNOSIS_GOT=7"),
    });

    await $("button=帮助").click();
    await $("button=导出诊断信息…").click();
    const target = process.env.VITE_RUSTYERA_TAURI_EXPORT_PATH;
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "diagnosis archive was not written",
      totalTimeout: timeout,
      accept: async () => (await stat(target).catch(() => undefined))?.size > 0,
    });
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "diagnosis export did not restore interaction",
      totalTimeout: timeout,
      accept: (state) => !state?.diagnosis?.exporting && state?.canInteract,
    });

    const members = parseTar(decodeRawZstdFrame(await readFile(target)));
    assert.deepEqual([...members.keys()].sort(), [
      "Replay Diagnosis Fixture.reraproj",
      "input-replay.jsonl",
      "runtime.log",
      "runtime.snapshot",
    ]);
    assert.equal(
      members.get("Replay Diagnosis Fixture.reraproj").subarray(0, 8).toString(),
      "RERAPROJ",
    );
    const replayBytes = members.get("input-replay.jsonl");
    assert.equal(replayBytes.at(-1), 0x0a);
    const records = replayBytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].origin.kind, "new_game");
    assert.equal(records[0].origin.seed, "18446744073709551615");
    assert.equal(records[0].step_count, 1);
    assert.deepEqual(records[1], {
      record: "step",
      sequence: 1,
      action: "text",
      wait_kind: "integer_value",
      result: { kind: "integer", value: "7" },
      message_skip: false,
      text: "7",
    });
    console.log(JSON.stringify({ diagnosisMembers: [...members.keys()], replay: records }));
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

function decodeRawZstdFrame(frame) {
  assert.deepEqual([...frame.subarray(0, 5)], [0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
  const expectedLength = frame.readUInt32LE(5);
  const chunks = [];
  let offset = 9;
  let complete = false;
  while (!complete) {
    assert.ok(offset + 3 <= frame.length, "truncated Zstandard block header");
    const header = frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    offset += 3;
    complete = (header & 1) !== 0;
    assert.equal((header >>> 1) & 3, 0, "diagnosis frame must use raw Zstandard blocks");
    const length = header >>> 3;
    assert.ok(offset + length <= frame.length, "truncated Zstandard raw block");
    chunks.push(frame.subarray(offset, offset + length));
    offset += length;
  }
  const decoded = Buffer.concat(chunks);
  assert.equal(decoded.length, expectedLength);
  assert.equal(offset, frame.length);
  return decoded;
}

function parseTar(tar) {
  const members = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const sizeText = cString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    members.set(name, data);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}
