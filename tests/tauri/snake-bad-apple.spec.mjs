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
        clock: null,
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
    await browser.waitUntil(
      async () => (await snapshot())?.audioProvider?.["sound:0"]?.positionMs >= 17_000,
      {
        timeout: 25_000,
        interval: 50,
        timeoutMsg: "Bad Apple did not remain observable through 17 seconds of audio playback",
      },
    );
    const captured = await browser.execute(() => {
      const frame = document.querySelector(".game-line.multiline-text-frame");
      const bounds = frame?.getBoundingClientRect();
      const style = frame instanceof HTMLElement ? getComputedStyle(frame) : undefined;
      const summary = window.__RUSTYERA_TEST__.snapshotSummary();
      return {
        telemetry: window.__RUSTYERA_TEST__.frontendPerformanceAudit(),
        audioPositionMs: summary.audioProvider?.["sound:0"]?.positionMs,
        audioState: summary.audioProvider?.["sound:0"]?.state,
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
    assert.ok(
      captured.audioPositionMs >= 17_000,
      `expected at least 17 seconds of Bad Apple playback, got ${captured.audioPositionMs} ms`,
    );
    assert.ok(measurement.frames >= 450, `expected at least 450 frames, got ${measurement.frames}`);
    assert.equal(captured.audioState, "playing", "Bad Apple audio must play during the animation");
    assert.ok(
      Number.isFinite(captured.audioPositionMs) && captured.audioPositionMs > 0,
      `Bad Apple audio position was invalid: ${captured.audioPositionMs}`,
    );
    const audioMillisecondsPerFrame =
      captured.audioPositionMs / Math.max(1, measurement.frames - 1);
    assert.ok(
      audioMillisecondsPerFrame >= 28 && audioMillisecondsPerFrame <= 40,
      `animation cadence diverged from the 33 ms script timeline: ${audioMillisecondsPerFrame} ms/frame`,
    );
    assert.equal(measurement.revisionStepConstant, true, "animation revisions skipped a frame");
    assert.equal(
      measurement.domSynchronizedFrames,
      measurement.frames,
      "animation frames did not all reach the DOM",
    );
    assert.equal(captured.frameVisible, true, "Bad Apple character frame must be visible");
    console.log(
      JSON.stringify({
        type: "tauri-bad-apple-performance",
        metrics: measurement,
        audioPositionMs: captured.audioPositionMs,
        audioMillisecondsPerFrame,
      }),
    );

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
