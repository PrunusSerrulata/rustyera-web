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
  "開始遊戲",
  "开始游戏",
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
    await browser.setWindowSize(900, 470);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.querySelector(".app-shell")?.classList.contains("menu-overlay"),
        ),
      { timeout: 5_000, interval: 50, timeoutMsg: "automatic menu did not hide below 480px" },
    );
    // The native WebDriver reports physical pixels on Retina while CSS media queries use logical
    // viewport pixels. Keep this comfortably above 480 CSS px even at a 2x scale factor.
    await browser.setWindowSize(1800, 1200);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.querySelector(".app-shell")?.classList.contains("menu-overlay"),
        ),
      { timeout: 5_000, interval: 50, timeoutMsg: "automatic menu did not return above 480px" },
    );
    const automaticPanel = await $("section[aria-label='交互辅助面板']");
    assert.equal(await automaticPanel.isDisplayed(), false, "Tauri auto mode must hide the panel");
    assert.equal(await automaticPanel.getAttribute("aria-hidden"), "true");
    await $("button=文件").click();
    await $("button=项目设置…").click();
    const projectSettings = await $(".dialog-panel[aria-label='RustyEra Tauri · 项目设置']");
    await projectSettings.waitForDisplayed();
    const projectMenuModes = await projectSettings.$$("input[name='setting-UseMenu']");
    assert.equal(projectMenuModes.length, 3);
    assert.equal(await projectSettings.$("#setting-UseMenu-AUTO").isSelected(), true);
    await projectSettings.$("button=取消").click();
    await projectSettings.waitForDisplayed({ reverse: true });
    await $("button=文件").click();
    await $("button=偏好设置…").click();

    let dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 偏好设置']");
    await dialog.waitForDisplayed();
    dialog = await verifyFontEnhancement(dialog);
    if (process.env.RUSTYERA_TEST_FONT_ENHANCEMENT_ONLY === "1") return;
    await dialog.$("#preference-global-FontName-override").click();
    const fontInput = await dialog.$("#preference-global-FontName");
    assert.equal(await fontInput.getAttribute("type"), "text");
    assert.equal(await fontInput.getAttribute("list"), "available-game-fonts");
    assert.ok(await fontInput.isEnabled());
    const fontOptions = await dialog.$$("#available-game-fonts option");
    assert.ok(fontOptions.length > 0, "Tauri preferences must expose installed fonts");
    await dialog.$("#preference-global-UseMenu-override").click();
    const globalMenuModes = await dialog.$$("input[name='preference-global-UseMenu']");
    assert.equal(globalMenuModes.length, 3);
    await dialog.$("#preference-global-UseMenu-SHOW").click();
    assert.equal(await dialog.$("#preference-global-UseMenu-SHOW").isSelected(), true);
    await dialog.$("#preference-global-UseMenu-override").click();
    await fontInput.setValue("RustyEra Preference Font");
    assert.equal(await fontInput.getValue(), "RustyEra Preference Font");
    await dialog.$("#preference-global-FontName-override").click();
    await dialog.$("#preference-global-AudioVolume-override").click();
    const globalLayout = await preferenceLayoutMetrics("global");
    console.log(JSON.stringify({ preferenceLayout: "global", ...globalLayout }));
    assert.equal(globalLayout.masterVolumeCount, 0);
    assert.equal(globalLayout.inheritedLongControlCount, 0);
    assertWithin(globalLayout.windowPairTopSpread, 1, "viewport size fields must share a row");
    assertWithin(globalLayout.fontPairTopSpread, 1, "font size and line height must share a row");
    assertWithin(globalLayout.audioLeftDifference, 1, "game volume must start at the row edge");
    assertWithin(globalLayout.audioRightDifference, 1, "game volume must end at the row edge");
    assertWithin(
      globalLayout.audioControlRightDifference,
      1,
      "game volume control must respect the row edge",
    );
    assert.equal(globalLayout.audioControlContained, true);
    assertWithin(
      globalLayout.imageScaleTopDifference,
      1,
      "image scale input must share a row with its label",
    );
    assertWithin(
      globalLayout.imageScaleRightDifference,
      1,
      "image scale input must respect the column edge",
    );
    assert.equal(globalLayout.imageScaleOverlapsLabel, false);
    assertWithin(
      globalLayout.colorCenterSpread,
      1,
      "color controls must be vertically centered with their names",
    );
    assertWithin(globalLayout.colorLeftSpread, 1, "color controls must share a leading edge");
    assert.equal(globalLayout.colorsOverlapLabels, false);
    assertWithin(
      globalLayout.metadataTopDifference,
      1,
      "metadata trust control must align with its setting name",
    );

    await dialog.$("button=项目偏好").click();
    await dialog.$("#preference-project-UseMenu-override").click();
    const projectMenuMode = await dialog.$("#preference-project-UseMenu-SHOW");
    await projectMenuMode.click();
    assert.equal(await projectMenuMode.isSelected(), true);
    await dialog.$("#preference-project-interactionAssistMode-override").click();
    const interactionAssistMode = await dialog.$("#preference-project-interactionAssistMode-on");
    await interactionAssistMode.click();
    assert.equal(await interactionAssistMode.isSelected(), true);
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
    assertWithin(
      projectLayout.fontSizeControlRightDifference,
      1,
      "font size control must respect the column edge",
    );
    assert.equal(projectLayout.fontSizeControlContained, true);
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
      UseMenu: "SHOW",
    });
    assert.equal(preferenceDocument.profiles.tauri.client.interactionAssistMode, "on");

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

    const interactionAssist = await interactionAssistMetrics();
    console.log(JSON.stringify({ interactionAssist }));
    assert.ok(interactionAssist.actionCount > 0, "enabled panel must expose active interactions");
    assert.ok(interactionAssist.firstLabel, "assisted interactions must have accessible labels");
    assertWithin(
      Math.abs(interactionAssist.expandedViewportHeight - interactionAssist.viewportHeight),
      0.5,
      "expanding the panel must not resize the game viewport",
    );
    assert.equal(interactionAssist.expandedScrollTop, interactionAssist.scrollTop);
    assert.ok(
      interactionAssist.expandedPanelHeight <= interactionAssist.viewportHeight * 0.75 + 0.5,
      "expanded panel must stay within three quarters of the viewport",
    );

    const revisionBeforeFlowReset = state.presentationRevision;
    const flowButton = await findInitialFlowButton(".interaction-assist-action");
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

    const requestedViewport = { width: 900, height: 500 };
    await $("button=文件").click();
    await $("button=项目设置…").click();
    const projectSettingsAfterFlow = await $(
      ".dialog-panel[aria-label='RustyEra Tauri · 项目设置']",
    );
    await projectSettingsAfterFlow.waitForDisplayed();
    await projectSettingsAfterFlow.$("button=显示").click();
    await projectSettingsAfterFlow.$("#setting-WindowX").setValue(String(requestedViewport.width));
    await projectSettingsAfterFlow.$("#setting-WindowY").setValue(String(requestedViewport.height));
    const beforeConfiguredRestartAttempt = (await snapshot()).startupTelemetry?.attemptId;
    assert.equal(typeof beforeConfiguredRestartAttempt, "number");
    await projectSettingsAfterFlow.$("button=应用并重启").click();
    await projectSettingsAfterFlow.waitForDisplayed({ reverse: true });
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "project did not return to a stable input wait after applying viewport size",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: async (nextState) => {
        const actionCount = await browser.execute(
          () => document.querySelectorAll(".interaction-assist-action").length,
        );
        const viewport = await gameViewportSize();
        return (
          nextState?.projectOpen &&
          nextState.phase === "waiting_input" &&
          nextState.canInteract &&
          nextState.startupTelemetry?.outcome === "success" &&
          nextState.startupTelemetry.attemptId > beforeConfiguredRestartAttempt &&
          actionCount > 0 &&
          Math.abs(viewport.width - requestedViewport.width) <= 1 &&
          Math.abs(viewport.height - requestedViewport.height) <= 1
        );
      },
    });
    const viewportAfterConfiguredRestart = await gameViewportSize();
    console.log(JSON.stringify({ requestedViewport, viewportAfterConfiguredRestart }));
    assertWithin(
      Math.abs(viewportAfterConfiguredRestart.width - requestedViewport.width),
      1,
      "configured game viewport width must be applied without chrome drift",
    );
    assertWithin(
      Math.abs(viewportAfterConfiguredRestart.height - requestedViewport.height),
      1,
      "configured game viewport height must include the settled interaction-assist row",
    );

    await $("button=文件").click();
    await $("button=项目设置…").click();
    const restoredProjectSettings = await $(
      ".dialog-panel[aria-label='RustyEra Tauri · 项目设置']",
    );
    await restoredProjectSettings.waitForDisplayed();
    await restoredProjectSettings.$("button=显示").click();
    await restoredProjectSettings.$("button=使用当前主视口大小").click();
    assert.equal(
      await restoredProjectSettings.$("#setting-WindowX").getValue(),
      String(requestedViewport.width),
    );
    assert.equal(
      await restoredProjectSettings.$("#setting-WindowY").getValue(),
      String(requestedViewport.height),
    );
    const beforeRoundTripAttempt = (await snapshot()).startupTelemetry?.attemptId;
    assert.equal(typeof beforeRoundTripAttempt, "number");
    await restoredProjectSettings.$("button=应用并重启").click();
    await restoredProjectSettings.waitForDisplayed({ reverse: true });
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "project did not return after saving the restored viewport size",
      totalTimeout: PROJECT_TIMEOUT,
      stallTimeout: PROJECT_TIMEOUT,
      accept: async (nextState) => {
        const actionCount = await browser.execute(
          () => document.querySelectorAll(".interaction-assist-action").length,
        );
        const viewport = await gameViewportSize();
        return (
          nextState?.projectOpen &&
          nextState.phase === "waiting_input" &&
          nextState.canInteract &&
          nextState.startupTelemetry?.outcome === "success" &&
          nextState.startupTelemetry.attemptId > beforeRoundTripAttempt &&
          actionCount > 0 &&
          Math.abs(viewport.width - requestedViewport.width) <= 1 &&
          Math.abs(viewport.height - requestedViewport.height) <= 1
        );
      },
    });
    const viewportAfterRoundTrip = await gameViewportSize();
    console.log(JSON.stringify({ requestedViewport, viewportAfterRoundTrip }));
    assertWithin(
      Math.abs(viewportAfterRoundTrip.width - requestedViewport.width),
      1,
      "round-tripped game viewport width must remain stable",
    );
    assertWithin(
      Math.abs(viewportAfterRoundTrip.height - requestedViewport.height),
      1,
      "round-tripped game viewport height must remain stable",
    );
  });
});

