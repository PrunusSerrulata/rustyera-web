import assert from "node:assert/strict";
import { runSnakeBatch1Client } from "../../scripts/snake-services-test-support.mjs";
const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_BATCH1 === "1" ? describe : describe.skip;
enabled("Tauri snake batch1 integration", () => {
  it("executes core-issued services using the real host and visible controls", async () => {
    assert.ok(process.env.VITE_RUSTYERA_TEST_PROJECT, "runner must provide isolated fixture copy");
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshot())),
      { timeout: 20_000, interval: 100 },
    );
    assert.equal(
      await browser.execute(() => window.__RUSTYERA_TEST__.snapshot().bridgeKind),
      "tauri",
    );
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    const observed = await runSnakeBatch1Client(browser, "tauri");
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: observed.bridgeKind,
        output: observed.output,
      }),
    );
  });
});
