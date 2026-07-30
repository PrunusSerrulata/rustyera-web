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
    const columns = await commandColumnMetrics();
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        state: process.env.VITE_RUSTYERA_TEST_STATE,
        bridgeKind: state.bridgeKind,
        phase: state.phase,
        wait: state.wait,
        outputTail: state.output.slice(-12),
        metrics,
        columns,
      }),
    );
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
    assert.ok(
      metrics.clickable.some(
        (item) => item.visualHeight > item.buttonHeight && item.lowerVisualHitsButton,
      ),
      "expected a positioned image to remain clickable below its one-row button box",
    );
    assert.ok(columns, "expected the [400] movement command in a responsive column group");
    assert.ok(columns.cellCount > columns.columns, "expected the command group to wrap into rows");
    assert.ok(
      columns.groupRight <= columns.viewportRight + 1,
      "responsive command columns exceeded the viewport",
    );
    assert.ok(metrics.bottomGap <= 1, `viewport remained ${metrics.bottomGap}px above the bottom`);
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
    const clickable = [...document.querySelectorAll("button .media-positioned")].map((slot) => {
      const visual = slot.querySelector(".media-visual");
      const button = slot.closest("button");
      const visualRect = visual?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      const viewportRect = viewport?.getBoundingClientRect();
      let lowerVisualHitsButton = false;
      if (visualRect && button && viewportRect) {
        const x = Math.max(
          viewportRect.left + 1,
          Math.min(viewportRect.right - 1, visualRect.left + visualRect.width / 2),
        );
        const y = Math.max(
          viewportRect.top + 1,
          Math.min(viewportRect.bottom - 1, visualRect.bottom - 1),
        );
        const hit = document.elementFromPoint(x, y);
        lowerVisualHitsButton = button.contains(hit);
        return {
          buttonHeight: buttonRect?.height ?? 0,
          buttonClass: button.className,
          visualHeight: visualRect?.height ?? 0,
          lowerVisualHitsButton,
          point: { x, y },
          hit: hit
            ? {
                tag: hit.tagName,
                className: hit.className,
                text: hit.textContent?.slice(0, 80),
              }
            : null,
        };
      }
      return {
        buttonHeight: buttonRect?.height ?? 0,
        buttonClass: button?.className ?? null,
        visualHeight: visualRect?.height ?? 0,
        lowerVisualHitsButton,
        point: null,
        hit: null,
      };
    });
    return {
      bottomGap:
        viewport instanceof HTMLElement
          ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          : Number.POSITIVE_INFINITY,
      positioned,
      clickable,
    };
  });
}

async function commandColumnMetrics() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const button = [...document.querySelectorAll(".column-group .game-button")].find((candidate) =>
      candidate.textContent?.includes("[400]"),
    );
    const group = button?.closest(".column-group");
    if (!viewport || !group) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const groupRect = group.getBoundingClientRect();
    return {
      cellCount: group.querySelectorAll(":scope > .column-cell").length,
      columns: getComputedStyle(group).gridTemplateColumns.split(" ").length,
      groupRight: groupRect.right,
      viewportRight: viewportRect.right,
    };
  });
}
