import assert from "node:assert/strict";
import { open, stat } from "node:fs/promises";
import { focusCurrentTauriWindow } from "../../scripts/tauri-test-support.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_FULL_PROJECT_EXPORT ? describe : describe.skip;
const timeout = 180_000;

enabled("Tauri full project export", () => {
  it("streams the full project to an atomic native file and restores interaction", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await browser.waitUntil(async () => (await snapshot())?.canInteract === true, {
      timeout,
      interval: 50,
      timeoutMsg: "project did not reach an interactive state",
    });

    // Loading may complete after the OS has changed the active application.
    await focusCurrentTauriWindow(browser);
    if (process.env.RUSTYERA_TW_EXPORT_STABLE_MENU === "1") {
      // TW's title starts a demo after twenty seconds; use its real stable load menu.
      await $("button=[1] 继续游戏").click();
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          return state.canInteract && state.wait?.stability === "stable_input";
        },
        { timeout, interval: 50, timeoutMsg: "TW load menu did not reach stable input" },
      );
    }
    await $("button=文件").click();
    await $("button=导出全量项目文件…").click();
    const dialog = await $(".dialog-panel[aria-label='导出全量项目文件']");
    await dialog.waitForDisplayed();
    assert.equal((await snapshot()).canInteract, false);

    const target = process.env.VITE_RUSTYERA_TAURI_EXPORT_PATH;
    await browser.waitUntil(async () => (await stat(target).catch(() => undefined))?.size > 0, {
      timeout,
      timeoutMsg: "full project export was not written",
    });
    await dialog.waitForExist({ reverse: true, timeout });
    const file = await open(target, "r");
    const header = Buffer.alloc(8);
    try {
      assert.equal((await file.read(header, 0, 8, 0)).bytesRead, 8);
    } finally {
      await file.close();
    }
    assert.equal(header.toString(), "RERAPROJ");
    assert.equal((await snapshot()).canInteract, true);
    console.log(
      JSON.stringify({ fullProjectBytes: (await stat(target)).size, runtime: await snapshot() }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshotSummary());
}
