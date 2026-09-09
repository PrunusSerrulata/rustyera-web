import assert from "node:assert/strict";
import { runXrayLayoutProbe } from "../../scripts/snake-xray-layout.mjs";

describe("Tauri snapshot Xray layers", () => {
  it("restores every component with its correct position and reserved width", async () => {
    const state = () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshotSummary());
    await browser.waitUntil(async () => Boolean(await state()), { timeout: 20000, interval: 50 });
    assert.equal((await state()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await browser.waitUntil(
      async () => {
        const current = await state();
        assert.equal(current?.fault ?? null, null);
        return current?.canInteract;
      },
      { timeout: 120000, interval: 50 },
    );
    await runXrayLayoutProbe(browser, process.env.RUSTYERA_LAYOUT_EVIDENCE);
  });
});
