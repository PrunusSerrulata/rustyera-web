import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const preferences = process.env.VITE_RUSTYERA_TAURI_PREFERENCES ? describe : describe.skip;

preferences("Tauri emuera.config preferences", () => {
  it("uses the unified host-aware settings dialog and hot-applies font geometry", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await waitForInteractiveProject();
    await waitForBackgroundProjectExport();
    await $("button=文件").click();
    await $("button=设置…").click();

    const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 设置']");
    await dialog.waitForDisplayed();
    await dialog.$("button=显示").click();
    assert.equal(await dialog.$("#setting-WindowX").isDisplayed(), true);
    assert.equal(await dialog.$("button=使用当前主视口大小").isDisplayed(), true);
    const fontSize = await dialog.$("#setting-FontSize");
    assert.equal(await fontSize.getValue(), "16");
    await fontSize.setValue("20");
    await dialog.$("#setting-LineHeight").setValue("20");
    await dialog.$("button=应用").click();

    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        const metrics = await gameLineMetrics();
        return (
          state?.projectOpen &&
          state.phase === "waiting_input" &&
          state.canInteract &&
          metrics?.fontSize === "20px" &&
          metrics.lineHeight === "20px"
        );
      },
      {
        timeout: PROJECT_TIMEOUT,
        timeoutMsg: "project did not hot-apply the saved emuera.config font size",
      },
    );

    const state = await snapshot();
    const metrics = await gameLineMetrics();
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: state.bridgeKind,
        phase: state.phase,
        wait: state.wait,
        metrics,
      }),
    );
    assert.equal(state.fault, null);
    assert.deepEqual(metrics, { fontSize: "20px", lineHeight: "20px", minHeight: "20px" });
  });
});

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
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.transfer?.export == null && state.status === "已导出 compiled-project.reraproj";
    },
    {
      timeout: PROJECT_TIMEOUT,
      timeoutMsg: "background compiled-project export did not finish before opening settings",
    },
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function gameLineMetrics() {
  return browser.execute(() => {
    const line = [...document.querySelectorAll(".game-line")].find(
      (candidate) =>
        !candidate.querySelector(".media-image, .canvas-replay") && candidate.textContent?.trim(),
    );
    if (!(line instanceof HTMLElement)) return null;
    const style = getComputedStyle(line);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, minHeight: style.minHeight };
  });
}
