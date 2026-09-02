import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_PROFILE === "1" ? describe : describe.skip;

// The existing runner installs the independent five-second full DOM/runtime watchdog.
enabled("Tauri snake compatibility profile", () => {
  it("writes and restores bare text, binary, and gzip 1808 saves in project storage", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "the runner must provide its isolated project copy");
    assert.match(
      await readFile(path.join(project, "reraconfig.toml"), "utf8"),
      /emuera\.skia\.snake/,
    );
    const originalSave = path.join(project, "sav", "save00.sav");
    const sentinel = Buffer.from("reference profile sentinel");
    await mkdir(path.dirname(originalSave), { recursive: true });
    await writeFile(originalSave, sentinel, { flag: "wx" });
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      interval: 100,
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    const initial = await waitForOutput("SNAKE_PROFILE_INITIAL=37");
    assert.ok(
      initial.logs.some((entry) => /emuera\.skia\.snake.*experimental/.test(entry.message)),
    );
    await $("button=调试").click();
    await $("button=日志…").click();
    const logs = await $(".dialog-panel[aria-label='Runtime / 前端日志']");
    await logs.waitForDisplayed();
    assert.match(await logs.getText(), /emuera\.skia\.snake/);
    assert.match(await logs.getText(), /experimental/);
    await logs.$("button[aria-label='关闭']").click();
    await logs.waitForExist({ reverse: true });

    const saved = originalSave;
    const formats = [];
    formats.push((await saveAndRestore(saved)).format);
    await configureSaveFormat({ binary: true, gzip: false });
    formats.push((await saveAndRestore(saved)).format);
    await configureSaveFormat({ binary: true, gzip: true });
    const final = await saveAndRestore(saved);
    formats.push(final.format);
    assert.deepEqual(formats, ["text-1808", "binary-1808", "gzip-1808"]);
    assert.notDeepEqual(await readFile(originalSave), sentinel);
    console.log(
      JSON.stringify({
        project,
        bridgeKind: final.snapshot.bridgeKind,
        profile: "emuera.skia.snake",
        saved,
        formats,
        projectSaveReplaced: true,
        values: [37, 99, 37],
        output: final.snapshot.output,
      }),
    );
  });
});

async function saveAndRestore(saved) {
  await input("1");
  await waitForOutput("SNAKE_PROFILE_SAVE_CHANGED=99");
  const standardSave = await readFile(saved);
  const format = standard1808Format(standardSave);
  assert.ok(format, "snake save must be a bare standard Emuera 1808 file");
  assert.notDeepEqual(standardSave.subarray(0, 8), Buffer.from("RERASAV\0"));
  await input("2");
  const restored = await waitForOutput("SNAKE_PROFILE_SAVE_RESTORED=37");
  assert.equal(restored.bridgeKind, "tauri");
  assert.equal(restored.fault, null);
  return { format, snapshot: restored };
}

async function configureSaveFormat({ binary, gzip }) {
  await $("button=文件").click();
  await $("button=项目设置…").click();
  const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 项目设置']");
  await dialog.waitForDisplayed();
  await dialog.$("button=存档").click();
  await setCheckbox(dialog, "SystemSaveInBinary", binary);
  await setCheckbox(dialog, "ZipSaveData", gzip);
  await dialog.$("button=应用").click();
  const close = await dialog.$("button=取消");
  await close.waitForEnabled({ timeout: 20_000 });
  await close.click();
  await dialog.waitForExist({ reverse: true });

  const beforeAttempt = (await snapshot()).startupTelemetry?.attemptId;
  await $("button=文件").click();
  await $("button=重新开始").click();
  const confirmation = await $(".dialog-panel[aria-label='重新开始游戏']");
  await confirmation.waitForDisplayed();
  await confirmation.$("button=重新开始").click();
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      if (state?.fault) throw new Error(JSON.stringify(state.fault));
      return (
        state?.bridgeKind === "tauri" &&
        state.canInteract &&
        state.wait?.kind === "integer_value" &&
        state.startupTelemetry?.outcome === "success" &&
        state.startupTelemetry.attemptId > beforeAttempt &&
        state.output.some((line) => line.includes("SNAKE_PROFILE_INITIAL=37"))
      );
    },
    { timeout: 120_000, interval: 100, timeoutMsg: "save format restart did not finish" },
  );
}

async function setCheckbox(dialog, code, selected) {
  const checkbox = await dialog.$(`#setting-${code}`);
  if ((await checkbox.isSelected()) !== selected) {
    await dialog.$(`label[for='setting-${code}']`).click();
  }
  assert.equal(await checkbox.isSelected(), selected);
}

function standard1808Format(bytes) {
  const binary = Buffer.from([0x89, 0x45, 0x52, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);
  const gzip = Buffer.from([0x89, 0x45, 0x52, 0x41, 0x5a, 0x49, 0x50, 0x0a]);
  if (bytes.subarray(0, 8).equals(binary) || bytes.subarray(0, 8).equals(gzip)) {
    assert.equal(bytes.readUInt32LE(8), 1808);
    return bytes.subarray(0, 8).equals(gzip) ? "gzip-1808" : "binary-1808";
  }
  const lines = bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  if (
    /^-?\d+$/.test(lines[0] ?? "") &&
    /^-?\d+$/.test(lines[1] ?? "") &&
    lines.includes("__EMUERA_1808_STRAT__")
  )
    return "text-1808";
  return null;
}

async function input(value) {
  await $(".prompt-bar input").setValue(value);
  await $(".prompt-bar button[type=submit]").click();
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitForOutput(marker) {
  let current;
  await browser.waitUntil(
    async () => {
      current = await snapshot();
      if (current?.fault) throw new Error(JSON.stringify(current.fault));
      return (
        current?.bridgeKind === "tauri" &&
        current.canInteract &&
        current.wait?.kind === "integer_value" &&
        current.output.some((line) => line.includes(marker))
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: `snake fixture did not reach ${marker}` },
  );
  return current;
}
