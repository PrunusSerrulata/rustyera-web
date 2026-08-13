import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    await Promise.all([
      replaceSource(
        path.join(project, "erb", "diagnosis.erb"),
        "REPLAY_DIAGNOSIS_READY",
        "REPLAY_DIAGNOSIS_RELOADED",
      ),
      replaceSource(
        path.join(project, "erb", "unselected.erb"),
        "UNSELECTED_ACTIVE",
        "UNSELECTED_DISK_ONLY",
      ),
    ]);
    const beforeReload = (await snapshot()).runtimeEpoch;
    await reloadSingleScript("erb/diagnosis.erb");
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "selected diagnosis script did not finish hot reloading",
      totalTimeout: timeout,
      accept: (state) =>
        state?.canInteract &&
        state.projectLoading === false &&
        Number(state.runtimeEpoch) === Number(beforeReload) + 1,
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
    const projectFile = process.env.VITE_RUSTYERA_TEST_PROJECT_FILE;
    await writeFile(projectFile, members.get("Replay Diagnosis Fixture.reraproj"));
    const replayBytes = members.get("input-replay.jsonl");
    assert.equal(replayBytes.at(-1), 0x0a);
    const records = replayBytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const origin = records[0].origin;
    assert.equal(origin.kind, "hot_reload");
    assert.equal(origin.before_revision, "1");
    assert.equal(origin.after_revision, "2");
    assert.deepEqual(origin.changes, [
      {
        operation: "upsert",
        relative_path: "erb/diagnosis.erb",
        category: "erb",
      },
    ]);
    assert.notEqual(origin.before_identity, origin.after_identity);
    assert.equal(origin.project.identity, origin.after_identity);
    assert.equal(origin.project.locale, "zh-Hans");
    assert.equal(origin.project.revision, "2");
    assert.equal(records[0].step_count, 0);
    assert.equal(records.length, 1);

    await $("button=文件").click();
    await $("button=从项目文件启动…").click();
    const confirmation = await $(".dialog-panel[aria-label='打开新项目']");
    await confirmation.waitForDisplayed();
    await confirmation.$("button=打开新项目").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "diagnosis project did not preserve the runtime-accepted source generation",
      totalTimeout: timeout,
      accept: (state) =>
        state?.canInteract &&
        state.output.includes("REPLAY_DIAGNOSIS_RELOADED") &&
        state.output.includes("UNSELECTED_ACTIVE"),
    });
    const reopened = await snapshot();
    assert.equal(reopened.output.includes("UNSELECTED_DISK_ONLY"), false);
    console.log(JSON.stringify({ diagnosisMembers: [...members.keys()], replay: records }));
  });
});

async function replaceSource(file, expected, replacement) {
  const source = await readFile(file, "utf8");
  assert.equal(source.split(expected).length, 2, `${file} must contain one ${expected}`);
  await writeFile(file, source.replace(expected, replacement), "utf8");
}

async function reloadSingleScript(target) {
  await $("button=文件").click();
  await $("button=重新加载单个脚本…").click();
  const dialog = await $(".dialog-panel[aria-label='重新加载单个脚本']");
  await dialog.waitForDisplayed();
  const select = await dialog.$("select");
  await select.waitForEnabled({ timeout: 2_000 });
  await select.selectByAttribute("value", target);
  assert.equal((await select.getValue()).toLowerCase(), target.toLowerCase());
  await dialog.$("button=重新加载").click();
}

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
