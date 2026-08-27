import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_INGESTION === "1" ? describe : describe.skip;
const INITIAL = "SNAKE_INGEST_READY=42/main/84";
const RELOADED = "SNAKE_INGEST_READY=84/main/84";

enabled("Tauri ALS/ERD ingestion", () => {
  it("runs cold and cached index data, then applies a folder alias reload", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "runner must provide an isolated project copy");
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
    const cold = await waitForOutput(INITIAL);
    assert.equal(cold.startupTelemetry.cacheHit, false);
    const cache = path.join(
      project,
      ".rustyera/profiles/emuera.skia.snake/.rustyera/cache/compiled-project.reracache",
    );
    await browser.waitUntil(
      async () => {
        try {
          await access(cache);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, interval: 100, timeoutMsg: "compiled cache was not persisted" },
    );
    await $("button=文件").click();
    await $("button=重新开始").click();
    const restart = await $(".dialog-panel[aria-label='重新开始游戏']");
    await restart.waitForDisplayed();
    await restart.$("button=重新开始").click();
    const warm = await waitForOutput(INITIAL, (state) => state.startupTelemetry?.cacheHit === true);
    assert.equal(warm.bridgeKind, "tauri");

    const aliasPath = path.join(project, "ERB/indices/BUFF.als");
    const previous = await readFile(aliasPath, "utf8");
    assert.equal(previous.match(/10,alias/g)?.length, 1);
    await writeFile(aliasPath, previous.replace("10,alias", "11,alias"));
    await $("button=文件").click();
    await $("button=重新加载文件夹…").click();
    const dialog = await $(".dialog-panel[aria-label='重新加载脚本文件夹']");
    await dialog.waitForDisplayed();
    await dialog.$("select").selectByAttribute("value", "ERB/indices");
    await dialog.$("button=重新加载").click();
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        if (state?.fault) throw new Error(JSON.stringify(state.fault));
        if (String(state?.status).startsWith("重新加载项目失败"))
          throw new Error(JSON.stringify(state.logs));
        return state?.canInteract && Number(state.runtimeEpoch) > Number(warm.runtimeEpoch);
      },
      { timeout: 30_000, interval: 100, timeoutMsg: "native alias reload did not finish" },
    );
    const oldWait = (await snapshot()).wait.wait_id;
    await $(".prompt-bar input").setValue("1");
    await $(".prompt-bar button[type=submit]").click();
    const pinned = await waitForOutput(INITIAL, (state) => state.wait.wait_id !== oldWait);
    assert.equal(
      pinned.output.at(-1),
      INITIAL,
      "active frames must retain their program generation",
    );
    // Return to title uses the already reloaded program; restart would rescan the disk and hide
    // a failure to apply the scoped alias reload.
    await $("button=文件").click();
    await $("button=返回标题").click();
    const title = await $(".dialog-panel[aria-label='返回标题']");
    await title.waitForDisplayed();
    await title.$("button=返回标题").click();
    const reloaded = await waitForOutput(RELOADED);
    assert.equal(reloaded.fault, null);
    assert.equal(reloaded.startupTelemetry.attemptId, warm.startupTelemetry.attemptId);
    console.log(
      JSON.stringify({
        project,
        cache,
        bridgeKind: reloaded.bridgeKind,
        verified: [INITIAL, "cached ALS/ERD", RELOADED],
        output: reloaded.output,
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitForOutput(marker, accept = () => true) {
  let observed;
  await browser.waitUntil(
    async () => {
      observed = await snapshot();
      if (observed?.fault) throw new Error(JSON.stringify(observed.fault));
      return (
        observed?.bridgeKind === "tauri" &&
        observed.canInteract &&
        observed.wait?.kind === "integer_value" &&
        observed.output.some((line) => line.includes(marker)) &&
        accept(observed)
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: `ingestion fixture did not reach ${marker}` },
  );
  return observed;
}