async function gameViewportSize() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    if (!(viewport instanceof HTMLElement)) throw new Error("game viewport is not available");
    const assistance = document.querySelector(".interaction-assist-slot");
    return {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      assistanceHeight: assistance instanceof HTMLElement ? assistance.clientHeight : null,
    };
  });
}

async function findInitialFlowButton(scope = "") {
  for (const label of INITIAL_FLOW_LABELS) {
    const button = await $(`${scope}*=${label}`);
    if (await button.isExisting()) return button;
  }
  assert.fail("project did not expose its initial game-flow button");
}

async function interactionAssistMetrics() {
  const panel = await $("section[aria-label='交互辅助面板']");
  await panel.waitForDisplayed({ timeout: 30_000 });
  const before = await browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const actions = [...document.querySelectorAll(".interaction-assist-action")];
    return {
      viewportHeight: viewport?.getBoundingClientRect().height,
      scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
      actionCount: actions.length,
      firstLabel: actions[0]?.getAttribute("aria-label"),
    };
  });
  await (await panel.$("button[aria-label='展开']")).click();
  const expanded = await browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const panel = document.querySelector("section[aria-label='交互辅助面板']");
    return {
      viewportHeight: viewport?.getBoundingClientRect().height,
      scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
      panelHeight: panel?.getBoundingClientRect().height,
    };
  });
  await (await panel.$("button[aria-label='折叠']")).click();
  return {
    ...before,
    expandedViewportHeight: expanded.viewportHeight,
    expandedScrollTop: expanded.scrollTop,
    expandedPanelHeight: expanded.panelHeight,
  };
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
    const audioControl = box(item("AudioVolume")?.querySelector(".preference-setting-control"));
    const imageScaleItem = box(document.querySelector(".preference-image-scale-setting"));
    const imageScaleLabel = box(
      document.querySelector(".preference-image-scale-setting > .preference-auxiliary-label"),
    );
    const imageScaleControl = box(
      document.querySelector(".preference-image-scale-setting > .preference-setting-control"),
    );
    const colorCodes = ["ForeColor", "BackColor", "FocusColor"];
    const colorControls = colorCodes.map((code) =>
      box(document.querySelector(`#preference-${activeScope}-${code}`)),
    );
    const colorNames = colorCodes.map((code) =>
      box(document.querySelector(`label[for='preference-${activeScope}-${code}-override'] > span`)),
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
    const fontSizeItem = box(item("FontSize"));
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
      audioControlRightDifference:
        audioItem && audioControl ? Math.abs(audioItem.right - audioControl.right) : null,
      audioControlContained:
        audioItem != null &&
        audioControl != null &&
        audioControl.left >= audioItem.left &&
        audioControl.right <= audioItem.right,
      imageScaleTopDifference:
        imageScaleLabel && imageScaleControl
          ? Math.abs(imageScaleLabel.top - imageScaleControl.top)
          : null,
      imageScaleRightDifference:
        imageScaleItem && imageScaleControl
          ? Math.abs(imageScaleItem.right - imageScaleControl.right)
          : null,
      imageScaleOverlapsLabel:
        imageScaleLabel != null &&
        imageScaleControl != null &&
        imageScaleControl.left < imageScaleLabel.right &&
        imageScaleControl.right > imageScaleLabel.left &&
        imageScaleControl.top < imageScaleLabel.bottom &&
        imageScaleControl.bottom > imageScaleLabel.top,
      colorLeftSpread: colorLefts.every((left) => left != null)
        ? Math.max(...colorLefts) - Math.min(...colorLefts)
        : null,
      colorCenterSpread:
        colorControls.every((control) => control != null) &&
        colorNames.every((name) => name != null)
          ? Math.max(
              ...colorControls.map((control, index) =>
                Math.abs(
                  (control.top + control.bottom) / 2 -
                    (colorNames[index].top + colorNames[index].bottom) / 2,
                ),
              ),
            )
          : null,
      colorsOverlapLabels,
      metadataTopDifference:
        metadataName && metadataControl ? Math.abs(metadataName.top - metadataControl.top) : null,
      fontSizeControlGap:
        fontSizeControl && fontSizeName ? fontSizeControl.top - fontSizeName.bottom : null,
      fontSizeControlLeftDifference:
        fontSizeControl && fontSizeName ? Math.abs(fontSizeControl.left - fontSizeName.left) : null,
      fontSizeControlRightDifference:
        fontSizeControl && fontSizeItem
          ? Math.abs(fontSizeControl.right - fontSizeItem.right)
          : null,
      fontSizeControlContained:
        fontSizeControl != null &&
        fontSizeItem != null &&
        fontSizeControl.left >= fontSizeItem.left &&
        fontSizeControl.right <= fontSizeItem.right,
    };
  }, scope);
}

