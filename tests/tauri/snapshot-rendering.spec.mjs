import assert from "node:assert/strict";

const SNAPSHOT_TIMEOUT = 300_000;
const snapshotRendering = process.env.VITE_RUSTYERA_TEST_STATE ? describe : describe.skip;

snapshotRendering("Tauri runtime snapshot rendering", () => {
  it("restores positioned images without clipping and follows output to the bottom", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
      },
      {
        timeout: SNAPSHOT_TIMEOUT,
        timeoutMsg: "configured runtime snapshot did not reach an input wait",
      },
    );

    const viewport = await $(".game-viewport");
    const initial = await snapshot();
    if (initial.wait?.kind === "enter_key") await viewport.click({ button: "right" });

    await browser.waitUntil(
      async () => (await snapshot())?.output?.some((line) => line.includes("[Look]")),
      {
        timeout: SNAPSHOT_TIMEOUT,
        timeoutMsg: "continuous Enter skipping did not reach the self-home scene",
      },
    );

    const state = await snapshot();
    const metrics = await positionedImageMetrics();
    assert.equal(state.bridgeKind, "tauri");
    assert.equal(state.fault, null);
    assert.ok(metrics.positioned.length >= 2, "expected the clock and character visuals");
    assert.ok(
      metrics.positioned.every((item) => !item.lineContain.includes("paint")),
      "positioned images must not be paint-clipped by their virtual rows",
    );
    assert.ok(
      metrics.positioned.some(
        (item) => item.loaded && item.visualHeight > item.slotHeight && item.top > 0,
      ),
      "expected a loaded ypos visual to extend below its one-row layout slot",
    );
    assert.ok(metrics.bottomGap <= 1, `viewport remained ${metrics.bottomGap}px above the bottom`);
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        state: process.env.VITE_RUSTYERA_TEST_STATE,
        bridgeKind: state.bridgeKind,
        phase: state.phase,
        wait: state.wait,
        outputTail: state.output.slice(-12),
        metrics,
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function positionedImageMetrics() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const positioned = [...document.querySelectorAll(".media-positioned")].map((slot) => {
      const visual = slot.querySelector(".media-visual");
      const image = visual?.matches("img") ? visual : visual?.querySelector("img");
      const line = slot.closest(".game-line");
      return {
        slotHeight: slot.getBoundingClientRect().height,
        visualHeight: visual?.getBoundingClientRect().height ?? 0,
        top: Number.parseFloat(getComputedStyle(visual ?? slot).top) || 0,
        lineContain: line ? getComputedStyle(line).contain : "",
        loaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      };
    });
    return {
      bottomGap:
        viewport instanceof HTMLElement
          ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          : Number.POSITIVE_INFINITY,
      positioned,
    };
  });
}
