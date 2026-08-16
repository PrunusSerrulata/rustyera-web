import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

preferences("Tauri client preferences", () => {
  it("persists project preferences and preserves hot display settings across game flow resets", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await waitForInteractiveProject();
    await waitForBackgroundProjectExport();
    await $("button=文件").click();
    await $("button=偏好设置…").click();

    const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 偏好设置']");
    await dialog.waitForDisplayed();
    const globalLayout = await preferenceLayoutMetrics("global");
    console.log(JSON.stringify({ preferenceLayout: "global", ...globalLayout }));
    assert.equal(globalLayout.masterVolumeCount, 0);
    assert.equal(globalLayout.inheritedLongControlCount, 0);
    assertWithin(globalLayout.windowPairTopSpread, 1, "viewport size fields must share a row");
    assertWithin(globalLayout.fontPairTopSpread, 1, "font size and line height must share a row");
    assertWithin(globalLayout.audioLeftDifference, 1, "game volume must start at the row edge");
    assertWithin(globalLayout.audioRightDifference, 1, "game volume must end at the row edge");
    assertWithin(globalLayout.colorLeftSpread, 1, "color controls must share a leading edge");
    assert.equal(globalLayout.colorsOverlapLabels, false);
    assertWithin(
      globalLayout.metadataTopDifference,
      1,
      "metadata trust control must align with its setting name",
    );

    await dialog.$("button=项目偏好").click();
    await dialog.$("#preference-project-FontSize-override").click();
    await dialog.$("#preference-project-LineHeight-override").click();
    const projectLayout = await preferenceLayoutMetrics("project");
    console.log(JSON.stringify({ preferenceLayout: "project", ...projectLayout }));
    assert.ok(
      Number.isFinite(projectLayout.fontSizeControlGap) &&
        projectLayout.fontSizeControlGap >= 4 &&
        projectLayout.fontSizeControlGap <= 10,
      `font size control must occupy the next row: ${projectLayout.fontSizeControlGap}`,
    );
    assertWithin(
      projectLayout.fontSizeControlLeftDifference,
      1,
      "font size control must align with its setting name",
    );
    const fontSize = await dialog.$("#preference-project-FontSize");
    const initialFontSize = await fontSize.getValue();
    assert.match(initialFontSize, /^\d+$/);
    await fontSize.setValue("20");
    await dialog.$("#preference-project-LineHeight").setValue("20");
    await dialog.$("button=应用").click();

    await browser.waitUntil(async () => (await snapshot())?.status === "项目偏好已应用", {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "project preference completion feedback was not displayed",
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
          metrics.lineHeight === "20px"
        );
      },
      {
        timeout: PROJECT_TIMEOUT,
        timeoutMsg: "project did not hot-apply the saved client preference font size",
      },
    );

    const preferenceDocument = JSON.parse(
      await readFile(
        path.join(process.env.VITE_RUSTYERA_TEST_PROJECT, ".rustyera", "preferences-v1.json"),
        "utf8",
      ),
    );
    assert.equal(preferenceDocument.schemaVersion, 1);
    assert.deepEqual(preferenceDocument.profiles.tauri.settings, {
      FontSize: "20",
      LineHeight: "20",
    });

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
        preferencePath: path.join(
          process.env.VITE_RUSTYERA_TEST_PROJECT,
          ".rustyera",
          "preferences-v1.json",
        ),
      }),
    );
    assert.equal(state.fault, null);
    assert.equal(metrics.fontSize, "20px");
    assert.equal(metrics.lineHeight, "20px");
    assert.equal(metrics.minHeight, "20px");

    const revisionBeforeFlowReset = state.presentationRevision;
    const flowButton = await findInitialFlowButton();
    await flowButton.click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "project did not reach the next input wait after resetting the game flow style",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: async (nextState) => {
        const nextMetrics = await newestGameTextMetrics();
        return (
          nextState?.projectOpen &&
          nextState.phase === "waiting_input" &&
          nextState.canInteract &&
          nextState.presentationRevision !== revisionBeforeFlowReset &&
          nextMetrics?.fontSize === "20px" &&
          nextMetrics.lineHeight === "20px"
        );
      },
    });

    const resetState = await snapshot();
    const resetMetrics = await newestGameTextMetrics();
    console.log(
      JSON.stringify({
        flowReset: true,
        phase: resetState.phase,
        presentationRevision: resetState.presentationRevision,
        resetMetrics,
      }),
    );
    assert.equal(resetState.fault, null);
    assert.equal(resetMetrics.fontSize, "20px");
    assert.equal(resetMetrics.lineHeight, "20px");
  });
});

