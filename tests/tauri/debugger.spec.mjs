import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 240_000;

describe("Tauri debugger with the real eraTW project", () => {
  it("provides console, variables, call stack, and source-line stepping", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });

    const initial = await snapshot();
    assert.equal(initial.bridgeKind, "tauri");
    assert.equal(initial.projectOpen, false);
    assert.equal(initial.debug.singleStepEnabled, false);

    await openDebugMenu();
    await button("启用调试").click();
    await browser.waitUntil(async () => (await snapshot())?.debug.enabled === true);

    await $(".welcome .primary").click();
    await openDebugMenu();
    await button("控制台…").click();
    await $(".dialog-panel[aria-label='EraBasic 调试控制台']").waitForDisplayed();

    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.projectOpen && state.phase === "debug_paused" && state.debug.stop != null;
      },
      { timeout: PROJECT_TIMEOUT, timeoutMsg: "eraTW did not reach a debugger stop" },
    );

    const consoleInput = await $(".dialog-panel[aria-label='EraBasic 调试控制台'] .debug-input");
    await consoleInput.setValue("1 + 1");
    await button("求值").click();
    await waitForText(".debug-output", "=> 2");

    await closeDialog("EraBasic 调试控制台");
    await openDebugMenu();
    await button("变量查看器…").click();
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.debug.variablesLoading === false && state.debug.variables.length > 0;
      },
      {
        timeout: 60_000,
        timeoutMsg: "variable table pagination did not complete",
      },
    );
    const variableState = await snapshot();
    const scalar = variableState.debug.variables.find(
      (candidate) => candidate.storage === "global" && candidate.value_kind === "integer",
    );
    assert.ok(
      scalar,
      `no integer variable was listed: ${JSON.stringify(variableState.debug.variables)}`,
    );
    const scalarRow = await variableRow(scalar.name);
    await scalarRow.waitForDisplayed({ timeout: 30_000 });
    const logsBeforeRead = variableState.logs.length;
    await scalarRow.$("button=读取").click();
    await browser.waitUntil(
      async () =>
        (await scalarRow.$(".debug-variable-value").getText()).length > 0 ||
        ((await snapshot())?.logs.length ?? 0) > logsBeforeRead,
      { timeout: 20_000, timeoutMsg: `${scalar.name} read produced neither a value nor an error` },
    );
    const scalarValue = await scalarRow.$(".debug-variable-value").getText();
    assert.match(
      scalarValue,
      /^-?\d+$/,
      `variable read failed: ${JSON.stringify((await snapshot()).logs.slice(logsBeforeRead))}`,
    );

    await closeDialog("变量查看器");
    await openDebugMenu();
    await button("控制台…").click();
    const consoleOutput = await $(".debug-output").getText();
    assert.match(consoleOutput, /=> 2/);

    await closeDialog("EraBasic 调试控制台");
    await openDebugMenu();
    await button("变量查看器…").click();
    await browser.waitUntil(async () => (await snapshot())?.debug.variablesLoading === false, {
      timeout: 60_000,
      timeoutMsg: "variable table refresh did not complete",
    });
    const refreshedRow = await variableRow(scalar.name);
    await refreshedRow.waitForDisplayed({ timeout: 30_000 });
    await refreshedRow.$("button=读取").click();
    await browser.waitUntil(
      async () => (await refreshedRow.$(".debug-variable-value").getText()) === scalarValue,
      {
        timeout: 20_000,
        timeoutMsg: `${scalar.name} did not return the stable value ${scalarValue}`,
      },
    );
    assert.equal(await refreshedRow.$(".debug-variable-value").getText(), scalarValue);

    await closeDialog("变量查看器");
    await openDebugMenu();
    await button("开启单步运行").click();
    await browser.waitUntil(async () => (await snapshot())?.debug.singleStepEnabled === true);
    const promptPlaceholder = await $(".prompt-bar input").getAttribute("placeholder");
    assert.match(promptPlaceholder, /^单步暂停：.+:\d+（F10 继续）$/);

    await openDebugMenu();
    assert.equal(await button("关闭单步运行").isDisplayed(), true);
    await button("Fibers / 调用栈…").click();
    const stackDialog = await $(".dialog-panel[aria-label='Fibers / 调用栈']");
    await stackDialog.waitForDisplayed();
    await browser.waitUntil(
      async () => (await stackDialog.$$(".debug-table:first-child tbody tr")).length > 0,
      {
        timeout: 20_000,
        timeoutMsg: "fiber table remained empty",
      },
    );
    await browser.waitUntil(
      async () => (await stackDialog.$$(".debug-table:last-child tbody tr")).length > 0,
      {
        timeout: 20_000,
        timeoutMsg: "call stack remained empty",
      },
    );
    const fiberRows = await stackDialog.$$(".debug-table:first-child tbody tr");
    const frameRows = await stackDialog.$$(".debug-table:last-child tbody tr");
    const fiberText = await fiberRows[0].getText();
    const frameText = await frameRows[0].getText();
    assert.match(fiberText, /runnable/);
    assert.ok(frameText.trim().length > 0);

    const beforeStep = await snapshot();
    assert.equal(beforeStep.debug.canStep, true);
    const beforeStop = JSON.stringify(beforeStep.debug.stop.stop);
    await browser.keys(["F10"]);
    await browser.waitUntil(
      async () => (await snapshot())?.debug.stop?.reason?.type === "step_completed",
      { timeout: 20_000, timeoutMsg: "F10 did not complete a source-line step" },
    );
    const afterStep = await snapshot();
    assert.equal(afterStep.phase, "debug_paused");
    assert.equal(afterStep.debug.stop.reason.type, "step_completed");
    assert.notEqual(JSON.stringify(afterStep.debug.stop.stop), beforeStop);

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        consoleOutput,
        variable: { name: scalar.name, value: scalarValue },
        fiber: fiberText,
        frame: frameText,
        prompt: promptPlaceholder,
        step: afterStep.debug.stop,
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function openDebugMenu() {
  await $(".menu:nth-child(2) > button").click();
}

function button(label) {
  return $(`//button[normalize-space()=${JSON.stringify(label)}]`);
}

function variableRow(name) {
  return $(
    `//*[@role='dialog' and @aria-label='变量查看器']//tr[td[normalize-space()=${JSON.stringify(name)}]]`,
  );
}

async function closeDialog(label) {
  await $(
    `//*[@role='dialog' and @aria-label=${JSON.stringify(label)}]//button[@aria-label='关闭']`,
  ).click();
}

async function waitForText(selector, expected) {
  await browser.waitUntil(async () => (await $(selector).getText()).includes(expected), {
    timeout: 20_000,
    timeoutMsg: `${selector} did not contain ${expected}`,
  });
}
