import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clickTauriTestElement } from "../../scripts/dom-test-input.mjs";
import {
  assertProjectLoadFailure,
  captureProjectLoadFailure,
} from "../../scripts/project-load-failure.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_PROJECT_LOAD_FAILURE === "1" ? describe : describe.skip;

enabled("Tauri compiler error recovery", () => {
  it("reports invalid HIR and leaves project opening available", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project);
    const artifact = path.join(project, ".rustyera", "compile-failure-result.json");
    const evidence = { result: "running" };
    try {
      await browser.waitUntil(
        async () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__)),
        { timeout: 20_000, interval: 100 },
      );
      assert.equal(
        (await browser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary())).bridgeKind,
        "tauri",
      );
      await browser.execute(() =>
        window.__RUSTYERA_TEST__.configure({
          start: { type: "new_game", seed: "123456" },
          clock: "2026-01-01T00:00:00Z",
        }),
      );
      const open = await $(".welcome .primary");
      assert.ok(await open.isDisplayed());
      assert.ok(await open.isEnabled());
      await clickTauriTestElement(browser, open);
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const state = window.__RUSTYERA_TEST__.snapshotSummary();
            return state.fault != null || state.startupTelemetry?.outcome === "failure";
          }),
        { timeout: 300_000, interval: 100 },
      );
      evidence.state = await browser.execute(captureProjectLoadFailure);
      assertProjectLoadFailure(evidence.state, "compiler.invalidhir");
      assert.equal(evidence.state.bridgeKind, "tauri");
      const menu = await $("#menu-file");
      assert.ok(await menu.isDisplayed());
      await clickTauriTestElement(browser, menu);
      const reopen = await $("#app-menu-bar .menu-popup button");
      assert.equal((await reopen.getText()).trim(), "打开项目…");
      assert.ok(await reopen.isDisplayed());
      assert.ok(await reopen.isEnabled());
      evidence.result = "passed";
    } catch (error) {
      evidence.result = "failed";
      evidence.error = String(error);
      throw error;
    } finally {
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, JSON.stringify(evidence, null, 2) + "\n");
      console.log(
        JSON.stringify({ type: "compile-failure-result", result: evidence.result, artifact }),
      );
    }
  });
});