async function findInitialFlowButton() {
  for (const label of INITIAL_FLOW_LABELS) {
    const button = await $(`button*=${label}`);
    if (await button.isExisting()) return button;
  }
  assert.fail("project did not expose its initial game-flow button");
}

function assertWithin(actual, maximum, message) {
  assert.ok(Number.isFinite(actual) && actual <= maximum, `${message}: ${actual}`);
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
  return browser.execute(() => {
    const line = [...document.querySelectorAll(".game-line")].find(
      (candidate) =>
        !candidate.querySelector(".media-image, .canvas-replay") && candidate.textContent?.trim(),
    );
    if (!(line instanceof HTMLElement)) return null;
    const style = getComputedStyle(line);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
    };
  });
}

async function newestGameTextMetrics() {
  return browser.execute(() => {
    const text = [...document.querySelectorAll(".game-line span")]
      .filter((candidate) => candidate.textContent?.trim())
      .at(-1);
    if (!(text instanceof HTMLElement)) return null;
    const style = getComputedStyle(text);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight };
  });
}

async function preferenceLayoutMetrics(scope) {
  return browser.execute((activeScope) => {
    const box = (element) => element?.getBoundingClientRect();
    const item = (code) =>
      document
        .querySelector(`#preference-${activeScope}-${code}-override`)
        ?.closest(".setting-item");
    const topSpread = (codes) => {
      const tops = codes.map((code) => box(item(code))?.top);
      if (tops.some((top) => top == null)) return null;
      return Math.max(...tops) - Math.min(...tops);
    };
    const audioItem = box(item("AudioVolume"));
    const audioGrid = box(item("AudioVolume")?.closest(".settings-grid"));
    const colorCodes = ["ForeColor", "BackColor", "FocusColor"];
    const colorControls = colorCodes.map((code) =>
      box(document.querySelector(`#preference-${activeScope}-${code}`)),
    );
    const colorLabels = colorCodes.map((code) =>
      box(document.querySelector(`label[for='preference-${activeScope}-${code}-override']`)),
    );
    const colorLefts = colorControls.map((rect) => rect?.left);
    const colorsOverlapLabels = colorControls.some((control, index) => {
      const label = colorLabels[index];
      return (
        control != null &&
        label != null &&
        control.left < label.right &&
        control.right > label.left &&
        control.top < label.bottom &&
        control.bottom > label.top
      );
    });
    const metadataName = box(
      document.querySelector(".preference-metadata-setting > .preference-auxiliary-label"),
    );
    const metadataControl = box(
      document.querySelector(".preference-metadata-setting > .preference-boolean-control"),
    );
    const fontSizeControl = box(document.querySelector(`#preference-${activeScope}-FontSize`));
    const fontSizeName = box(
      document.querySelector(`label[for='preference-${activeScope}-FontSize-override'] > span`),
    );

    return {
      masterVolumeCount: document.querySelectorAll("[id*='masterVolume']").length,
      inheritedLongControlCount: document.querySelectorAll(
        `#preference-${activeScope}-ReplaceFullWidthSpaces`,
      ).length,
      windowPairTopSpread: topSpread(["WindowX", "WindowY"]),
      fontPairTopSpread: topSpread(["FontSize", "LineHeight"]),
      audioLeftDifference:
        audioItem && audioGrid ? Math.abs(audioItem.left - audioGrid.left) : null,
      audioRightDifference:
        audioItem && audioGrid ? Math.abs(audioItem.right - audioGrid.right) : null,
      colorLeftSpread: colorLefts.every((left) => left != null)
        ? Math.max(...colorLefts) - Math.min(...colorLefts)
        : null,
      colorsOverlapLabels,
      metadataTopDifference:
        metadataName && metadataControl ? Math.abs(metadataName.top - metadataControl.top) : null,
      fontSizeControlGap:
        fontSizeControl && fontSizeName ? fontSizeControl.top - fontSizeName.bottom : null,
      fontSizeControlLeftDifference:
        fontSizeControl && fontSizeName ? Math.abs(fontSizeControl.left - fontSizeName.left) : null,
    };
  }, scope);
}
