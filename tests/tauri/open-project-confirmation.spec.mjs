import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 300_000;

describe("Tauri project replacement", () => {
  it("confirms replacement, clears the viewport, and blocks opening while loading", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    if (!(await snapshot()).projectOpen) await $(".welcome .primary").click();
    await waitForStableProject();
    const before = await snapshot();

    await openFileMenu();
    await button("打开项目…").click();
    const cancelDialog = await $(".dialog-panel[aria-label='打开新项目']");
    await cancelDialog.waitForDisplayed();
    assert.match(await cancelDialog.getText(), /会丢失当前游戏中尚未保存的进度/);
    await cancelDialog.$("button=取消").click();
    await cancelDialog.waitForDisplayed({ reverse: true });
    const afterCancel = await snapshot();
    assert.deepEqual(afterCancel.output, before.output);
    assert.equal(afterCancel.runtimeEpoch, before.runtimeEpoch);

    await openFileMenu();
    await button("打开项目…").click();
    const confirmDialog = await $(".dialog-panel[aria-label='打开新项目']");
    await confirmDialog.waitForDisplayed();
    await confirmDialog.$("button=打开新项目").click();
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.output.length === 0 && !state.canInteract;
      },
      { timeout: 20_000, timeoutMsg: "viewport was not cleared while replacing the project" },
    );

    await openFileMenu();
    assert.equal(await button("打开项目…").isEnabled(), false);
    await $("body").click();

    await waitForStableProject();
    const afterConfirm = await snapshot();
    assert.equal(afterConfirm.bridgeKind, "tauri");
    assert.equal(afterConfirm.fault, null);
    assert.equal(afterConfirm.status, "游戏运行中");
    assert.ok(afterConfirm.output.length > 0);

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: afterConfirm.bridgeKind,
        status: afterConfirm.status,
        phase: afterConfirm.phase,
        wait: afterConfirm.wait,
        beforeOutputTail: before.output.slice(-8),
        outputTail: afterConfirm.output.slice(-8),
      }),
    );
  });
});

async function waitForStableProject() {
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
    },
    {
      timeout: PROJECT_TIMEOUT,
      timeoutMsg: "configured Era project did not reach a stable input wait",
    },
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function openFileMenu() {
  await $(".menu:nth-child(1) > button").click();
}

function button(label) {
  return $(`//button[normalize-space()=${JSON.stringify(label)}]`);
}
