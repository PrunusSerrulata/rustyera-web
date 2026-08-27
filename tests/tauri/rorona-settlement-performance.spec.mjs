import assert from "node:assert/strict";

import {
  clickViewportBottom,
  reachTitle,
  snapshot,
  submit,
  waitForProject,
  waitForWaitChange,
} from "./rorona-flow.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_RORONA_SETTLEMENT_PERFORMANCE
  ? describe
  : describe.skip;
const TARGET_ELAPSED_MS = 50;
const TARGET_BUTTON_TEXT = ["爱抚"];

enabled("Tauri erarorona settlement performance", () => {
  it("returns to the training command screen within 50 ms of pressing the right mouse button", async () => {
    let probeInstalled = false;
    let performanceWindowShowAttempted = false;
    try {
      await waitForProject();
      performanceWindowShowAttempted = true;
      await showPerformanceWindow();
      const manualSetup = await reachManualSettlementBoundary();
      const initial = await snapshot();
      assert.equal(initial.bridgeKind, "tauri");
      assert.equal(initial.phase, "waiting_input");
      assert.equal(initial.wait?.kind, "enter_key");
      assert.equal(initial.fault, null);

      const before = await installSettlementProbe();
      probeInstalled = true;
      assert.equal(before.focused, true, "the performance window must be focused");
      assert.equal(before.visibilityState, "visible");
      assert.equal(
        before.visibleText.length,
        0,
        "an enabled affection command was already visible before right-click settlement",
      );
      const interaction = await clickViewportBottom("right", {
        requireNonInteractive: true,
        captureEvents: false,
      });
      const measurement = await waitForSettlementProbe();
      assert.equal(measurement.error, undefined, measurement.error);
      assert.ok(
        measurement.mouseDownAt != null,
        "the probe did not observe right-button mousedown",
      );
      assert.ok(measurement.mouseUpAt != null, "the probe did not observe right-button mouseup");
      assert.equal(measurement.mouseDownVisibilityState, "visible");
      assert.equal(measurement.mouseDownFocused, true, "the window was not focused at mousedown");
      assert.equal(measurement.paintVisibilityState, "visible");
      assert.equal(measurement.paintFocused, true, "the window was not focused at paint-ready");
      assert.ok(
        measurement.mouseUpAt >= measurement.mouseDownAt,
        "right-button mouseup preceded mousedown",
      );
      assert.ok(
        measurement.mouseUpAt - measurement.mouseDownAt >= 40,
        "the real right button was not held across the two WebDriver commands",
      );
      assert.ok(measurement.paintReadyAt != null, "the probe did not observe a paint-ready target");
      const elapsedMs = measurement.paintReadyAt - measurement.mouseDownAt;
      const timingSummary = JSON.stringify({
        mouseDownAt: measurement.mouseDownAt,
        mouseUpAt: measurement.mouseUpAt,
        invokeStartedAt: measurement.invokeStartedAt,
        invokeResolvedAt: measurement.invokeResolvedAt,
        decodeFinishedAt: measurement.decodeFinishedAt,
        batchHandledAt: measurement.batchHandledAt,
        firstMutationAt: measurement.firstMutationAt,
        domVisibleAt: measurement.domVisibleAt,
        paintReadyAt: measurement.paintReadyAt,
      });
      assert.ok(
        elapsedMs <= TARGET_ELAPSED_MS,
        `right-click settlement took ${elapsedMs.toFixed(3)} ms, exceeding ${TARGET_ELAPSED_MS} ms; timings=${timingSummary}`,
      );

      const final = await snapshot();
      const visibleButtons = await visibleGameButtonText();
      assert.equal(final.bridgeKind, "tauri");
      assert.equal(final.phase, "waiting_input");
      assert.equal(final.canInteract, true);
      assert.equal(final.fault, null);
      for (const text of TARGET_BUTTON_TEXT)
        assert.ok(
          visibleButtons.some((buttonText) => buttonText.includes(text)),
          `${text} was not visibly presented`,
        );
      assert.deepEqual(measurement.visibleText, TARGET_BUTTON_TEXT);
      console.log(
        JSON.stringify({
          type: "tauri-settlement-performance",
          elapsedMs,
          targetMs: TARGET_ELAPSED_MS,
          mouseDownAt: measurement.mouseDownAt,
          mouseUpAt: measurement.mouseUpAt,
          mouseDownVisibilityState: measurement.mouseDownVisibilityState,
          mouseDownFocused: measurement.mouseDownFocused,
          paintVisibilityState: measurement.paintVisibilityState,
          paintFocused: measurement.paintFocused,
          domVisibleAt: measurement.domVisibleAt,
          paintReadyAt: measurement.paintReadyAt,
          invokeStartedAt: measurement.invokeStartedAt,
          invokeResolvedAt: measurement.invokeResolvedAt,
          decodeFinishedAt: measurement.decodeFinishedAt,
          batchHandledAt: measurement.batchHandledAt,
          firstMutationAt: measurement.firstMutationAt,
          invokeElapsedMs:
            measurement.invokeResolvedAt != null && measurement.invokeStartedAt != null
              ? measurement.invokeResolvedAt - measurement.invokeStartedAt
              : null,
          mutationCallbacks: measurement.mutationCallbacks,
          textSamples: measurement.textSamples,
          wait: final.wait,
          foreground: {
            focused: before.focused,
            visibilityState: before.visibilityState,
          },
          interaction,
          manualSetup,
        }),
      );
    } finally {
      try {
        if (probeInstalled && typeof browser !== "undefined") await cleanupSettlementProbe();
      } finally {
        if (performanceWindowShowAttempted && typeof browser !== "undefined")
          await hidePerformanceWindow();
      }
    }
  });
});

