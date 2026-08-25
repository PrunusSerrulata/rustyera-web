import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_INPUT_REPLAY_EXPORT ? describe : describe.skip;
const timeout = 180_000;

enabled("Tauri operation-sequence export", () => {
  it("exports the core input replay through the visible file menu", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "operation-sequence fixture did not reach its first input",
      totalTimeout: timeout,
      accept: (state) => state?.canInteract && state.output.includes("REPLAY_DIAGNOSIS_READY"),
    });

    await $(".prompt-bar input").setValue("7");
    await $(".prompt-bar button[type=submit]").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "operation-sequence fixture did not accept its input",
      totalTimeout: timeout,
      accept: (state) => state?.canInteract && state.output.includes("REPLAY_DIAGNOSIS_GOT=7"),
    });

    await $("button=文件").click();
    await $("button=导出操作序列…").click();
    const target = process.env.VITE_RUSTYERA_TAURI_EXPORT_PATH;
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "operation sequence was not written",
      totalTimeout: timeout,
      accept: async (state) =>
        state?.canInteract && (await stat(target).catch(() => undefined))?.size > 0,
    });

    const records = (await readFile(target, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].record, "header");
    assert.equal(records[0].fidelity, "manual_path");
    assert.equal(records[0].step_count, 1);
    assert.equal(records[1].action, "text");
    assert.equal(records[1].result.value, "7");
    console.log(JSON.stringify({ operationSequencePath: target, records }));
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}
