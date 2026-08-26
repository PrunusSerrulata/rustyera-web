import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 300_000;

describe("Tauri game progress-loss confirmation", () => {
  it("cancels safely and executes restart and return-to-title only after confirmation", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    if (!(await snapshot()).projectOpen) await $(".welcome .primary").click();
    await waitForInteractiveProject();

    for (const action of [
      { menuLabel: "重新开始", title: "重新开始游戏" },
      { menuLabel: "返回标题", title: "返回标题" },
    ]) {
      const before = await snapshot();
      await openFileMenu();
      await button(action.menuLabel).click();
      const confirmation = await $(`.dialog-panel[aria-label='${action.title}']`);
      await confirmation.waitForDisplayed();
      assert.match(await confirmation.getText(), /可能会丢失尚未保存的游戏进度/);
      await confirmation.$("button=取消").click();
      await confirmation.waitForDisplayed({ reverse: true });

      const after = await snapshot();
      assert.equal(after.runtimeEpoch, before.runtimeEpoch);
      assert.equal(after.presentationRevision, before.presentationRevision);
      assert.deepEqual(after.output, before.output);
      assert.equal(await browser.execute(() => document.activeElement?.id), "menu-file");
    }

    const beforeTitle = await snapshot();
    await openFileMenu();
    await button("返回标题").click();
    const titleConfirmation = await $(".dialog-panel[aria-label='返回标题']");
    await titleConfirmation.waitForDisplayed();
    await titleConfirmation.$("button=返回标题").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "confirmed return-to-title did not reach a new stable presentation",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        state.runtimeEpoch !== beforeTitle.runtimeEpoch,
    });
    const afterTitle = await snapshot();
    assert.notEqual(afterTitle.runtimeEpoch, beforeTitle.runtimeEpoch);

    const beforeRestartAttempt = afterTitle.startupTelemetry?.attemptId;
    await openFileMenu();
    await button("重新开始").click();
    const restartConfirmation = await $(".dialog-panel[aria-label='重新开始游戏']");
    await restartConfirmation.waitForDisplayed();
    await restartConfirmation.$("button=重新开始").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "confirmed restart did not create a new interactive session",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        state.startupTelemetry?.outcome === "success" &&
        state.startupTelemetry.attemptId > beforeRestartAttempt,
    });
    const afterRestart = await snapshot();
    const lifecycleMemory = [afterRestart.memory];
    let previousEpoch = afterRestart.runtimeEpoch;
    let previousAttempt = afterRestart.startupTelemetry?.attemptId;
    assert.equal(typeof previousAttempt, "number", "restart did not expose a telemetry attempt id");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await openFileMenu();
      await button("返回标题").click();
      const returnConfirmation = await $(".dialog-panel[aria-label='返回标题']");
      await returnConfirmation.waitForDisplayed();
      await returnConfirmation.$("button=返回标题").click();
      await waitForRuntimeProgress({
        browser,
        snapshot,
        label: `repeat return-to-title ${cycle + 1} did not stabilize`,
        totalTimeout: PROJECT_TIMEOUT,
        stallTimeout: PROJECT_TIMEOUT,
        accept: (state) =>
          state?.projectOpen &&
          state.phase === "waiting_input" &&
          state.canInteract &&
          state.runtimeEpoch !== previousEpoch,
      });
      previousEpoch = (await snapshot()).runtimeEpoch;

      await openFileMenu();
      await button("重新开始").click();
      const repeatedRestart = await $(".dialog-panel[aria-label='重新开始游戏']");
      await repeatedRestart.waitForDisplayed();
      await repeatedRestart.$("button=重新开始").click();
      await waitForRuntimeProgress({
        browser,
        snapshot,
        label: `repeat restart ${cycle + 1} did not stabilize`,
        totalTimeout: PROJECT_TIMEOUT,
        stallTimeout: PROJECT_TIMEOUT,
        accept: (state) =>
          state?.projectOpen &&
          state.phase === "waiting_input" &&
          state.canInteract &&
          state.startupTelemetry?.outcome === "success" &&
          state.startupTelemetry.attemptId > previousAttempt,
      });
      const repeated = await snapshot();
      previousAttempt = repeated.startupTelemetry?.attemptId;
      previousEpoch = repeated.runtimeEpoch;
      lifecycleMemory.push(repeated.memory);
    }
    assertFrontendCountersDoNotKeepGrowing(lifecycleMemory);
    assertPlatformCounterDoesNotKeepGrowing(lifecycleMemory);

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: afterRestart.bridgeKind,
        cancelledActions: ["restart", "return_to_title"],
        titleRuntimeEpoch: {
          before: beforeTitle.runtimeEpoch,
          after: afterTitle.runtimeEpoch,
        },
        restartAttempt: {
          before: beforeRestartAttempt,
          after: afterRestart.startupTelemetry?.attemptId,
          outcome: afterRestart.startupTelemetry?.outcome,
        },
        lifecycleMemory,
      }),
    );
  });
});

async function waitForInteractiveProject() {
  await waitForRuntimeProgress({
    browser,
    snapshot,
    label: "configured Era project did not reach a stable input wait",
    totalTimeout: PROJECT_TIMEOUT,
    stallTimeout: PROJECT_TIMEOUT,
    accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
  });
}

function assertFrontendCountersDoNotKeepGrowing(samples) {
  assert.ok(samples.length >= 3);
  for (const path of [
    ["blobUrls", "count"],
    ["blobUrls", "bytes"],
    ["audioBuffers", "count"],
    ["audioBuffers", "estimatedBytes"],
    ["imagePixelSurfaces", "count"],
    ["imagePixelSurfaces", "estimatedBytes"],
    ["imagePixelSurfaces", "inflight"],
  ]) {
    const values = samples.map((sample) =>
      Number(path.reduce((value, key) => value?.[key], sample)),
    );
    assert.ok(values.every(Number.isFinite), `missing memory counter ${path.join(".")}`);
    assert.ok(
      values.at(-1) <= Math.max(...values.slice(0, -1)),
      `${path.join(".")} kept growing across lifecycle transitions: ${values.join(", ")}`,
    );
  }
}

function assertPlatformCounterDoesNotKeepGrowing(samples) {
  const path = [
    "physicalFootprintBytes",
    "privateBytes",
    "committedBytes",
    "residentBytes",
    "anonymousBytes",
  ].find((candidate) =>
    samples.every(
      (sample) => typeof sample?.[candidate] === "number" && Number.isFinite(sample[candidate]),
    ),
  );
  assert.ok(path, "native host did not expose a stable platform memory counter");
  const values = samples.map((sample) => Number(sample[path]));
  assert.ok(
    values.at(-1) <= Math.max(...values.slice(0, -1)),
    `${path} kept growing across lifecycle transitions: ${values.join(", ")}`,
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function openFileMenu() {
  await $("#menu-file").click();
}

function button(label) {
  return $(`//button[normalize-space()=${JSON.stringify(label)}]`);
}