async function showPerformanceWindow() {
  await browser.execute(async () => {
    const appWindow = window.__TAURI__.window.getCurrentWindow();
    if (await appWindow.isMinimized()) await appWindow.unminimize();
    await appWindow.show();
    await appWindow.setFocus();
    window.focus();
  });
  let foreground;
  await browser.waitUntil(
    async () => {
      foreground = await browser.execute(async () => {
        const appWindow = window.__TAURI__.window.getCurrentWindow();
        const visible = await appWindow.isVisible();
        const minimized = await appWindow.isMinimized();
        const focused = await appWindow.isFocused();
        if (minimized) await appWindow.unminimize();
        if (minimized || !focused || document.visibilityState !== "visible") {
          await appWindow.show();
          await appWindow.setFocus();
          window.focus();
        }
        return { visible, minimized, focused, visibilityState: document.visibilityState };
      });
      return (
        foreground.visible &&
        !foreground.minimized &&
        foreground.focused &&
        foreground.visibilityState === "visible"
      );
    },
    {
      timeout: 1_000,
      interval: 20,
      timeoutMsg: "the performance window did not become focused and visible",
    },
  );
  return foreground;
}

async function hidePerformanceWindow() {
  await browser.execute(async () => window.__TAURI__.window.getCurrentWindow().hide());
}

async function reachManualSettlementBoundary() {
  const automaticTimedWaits = await reachTitle(20);
  await submit(1, true);
  await waitForVisibleStep("slot 7 save", {
    waitKind: "string_value",
    text: "载入游戏",
  });
  await submit(7, true);
  await clickVisibleCharacterTrainButton("奥蕾莉亚");
  await waitForVisibleGameButton(/\[\s*0\s*\][\s\S]*爱抚/, "[0] 爱抚");
  await clickVisibleGameButton(/\[\s*0\s*\][\s\S]*爱抚/, "[0] 爱抚");
  const pettingBoundary = await snapshot();
  assert.equal(pettingBoundary.wait?.kind, "enter_key");
  assert.equal(pettingBoundary.canInteract, true);
  assert.equal(pettingBoundary.fault, null);
  return {
    automaticTimedWaits,
    pettingWait: pettingBoundary.wait,
    wait: pettingBoundary.wait,
    outputTail: pettingBoundary.output.slice(-12),
  };
}

async function waitForVisibleStep(label, { waitKind, text, anyText, canInteract } = {}) {
  let accepted;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      if (state?.fault != null)
        throw new Error(`${label}: runtime faulted: ${JSON.stringify(state.fault)}`);
      const output = state?.output?.slice(-100).join("\n") ?? "";
      if (waitKind != null && state?.wait?.kind !== waitKind) return false;
      if (canInteract != null && state?.canInteract !== canInteract) return false;
      if (text != null && !output.includes(text)) return false;
      if (anyText != null && !anyText.some((candidate) => output.includes(candidate))) return false;
      accepted = state;
      return true;
    },
    { timeout: 30_000, interval: 20, timeoutMsg: `${label} was not reached` },
  );
  return accepted;
}

