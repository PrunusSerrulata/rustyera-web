/* global document, window, requestAnimationFrame */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// Called inside the official native-browser runner's full DOM/runtime watchdog.
export async function checkViewportResize(browser) {
  const output = process.env.RUSTYERA_LAYOUT_EVIDENCE;
  assert.ok(output && path.isAbsolute(output), "absolute layout evidence path required");
  const evidence = [];
  try {
    for (const [width, height] of [
      [1000, 700],
      [1300, 850],
    ]) {
      await browser.setWindowSize(width, height);
      const samples = await browser.executeAsync((done) => {
        const started = performance.now();
        const frames = [];
        const sample = () => {
          const viewport = document.querySelector(".game-viewport");
          const history = document.querySelector(".virtual-history");
          const compositor = document.querySelector(".scene-compositor");
          if (!viewport || !history || !compositor) return done([]);
          const box = (element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          };
          frames.push({
            elapsed: performance.now() - started,
            viewport: box(viewport),
            history: box(history),
            compositor: box(compositor),
            scrollTop: viewport.scrollTop,
            rows: [...history.querySelectorAll(":scope > .game-line")].map(box),
          });
          if (performance.now() - started >= 700) done(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      evidence.push({ width, height, samples });
      const settled = samples.filter((frame) => frame.elapsed >= 300);
      assert.ok(settled.length >= 5, "insufficient rendered layout samples");
      const first = settled[0];
      assert.ok(first.rows.length > 0, "no rendered game rows");
      for (const frame of settled) {
        assert.ok(Math.abs(frame.history.bottom - frame.compositor.bottom) <= 1);
        assert.deepEqual(frame.viewport, first.viewport, "viewport geometry oscillated");
        assert.deepEqual(frame.rows, first.rows, "game row geometry oscillated");
        assert.equal(frame.scrollTop, first.scrollTop, "scroll position oscillated");
      }
      const state = await browser.execute(() => window.__RUSTYERA_TEST__.snapshot());
      assert.equal(state.bridgeKind, "browser");
      assert.equal(state.fault, null);
      assert.ok(state.canInteract, "game lost its input wait");
    }
    assert.notDeepEqual(
      evidence[0].samples.at(-1).viewport,
      evidence[1].samples.at(-1).viewport,
      "native browser window resize did not change the viewport",
    );
  } finally {
    await writeFile(output, JSON.stringify(evidence));
  }
}
