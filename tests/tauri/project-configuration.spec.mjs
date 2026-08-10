import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const projectConfiguration = process.env.VITE_RUSTYERA_TAURI_PROJECT_CONFIGURATION
  ? describe
  : describe.skip;

projectConfiguration("Tauri project-file configuration", () => {
  it("appends a compact transaction and reloads it without rebuilding the project file", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await waitForInteractiveProject();
    await waitForBackgroundProjectExport();
    const projectFile = process.env.VITE_RUSTYERA_TEST_PROJECT_FILE;
    const before = await readFile(projectFile);

    await $("button=文件").click();
    await $("button=从项目文件启动…").click();
    const openConfirmation = await $(".dialog-panel[aria-label='打开新项目']");
    await openConfirmation.waitForDisplayed();
    await openConfirmation.$("button=打开新项目").click();
    await waitForInteractiveProject();

    await $("button=文件").click();
    await $("button=设置…").click();
    const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 设置']");
    await dialog.waitForDisplayed();
    assert.doesNotMatch(await dialog.getText(), /仅对当前会话有效.*退出游戏后将丢失/s);
    await dialog.$("button=交互与输出").click();
    await setRangeValue(await dialog.$("#setting-AudioVolume"), 42);
    await dialog.$("label[for='setting-ReplaceFullWidthSpaces']").click();
    await dialog.$("button=应用").click();

    await browser.waitUntil(
      async () => {
        const after = await readFile(projectFile);
        return after.length > before.length && after.includes("RERACFG1");
      },
      {
        timeout: 20_000,
        timeoutMsg: "project-file configuration transaction was not appended",
      },
    );
    const after = await readFile(projectFile);
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.ok(after.length - before.length < 4_096, "configuration transaction must stay compact");

    const closeSettings = await dialog.$("button=取消");
    await closeSettings.waitForEnabled({ timeout: 20_000 });
    await closeSettings.click();
    await dialog.waitForExist({ reverse: true });
    const beforeRestartAttempt = (await snapshot()).startupTelemetry?.attemptId;
    await $("button=文件").click();
    await $("button=重新开始").click();
    const restartConfirmation = await $(".dialog-panel[aria-label='重新开始游戏']");
    await restartConfirmation.waitForDisplayed();
    await restartConfirmation.$("button=重新开始").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "updated project file did not restart",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        state.startupTelemetry?.outcome === "success" &&
        state.startupTelemetry.attemptId > beforeRestartAttempt,
    });

    await $("button=文件").click();
    await $("button=设置…").click();
    const reopened = await $(".dialog-panel[aria-label='RustyEra Tauri · 设置']");
    await reopened.waitForDisplayed();
    await reopened.$("button=交互与输出").click();
    assert.equal(await reopened.$("#setting-AudioVolume").getValue(), "42");
    assert.equal(await reopened.$("#setting-ReplaceFullWidthSpaces").isSelected(), true);
    assert.equal(await reopened.$("#setting-CharacterWidthMode").getValue(), "AUTOMATIC");

    console.log(
      JSON.stringify({
        bridgeKind: (await snapshot()).bridgeKind,
        baseBytes: before.length,
        appendedBytes: after.length - before.length,
        audioVolume: 42,
        replaceFullWidthSpaces: true,
      }),
    );
  });
});

async function setRangeValue(element, value) {
  assert.equal(await element.getAttribute("type"), "range");
  const minimum = Number(await element.getAttribute("min"));
  const maximum = Number(await element.getAttribute("max"));
  const trackWidth = (await element.getSize("width")) - 16;
  let offset = Math.round(((value - minimum) / (maximum - minimum) - 0.5) * trackWidth);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await element.click({ x: offset });
    const actual = Number(await element.getValue());
    if (actual === value) return;
    offset += Math.round(((value - actual) / (maximum - minimum)) * trackWidth);
  }
  assert.equal(await element.getValue(), String(value));
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitForInteractiveProject() {
  await waitForRuntimeProgress({
    browser,
    snapshot,
    label: "configured project did not reach an input wait",
    totalTimeout: PROJECT_TIMEOUT,
    stallTimeout: PROJECT_TIMEOUT,
    accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
  });
}

async function waitForBackgroundProjectExport() {
  await browser.pause(1_500);
  const initial = await snapshot();
  if (initial?.transfer?.export == null && initial.status === "项目编译完成") return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.transfer?.export == null && state.status === "项目缓存已保存。";
    },
    {
      timeout: PROJECT_TIMEOUT,
      timeoutMsg: "background compiled-project export did not finish",
    },
  );
}
