import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// The official runner owns the independent five-second full DOM/runtime watchdog.
const windowResize = process.env.RUSTYERA_LAYOUT_EVIDENCE ? describe : describe.skip;
windowResize("Tauri Snake TW window resize", () => {
  it("keeps title content stationary after native maximization", async () => {
    assert.ok(
      path.isAbsolute(process.env.RUSTYERA_LAYOUT_EVIDENCE),
      "absolute evidence path required",
    );
    const evidence = [];
    const snapshot = () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshotSummary());
    try {
      await browser.waitUntil(async () => Boolean(await snapshot()), {
        timeout: 20_000,
        interval: 50,
      });
      assert.equal((await snapshot()).bridgeKind, "tauri");
      const focusError = await browser.executeAsync((done) => {
        const current = window.__TAURI__.window.getCurrentWindow();
        current
          .show()
          .then(() => current.setFocus())
          .then(
            () => done(null),
            (error) => done(String(error)),
          );
      });
      assert.equal(focusError, null, "native test window could not be focused");
      await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
        timeout: 3_000,
        interval: 50,
      });
      await $(".welcome .primary").click();
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          assert.equal(state?.fault ?? null, null);
          return state?.canInteract && state.wait?.kind === "integer_value";
        },
        { timeout: 300_000, interval: 50, timeoutMsg: "Snake TW title did not become interactive" },
      );
      const titleButton = $("button*=开始游戏");
      assert.ok(await titleButton.isDisplayed(), "Snake TW title start button is not visible");
      const title = await snapshot();
      const targetRect = process.env.RUSTYERA_LAYOUT_WINDOW_RECT;
      if (targetRect) {
        const { x, y, width, height } = JSON.parse(targetRect);
        await browser.setWindowRect(x, y, width, height);
      } else await browser.setWindowSize(2_000, 1_400);
      const beforeRect = await browser.getWindowRect();
      if (targetRect) {
        assert.equal(beforeRect.x < 0, JSON.parse(targetRect).x < 0, "wrong target monitor");
      }
      const before = await sampleLayout(250);
      evidence.push({ stage: "before", rect: beforeRect, samples: before });
      const maximizedRect = await browser.maximizeWindow();
      evidence.push({ stage: "maximize", rect: maximizedRect });
      if (targetRect) {
        assert.equal(maximizedRect.x < 0, beforeRect.x < 0, "maximization changed monitors");
      }
      assert.ok(
        maximizedRect.width !== beforeRect.width || maximizedRect.height !== beforeRect.height,
        "native window dimensions did not change",
      );
      const samples = await sampleLayout(2_000);
      evidence.push({ stage: "after", samples });
      // Exclude the initial native resize animation, but retain it in the evidence.
      const settled = samples.filter((sample) => sample.elapsed >= 1_000);
      assert.ok(settled.length >= 10, "not enough rendered frames to establish stability");
      const reference = settled[0];
      assert.ok(
        reference.width !== before.at(-1)?.width || reference.height !== before.at(-1)?.height,
        "native maximization did not change viewport geometry",
      );
      for (const sample of settled) {
        assert.ok(
          sample.rows.length > 0 && sample.rows.every((row) => row.id),
          "title rows missing",
        );
        assert.equal(sample.width, reference.width, "viewport width did not settle");
        assert.equal(sample.height, reference.height, "viewport height did not settle");
        assert.ok(
          Math.abs(sample.scrollTop - reference.scrollTop) <= 1,
          "scroll position oscillated",
        );
        assert.deepEqual(sample.rows, reference.rows, "title row geometry oscillated");
        assert.deepEqual(sample.layers, reference.layers, "title visual layer geometry oscillated");
      }
      const after = await snapshot();
      assert.equal(after.fault, null);
      assert.equal(
        after.wait?.wait_id,
        title.wait.wait_id,
        "title input wait changed during sampling",
      );
      assert.ok(await $("button*=开始游戏").isDisplayed(), "title start button disappeared");
    } finally {
      await writeFile(process.env.RUSTYERA_LAYOUT_EVIDENCE, JSON.stringify(evidence));
    }
  });
});

async function sampleLayout(duration) {
  return browser.executeAsync((duration, done) => {
    const started = performance.now();
    const samples = [];
    const sample = () => {
      const viewport = document.querySelector(".game-viewport");
      const history = viewport?.querySelector(".virtual-history");
      if (!viewport || !history) return done([]);
      samples.push({
        elapsed: performance.now() - started,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        historyHeight: history.getBoundingClientRect().height,
        dpr: devicePixelRatio,
        screen: { width: screen.width, height: screen.height, x: screenX, y: screenY },
        rows: [...history.querySelectorAll(":scope > .game-line")].map((row) => {
          const rect = row.getBoundingClientRect();
          return { id: row.dataset.lineId, top: rect.top, height: rect.height };
        }),
        layers: [...viewport.querySelectorAll(".scene-layer, .html-island *, .media-image")].map(
          (layer) => {
            const rect = layer.getBoundingClientRect();
            return {
              tag: layer.tagName,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            };
          },
        ),
      });
      if (performance.now() - started >= duration) done(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, duration);
}
