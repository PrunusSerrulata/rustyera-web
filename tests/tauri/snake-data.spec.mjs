import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runSnakeDataClient, SNAKE_DATA_MARKERS } from "../../scripts/snake-data-test-support.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_DATA === "1" ? describe : describe.skip;

enabled("Tauri snake data integration", () => {
  it("runs aliases, dynamic methods, resource overlay, structured defaults and GLOBAL", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "runner must provide an isolated project copy");
    const resource = path.join(project, "plugins/data.txt");
    const original = await readFile(resource);
    assert.equal(original.toString("utf8"), "resource-text\n");
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
    const observed = await runSnakeDataClient(browser, "tauri");
    assert.deepEqual(
      await readFile(resource),
      original,
      "Data overlay must not overwrite Resource",
    );
    assert.equal(observed.startupTelemetry.cacheHit, false);
    console.log(
      JSON.stringify({
        project,
        bridgeKind: observed.bridgeKind,
        resourceUnchanged: true,
        verified: SNAKE_DATA_MARKERS,
        output: observed.output,
        displayState: observed.displayState,
      }),
    );
  });
});
