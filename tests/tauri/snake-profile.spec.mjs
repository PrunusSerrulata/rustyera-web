import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_PROFILE === "1" ? describe : describe.skip;

// The existing runner installs the independent five-second full DOM/runtime watchdog.
enabled("Tauri snake compatibility profile", () => {
  it("uses real native storage and preserves reference data across a save roundtrip", async () => {
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

    await input("1");
    await waitForOutput("SNAKE_PROFILE_SAVE_CHANGED=99");
    const saved = path.join(
      project,
      ".rustyera",
      "profiles",
      "emuera.skia.snake",
      "sav",
      "save00.sav",
    );
    const envelope = await readFile(saved);
    assert.deepEqual(envelope.subarray(0, 8), Buffer.from("RERASAV\0"));
    assert.deepEqual(await readFile(originalSave), sentinel);
    await input("2");
    const restored = await waitForOutput("SNAKE_PROFILE_SAVE_RESTORED=37");
    assert.equal(restored.bridgeKind, "tauri");
    assert.equal(restored.fault, null);
    assert.deepEqual(await readFile(originalSave), sentinel);
    console.log(
      JSON.stringify({
        project,
        bridgeKind: restored.bridgeKind,
        profile: "emuera.skia.snake",
        saved,
        sentinelPreserved: true,
        values: [37, 99, 37],
        output: restored.output,
      }),
    );
  });
});

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