async function verifyFontEnhancement(dialog) {
  const open = async () => {
    await $("button=文件").click();
    await $("button=偏好设置…").click();
    dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 偏好设置']");
    await dialog.waitForDisplayed();
    await dialog.$("#preference-tab-global").click();
  };
  const apply = async () => {
    await dialog.$("button=应用").click();
    await dialog.waitForDisplayed({ reverse: true });
  };
  const enhancedCount = () =>
    browser.execute(() => document.querySelectorAll(".game-viewport .game-font-enhanced").length);
  const projectClient = async () =>
    JSON.parse(
      await readFile(
        path.join(process.env.VITE_RUSTYERA_TEST_PROJECT, ".rustyera", "preferences-v1.json"),
        "utf8",
      ),
    ).profiles.tauri.client;
  await dialog.$("#preference-tab-global").click();
  assert.equal(await dialog.$("#preference-global-fontEnhancement").isSelected(), false);
  await dialog.$("#preference-global-fontEnhancement").click();
  assert.deepEqual(
    await browser.execute(() => ({
      preview: document.querySelectorAll(".font-preview-current.game-font-enhanced").length,
      other: document.querySelectorAll(".game-font-enhanced:not(.font-preview-current)").length,
    })),
    { preview: 1, other: 0 },
  );
  await dialog.$("button=取消").click();
  await dialog.waitForDisplayed({ reverse: true });
  assert.equal(await enhancedCount(), 0);
  const originalGeometry = await fontEnhancementGeometry();
  await open();
  assert.equal(await dialog.$("#preference-global-fontEnhancement").isSelected(), false);
  await dialog.$("#preference-global-fontEnhancement").click();
  await apply();
  assert.ok((await enhancedCount()) > 0);
  assert.deepEqual(await fontEnhancementGeometry(), originalGeometry);
  const paint = await browser.execute(() => {
    const text = document.querySelector(".game-viewport .game-font-enhanced");
    return {
      stroke: getComputedStyle(text).webkitTextStrokeWidth,
      color: getComputedStyle(text).color,
      strokeColor: getComputedStyle(text).webkitTextStrokeColor,
    };
  });
  assert.equal(paint.stroke, "0.2px");
  assert.equal(paint.strokeColor, paint.color);
  // Compare all three paint states before pointer movement can scroll the viewport.
  await open();
  await dialog.$("#preference-global-fontEnhancement").click();
  await apply();
  assert.equal(await enhancedCount(), 0);
  assert.deepEqual(await fontEnhancementGeometry(), originalGeometry);
  await open();
  await dialog.$("#preference-global-fontEnhancement").click();
  await apply();
  const textButton = await $(
    ".game-viewport .game-button:has(.game-font-enhanced), .game-viewport button.html-node:has(.game-font-enhanced)",
  );
  await textButton.moveTo();
  const hoverPaint = await browser.execute(() =>
    [...document.querySelectorAll(".game-viewport .game-font-enhanced")].map((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, strokeColor: style.webkitTextStrokeColor };
    }),
  );
  assert.ok(hoverPaint.length > 0);
  assert.ok(hoverPaint.every((item) => item.color === item.strokeColor));
  console.log(
    JSON.stringify({
      fontEnhancementHoverColors: [...new Set(hoverPaint.map((item) => item.color))],
    }),
  );
  await open();
  assert.equal(await dialog.$("#preference-global-fontEnhancement").isSelected(), true);
  await dialog.$("#preference-tab-project").click();
  await dialog.$("#preference-project-fontEnhancement-override").click();
  assert.equal(await dialog.$("#preference-project-fontEnhancement").isSelected(), true);
  await dialog.$("#preference-project-fontEnhancement").click();
  await apply();
  assert.equal(await enhancedCount(), 0);
  assert.equal((await projectClient()).fontEnhancement, false);
  await open();
  await dialog.$("#preference-tab-project").click();
  assert.equal(await dialog.$("#preference-project-fontEnhancement-override").isSelected(), true);
  assert.equal(await dialog.$("#preference-project-fontEnhancement").isSelected(), false);
  await dialog.$("#preference-project-fontEnhancement-override").click();
  await apply();
  assert.ok((await enhancedCount()) > 0);
  assert.equal((await projectClient()).fontEnhancement, undefined);
  await open();
  await dialog.$("#preference-global-fontEnhancement").click();
  await apply();
  assert.equal(await enhancedCount(), 0);
  console.log(
    JSON.stringify({
      fontEnhancement: {
        previewIsolated: true,
        projectFalsePersisted: true,
        inherited: true,
        paint,
      },
    }),
  );
  await open();
  return dialog;
}

async function fontEnhancementGeometry() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
    const text = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      text.push({
        text: range.toString(),
        rects: [...range.getClientRects()].map((rect) => [rect.x, rect.y, rect.width, rect.height]),
      });
    }
    const buttons = [...viewport.querySelectorAll("button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent, rect: [rect.x, rect.y, rect.width, rect.height] };
    });
    const clientStroke = [
      ...document.querySelectorAll(
        ".menu-row button, .prompt-bar input, .prompt-bar button, canvas",
      ),
    ].map((element) => getComputedStyle(element).webkitTextStrokeWidth);
    return { text, buttons, clientStroke };
  });
}
