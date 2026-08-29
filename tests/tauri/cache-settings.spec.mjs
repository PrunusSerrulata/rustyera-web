import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";
import { assertStructuredSnakeProfileNotifications } from "./structured-profile-notifications.mjs";

const PROJECT_TIMEOUT = 120_000;
const cacheSettings = process.env.VITE_RUSTYERA_TAURI_CACHE_SETTINGS ? describe : describe.skip;

cacheSettings("Tauri cache-hit project settings", () => {
  it("applies a hot setting without rebuilding from the sparse cache manifest", async () => {
    const driver = browser;
    const snapshot = () => driver.execute(() => window.__RUSTYERA_TEST__?.snapshot());
    await driver.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await driver.$(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser: driver,
      snapshot,
      label: "cache-hit project did not reach a stable input wait",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        state.startupTelemetry?.cacheHit === true &&
        state.transfer?.export == null,
    });

    await driver.$("button=文件").click();
    await driver.$("button=项目设置…").click();
    const dialog = await driver.$(".dialog-panel[aria-label='RustyEra Tauri · 项目设置']");
    await dialog.waitForDisplayed();
    await dialog.$("button=显示").click();
    const fontSize = await dialog.$("#setting-FontSize");
    const initialFontSize = await fontSize.getValue();
    const updatedFontSize = initialFontSize === "17" ? "18" : "17";
    await fontSize.setValue(updatedFontSize);
    await dialog.$("button=应用").click();

    await driver.waitUntil(
      async () => ["项目设置已应用", "游戏运行中"].includes((await snapshot())?.status),
      {
        timeout: 4_000,
        interval: 100,
        timeoutMsg: "settings did not reach a successful settled status",
      },
    );
    let state = await snapshot();
    assert.equal(state.transfer?.export, null);
    assert.equal(state.fault, null);
    assert.equal(
      state.logs.some((entry) => String(entry.message).includes("runtime.compiled_cache_failed")),
      false,
    );
    const visibleNotifications = await driver.$$(".log-notification");
    const visibleNotificationTexts = [];
    for (const notification of visibleNotifications) {
      visibleNotificationTexts.push(await notification.getText());
    }
    assert.ok(
      assertStructuredSnakeProfileNotifications(state, visibleNotificationTexts).length > 0,
      "snake cache fixture must surface its structured compatibility warning",
    );

    await driver.pause(2_100);
    state = await snapshot();
    assert.equal(state.status, "游戏运行中");
    assert.equal(state.transfer?.export, null);
    assert.equal(state.fault, null);
    assert.equal(
      state.logs.some((entry) => String(entry.message).includes("runtime.compiled_cache_failed")),
      false,
    );
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: state.bridgeKind,
        cacheHit: state.startupTelemetry?.cacheHit,
        initialFontSize,
        updatedFontSize,
        status: state.status,
        transfer: state.transfer,
      }),
    );
  });
});
