import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const INITIAL_FLOW_LABELS = [
  "睜開眼睛",
  "睁开眼睛",
  "初次遊玩",
  "初次游玩",
  "從最初開始",
  "从最初开始",
];
const preferences = process.env.VITE_RUSTYERA_TAURI_PREFERENCES ? describe : describe.skip;

preferences("Tauri emuera.config preferences", () => {
  it("hot-applies font settings to history and preserves them across game flow resets", async () => {
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
    const settingsText = await dialog.getText();
    assert.doesNotMatch(settingsText, /当前运行的是项目文件/);
    assert.doesNotMatch(settingsText, /当前项目文件为只读/);
    assert.doesNotMatch(settingsText, /当前项目文件夹(?:无法直接写入|的设置为只读)/);
    await dialog.$("button=显示").click();
    assert.equal(await dialog.$("#setting-WindowX").isDisplayed(), true);
    assert.equal(await dialog.$("button=使用当前主视口大小").isDisplayed(), true);
    const fontName = await dialog.$("#setting-FontName");
    assert.equal(await fontName.getTagName(), "input");
    assert.equal(await fontName.getAttribute("list"), "available-game-fonts");
    assert.equal((await dialog.$$("#available-game-fonts option")).length > 0, true);
    assert.equal(await dialog.$(".font-access-status").getAttribute("data-state"), "ready");
    const configuredFont = await chooseDifferentSystemFont(await fontName.getValue());
    await fontName.setValue(configuredFont);
    const fontSize = await dialog.$("#setting-FontSize");
    const initialFontSize = await fontSize.getValue();
    assert.match(initialFontSize, /^\d+$/);
    await fontSize.setValue("20");
    await dialog.$("#setting-LineHeight").setValue("20");
    await dialog.$("button=应用").click();

    await browser.waitUntil(async () => (await snapshot())?.status === "设置已应用", {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "settings completion feedback was not displayed",
    });
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.bridgeKind === "tauri" && state.status === "游戏运行中";
      },
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "settings completion feedback did not restore the stable status",
      },
    );

    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        const metrics = await gameLineMetrics();
        return (
          state?.projectOpen &&
          state.phase === "waiting_input" &&
          state.canInteract &&
          metrics?.fontSize === "20px" &&
          metrics.lineHeight === "20px" &&
          sameFont(metrics.flowButtonFontFamily, configuredFont)
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
        initialFontSize,
        phase: state.phase,
        wait: state.wait,
        metrics,
      }),
    );
    assert.equal(state.fault, null);
    assert.equal(metrics.fontSize, "20px");
    assert.equal(metrics.lineHeight, "20px");
    assert.equal(metrics.minHeight, "20px");
    assert.equal(sameFont(metrics.flowButtonFontFamily, configuredFont), true);

    const revisionBeforeFlowReset = state.presentationRevision;
    const flowButton = await findInitialFlowButton();
    await flowButton.click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "project did not reach the next input wait after resetting the game flow style",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: async (nextState) =>
        nextState?.projectOpen &&
        nextState.phase === "waiting_input" &&
        nextState.canInteract &&
        nextState.presentationRevision !== revisionBeforeFlowReset &&
        sameFont(await newestGameTextFontFamily(), configuredFont),
    });

    const resetState = await snapshot();
    const resetFontFamily = await newestGameTextFontFamily();
    console.log(
      JSON.stringify({
        flowReset: true,
        phase: resetState.phase,
        presentationRevision: resetState.presentationRevision,
        configuredFont,
        resetFontFamily,
      }),
    );
    assert.equal(resetState.fault, null);
    assert.equal(sameFont(resetFontFamily, configuredFont), true);
  });
});

async function chooseDifferentSystemFont(currentFont) {
  const values = await browser.execute(() =>
    [...document.querySelectorAll("#available-game-fonts option")].map((option) => option.value),
  );
  const candidates = values.filter((value) => value && !sameFont(value, currentFont));
  const preferred = ["Arial", "Helvetica", "Menlo"].find((name) =>
    candidates.some((candidate) => sameFont(candidate, name)),
  );
  const selected = preferred ?? candidates[0];
  assert.ok(selected, "system font list must contain an alternative to the configured font");
  return selected;
}

async function findInitialFlowButton() {
  for (const label of INITIAL_FLOW_LABELS) {
    const button = await $(`button*=${label}`);
    if (await button.isExisting()) return button;
  }
  assert.fail("project did not expose its initial game-flow button");
}

function sameFont(actual, expected) {
  const normalize = (value) =>
    String(value ?? "")
      .replaceAll(/["']/g, "")
      .trim()
      .toLowerCase();
  return normalize(actual) === normalize(expected);
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
  // A cold source build schedules cache export after one second. A cache hit leaves the project
  // at the compiled status and has no export to serialize against.
  await browser.pause(1_500);
  const initial = await snapshot();
  if (initial?.transfer?.export == null) return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.transfer?.export == null;
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
  return browser.execute((flowLabels) => {
    const line = [...document.querySelectorAll(".game-line")].find(
      (candidate) =>
        !candidate.querySelector(".media-image, .canvas-replay") && candidate.textContent?.trim(),
    );
    if (!(line instanceof HTMLElement)) return null;
    const style = getComputedStyle(line);
    const flowButton = [...document.querySelectorAll(".game-button")].find((candidate) =>
      flowLabels.some((label) => candidate.textContent?.includes(label)),
    );
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
      flowButtonFontFamily:
        flowButton instanceof HTMLElement && flowButton.querySelector("span") instanceof HTMLElement
          ? getComputedStyle(flowButton.querySelector("span")).fontFamily
          : null,
    };
  }, INITIAL_FLOW_LABELS);
}

async function newestGameTextFontFamily() {
  return browser.execute(() => {
    const text = [...document.querySelectorAll(".game-line span")]
      .filter((candidate) => candidate.textContent?.trim())
      .at(-1);
    return text instanceof HTMLElement ? getComputedStyle(text).fontFamily : null;
  });
}