async function waitForVisibleGameButton(pattern, label) {
  let observed = [];
  try {
    await browser.waitUntil(
      async () => {
        observed = await visibleGameButtonText();
        return observed.some((text) => pattern.test(text));
      },
      { timeout: 30_000, interval: 20, timeoutMsg: `${label} button was not reached` },
    );
  } catch (error) {
    throw new Error(`${error.message}; visible game buttons: ${JSON.stringify(observed)}`);
  }
}

async function visibleGameButtonText() {
  return browser.execute(() =>
    [...document.querySelectorAll(".game-viewport button")]
      .filter(
        (button) =>
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          button.getBoundingClientRect().bottom > 0 &&
          button.getBoundingClientRect().top < innerHeight,
      )
      .map((button) => button.textContent?.trim() ?? ""),
  );
}

async function clickVisibleGameButton(pattern, label) {
  const before = await snapshot();
  const buttons = await $$(".game-viewport button");
  for (const button of buttons) {
    const text = await button.getText();
    if (
      !pattern.test(text) ||
      !(await button.isDisplayed({ withinViewport: true })) ||
      !(await button.isEnabled())
    )
      continue;
    await button.click();
    await waitForWaitChange(before.wait?.wait_id);
    return text;
  }
  throw new Error(`the visible ${label} button was not found`);
}

async function clickVisibleCharacterTrainButton(characterName) {
  const before = await snapshot();
  const observed = [];
  for (const line of await $$(".game-viewport .game-line")) {
    if (!(await line.isDisplayed({ withinViewport: true }))) continue;
    const lineText = await line.getText();
    if (!lineText.includes(characterName)) continue;
    for (const button of await line.$$("button")) {
      const text = await button.getText();
      observed.push({ lineText, text });
      if (
        !/^\[\s*调\s*\]$/u.test(text) ||
        !(await button.isDisplayed({ withinViewport: true })) ||
        !(await button.isEnabled())
      )
        continue;
      await button.click();
      await waitForWaitChange(before.wait?.wait_id);
      return text;
    }
  }
  throw new Error(
    `the visible ${characterName} [调] button was not found: ${JSON.stringify(observed)}`,
  );
}

