import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_FULL_PROJECT_EXPORT ? describe : describe.skip;
const timeout = 180_000;

enabled("Tauri full project export", () => {
  it("keeps background caching interactive and locks only the manual full export", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "background cache export did not remain interactive",
      totalTimeout: timeout,
      stallTimeout: timeout,
      accept: (state) => {
        if (state?.transfer?.export?.name === "compiled-project.reracache") {
          assert.equal(state.canInteract, true);
          return true;
        }
        return false;
      },
    });

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
    const bytes = await readFile(target);
    assert.equal(bytes.subarray(0, 8).toString(), "RERAPROJ");
    assert.equal((await snapshot()).canInteract, true);
    console.log(
      JSON.stringify({ backgroundCacheInteractive: true, fullProjectBytes: bytes.length }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}
