import assert from "node:assert/strict";

import { clickTauriTestElement } from "../../scripts/dom-test-input.mjs";
import { measureAnimationPerformance } from "../../scripts/web-test-lib.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_BAD_APPLE === "1" ? describe : describe.skip;

enabled("Tauri snake TW Bad Apple", () => {
  it("presents every character frame on cadence and exits on left click", async () => {
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshotSummary())),
      { timeout: 20_000, interval: 50, timeoutMsg: "performance test control was not installed" },
    );
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: 123456 },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await clickTauriTestElement(browser, await browser.$(".welcome .primary"));
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        if (state?.fault) throw new Error(JSON.stringify(state.fault));
        return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
      },
      { timeout: 180_000, interval: 50, timeoutMsg: "snake TW did not reach its title input" },
    );

    const exitPoint = await browser.execute(() => {
      const rectangle = document.querySelector(".game-viewport")?.getBoundingClientRect();
      if (!rectangle || rectangle.width <= 0 || rectangle.height <= 0) return null;
      return {
        x: Math.round(rectangle.left + rectangle.width / 2),
        y: Math.round(rectangle.top + rectangle.height / 2),
      };
    });
    assert.ok(exitPoint, "game viewport is not visible before Bad Apple");
    const demo = await demoButton();
    await browser.execute(() => window.__RUSTYERA_TEST__.resetPerformanceAudit());
    // Return the WebDriver command before the continuously updating animation begins. Starting
    // the fixture is setup; keep the native trusted left click for the exit assertion.
    await browser.execute((button) => {
      window.setTimeout(() => button.click(), 100);
    }, demo);
    await waitForMonitorFrames(120, 10_000);
    const captured = await browser.execute(() => {
      const frame = document.querySelector(".game-line.multiline-text-frame");
      const bounds = frame?.getBoundingClientRect();
      const style = frame instanceof HTMLElement ? getComputedStyle(frame) : undefined;
      return {
        telemetry: window.__RUSTYERA_TEST__.frontendPerformanceAudit(),
        frameVisible:
          frame instanceof HTMLElement &&
          style?.display !== "none" &&
          style?.visibility === "visible" &&
          style?.opacity !== "0" &&
          Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      };
    });
    const telemetry = captured.telemetry;
    const measurement = measureAnimationPerformance(telemetry);
    const publishes = telemetry.timings.filter(
      (sample) => sample.phase === "presentation" && sample.operation === "publish",
    );
    const slowestIntervals = publishes
      .slice(1)
      .map((sample, index) => ({
        intervalMs: sample.startedAtMs - publishes[index].startedAtMs,
        fromRevision: publishes[index].detail?.presentationRevision,
        toRevision: sample.detail?.presentationRevision,
      }))
      .sort((left, right) => right.intervalMs - left.intervalMs)
      .slice(0, 8);
    console.log(
      JSON.stringify({
        type: "tauri-bad-apple-measurement",
        measurement,
        slowestIntervals,
        longTasks: telemetry.longTasks,
      }),
    );
    assert.ok(measurement.frames >= 120, `expected at least 120 frames, got ${measurement.frames}`);
    assert.equal(measurement.revisionStepConstant, true, "animation revisions skipped a frame");
    assert.equal(
      measurement.domSynchronizedFrames,
      measurement.frames,
      "animation frames did not all reach the DOM",
    );
    assert.equal(captured.frameVisible, true, "Bad Apple character frame must be visible");
    console.log(JSON.stringify({ type: "tauri-bad-apple-performance", metrics: measurement }));

    await performViewportLeftClick(exitPoint);
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        if (state?.fault) throw new Error(JSON.stringify(state.fault));
        if (!(state?.phase === "waiting_input" && state.canInteract)) return false;
        const button = await demoButton().catch(() => undefined);
        return Boolean(button && (await button.isDisplayed()));
      },
      { timeout: 30_000, interval: 50, timeoutMsg: "left click did not return to title" },
    );
    const terminal = await snapshot();
    assert.equal(terminal.audioProvider?.["sound:0"]?.state, "stopped");
    assert.equal(terminal.audioProvider?.["sound:0"]?.resourceId, null);
  });
});

async function demoButton() {
  const buttons = await browser.$$("button");
  for (const button of buttons) if ((await button.getText()).trim() === "[2] DEMO") return button;
  throw new Error("[2] DEMO button is not available");
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary());
}

async function waitForMonitorFrames(minimumFrames, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = globalThis.__RUSTYERA_TAURI_MONITOR_OBSERVATION__?.runtime;
    if (runtime?.fault) throw new Error(JSON.stringify(runtime.fault));
    if (runtime?.serviceEvidence?.failure)
      throw new Error(`runtime observation failed: ${runtime.serviceEvidence.failure}`);
    if (runtime?.performanceAudit?.publishedPresentationFrames >= minimumFrames) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Bad Apple did not publish ${minimumFrames} frames`);
}

async function performViewportLeftClick(point) {
  await browser.performActions([
    {
      type: "pointer",
      id: "bad-apple-exit-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x: point.x, y: point.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
}