async function installSettlementProbe() {
  return browser.execute((targetText) => {
    window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__?.cleanup?.();
    const viewport = document.querySelector(".game-viewport");
    if (!(viewport instanceof HTMLElement)) throw new Error("game viewport is not available");
    const measurement = {
      mouseDownAt: null,
      mouseUpAt: null,
      mouseDownVisibilityState: null,
      mouseDownFocused: null,
      paintVisibilityState: null,
      paintFocused: null,
      domVisibleAt: null,
      paintReadyAt: null,
      invokeStartedAt: null,
      invokeResolvedAt: null,
      mutationCallbacks: 0,
      firstMutationAt: null,
      textSamples: 0,
      visibleText: [],
    };
    let sampleFrame;
    let paintFrame;
    let armed = false;
    let cleaned = false;
    for (const name of [
      "rustyera:settlement-invoke-start",
      "rustyera:settlement-invoke-resolved",
      "rustyera:settlement-decode-finished",
      "rustyera:settlement-batch-handled",
    ])
      performance.clearMarks(name);
    const targetButtons = () => {
      const buttons = [...viewport.querySelectorAll("button")].filter(
        (button) => button instanceof HTMLButtonElement && !button.disabled,
      );
      return targetText.map(
        (text) => buttons.find((button) => button.textContent?.includes(text)) ?? null,
      );
    };
    const targetTextPresent = () =>
      targetButtons().map((button, index) => (button ? targetText[index] : null));
    const actuallyVisible = (button) => {
      if (!(button instanceof HTMLElement) || !button.isConnected) return false;
      if (
        typeof button.checkVisibility === "function" &&
        !button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        return false;
      for (let current = button; current instanceof HTMLElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        )
          return false;
        if (current === viewport) break;
      }
      const bounds = button.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > viewportBounds.top &&
        bounds.top < viewportBounds.bottom &&
        bounds.right > viewportBounds.left &&
        bounds.left < viewportBounds.right
      );
    };
    const scheduleSample = () => {
      if (!armed || sampleFrame != null || measurement.paintReadyAt != null) return;
      sampleFrame = requestAnimationFrame(sampleText);
    };
    const sampleText = () => {
      sampleFrame = undefined;
      if (!armed || measurement.paintReadyAt != null) return;
      measurement.textSamples += 1;
      if (targetButtons().some((button) => button == null)) return;
      measurement.domVisibleAt ??= performance.now();
      if (paintFrame == null) paintFrame = requestAnimationFrame(samplePaintReady);
    };
    const samplePaintReady = () => {
      paintFrame = undefined;
      if (!armed || measurement.paintReadyAt != null) return;
      const buttons = targetButtons();
      if (buttons.some((button) => !actuallyVisible(button))) {
        scheduleSample();
        return;
      }
      measurement.visibleText = [...targetText];
      measurement.paintVisibilityState = document.visibilityState;
      measurement.paintFocused = document.hasFocus();
      measurement.paintReadyAt = performance.now();
      observer.disconnect();
    };
    const observer = new MutationObserver(() => {
      if (!armed) return;
      measurement.firstMutationAt ??= performance.now();
      measurement.mutationCallbacks += 1;
      scheduleSample();
    });
    const onMouseDown = (event) => {
      if (event.button !== 2 || measurement.mouseDownAt != null) return;
      armed = true;
      measurement.mutationCallbacks = 0;
      measurement.textSamples = 0;
      measurement.mouseDownVisibilityState = document.visibilityState;
      measurement.mouseDownFocused = document.hasFocus();
      measurement.mouseDownAt = performance.now();
      viewport.removeEventListener("mousedown", onMouseDown, true);
    };
    const onMouseUp = (event) => {
      if (event.button === 2 && measurement.mouseUpAt == null)
        measurement.mouseUpAt = performance.now();
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      armed = false;
      observer.disconnect();
      viewport.removeEventListener("mousedown", onMouseDown, true);
      viewport.removeEventListener("mouseup", onMouseUp, true);
      if (sampleFrame != null) cancelAnimationFrame(sampleFrame);
      if (paintFrame != null) cancelAnimationFrame(paintFrame);
      for (const name of [
        "rustyera:settlement-invoke-start",
        "rustyera:settlement-invoke-resolved",
        "rustyera:settlement-decode-finished",
        "rustyera:settlement-batch-handled",
      ])
        performance.clearMarks(name);
      delete window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__;
    };
    const before = targetTextPresent().filter(Boolean);
    viewport.addEventListener("mousedown", onMouseDown, { capture: true });
    viewport.addEventListener("mouseup", onMouseUp, { capture: true });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__ = { measurement, cleanup };
    return {
      visibleText: before,
      focused: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  }, TARGET_BUTTON_TEXT);
}

async function waitForSettlementProbe() {
  await new Promise((resolve) => setTimeout(resolve, TARGET_ELAPSED_MS + 50));
  let measurement = await readSettlementProbe();
  if (measurement.paintReadyAt == null) {
    await new Promise((resolve) => setTimeout(resolve, 4_700));
    measurement = await readSettlementProbe();
  }
  return measurement;
}

async function readSettlementProbe() {
  return browser.execute(() => {
    const probe = window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__;
    if (!probe) return { error: "the settlement probe is not installed" };
    const markTime = (name) => performance.getEntriesByName(name, "mark").at(-1)?.startTime ?? null;
    return {
      ...probe.measurement,
      invokeStartedAt: markTime("rustyera:settlement-invoke-start"),
      invokeResolvedAt: markTime("rustyera:settlement-invoke-resolved"),
      decodeFinishedAt: markTime("rustyera:settlement-decode-finished"),
      batchHandledAt: markTime("rustyera:settlement-batch-handled"),
      ...(probe.measurement.paintReadyAt == null
        ? { error: "the training command screen was not paint-ready in 5 s" }
        : {}),
    };
  });
}

async function cleanupSettlementProbe() {
  await browser.execute(() => window.__RUSTYERA_TAURI_SETTLEMENT_PROBE__?.cleanup?.());
}
