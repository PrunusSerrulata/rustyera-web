import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_ERAFL_SAVE_LOAD_SHAPES === "1" ? describe : describe.skip;

enabled("Tauri eraFL save/load shape rendering", () => {
  it("renders COLOR_LINE as two thin three-segment rules", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    const title = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "eraFL did not reach its title input",
      accept: (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        state.wait?.kind === "integer_value",
    });
    assert.equal(title.bridgeKind, "tauri");

    const input = await $(".prompt-bar input");
    await input.setValue("1");
    await $(".prompt-bar button[type=submit]").click();
    const saveLoad = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "eraFL did not reach its save/load input",
      accept: (state) =>
        state?.phase === "waiting_input" &&
        state.canInteract &&
        state.wait?.kind === "string_value" &&
        state.output?.some((line) => line.includes("Page1/10")) &&
        state.output?.some((line) => line.includes("[1003]")) &&
        state.output?.some((line) => line.includes("[9999]")),
    });
    assert.equal(saveLoad.bridgeKind, "tauri");
    assert.equal(saveLoad.fault, null);

    const metrics = await colorLineMetrics();
    assert.equal(metrics.rows.length, 2, "save/load view must contain two visible COLOR_LINE rows");
    assert.equal(metrics.unsupportedShapes, 0, "valid PRINT_RECT runs must not use a fallback");
    for (const [index, row] of metrics.rows.entries()) {
      assert.equal(row.slotWidths.length, 3, `COLOR_LINE row ${index} must have three segments`);
      assert.deepEqual(row.slotWidths, [992, 16, 16]);
      assert.ok(Math.abs(row.totalWidth - 1024) <= 0.1, `unexpected row width ${row.totalWidth}`);
      assert.ok(row.slotHeights.every((height) => Math.abs(height - 16) <= 0.1));
      assert.ok(row.visualHeights.every((height) => Math.abs(height - 1.6) <= 0.1));
      assert.ok(row.visualTopOffsets.every((top) => Math.abs(top - 7.2) <= 0.1));
      assert.ok(
        row.slotGaps.every((gap) => Math.abs(gap) <= 0.1),
        "segments are not contiguous",
      );
      assert.ok(
        row.borderWidths.every((width) => width === "0px"),
        "shape has a border",
      );
      assert.deepEqual(row.colors, ["rgb(30, 30, 30)", "rgb(30, 30, 30)", "rgb(17, 17, 17)"]);
    }

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: saveLoad.bridgeKind,
        wait: saveLoad.wait,
        outputTail: saveLoad.output.slice(-12),
        colorLineMetrics: metrics,
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function colorLineMetrics() {
  return browser.execute(() => {
    const rows = [...document.querySelectorAll(".game-line")]
      .filter((line) => line.querySelector(":scope > .shape.shape-rect[data-shape='rect']"))
      .map((line) => {
        const lineBox = line.getBoundingClientRect();
        const slots = [...line.querySelectorAll(":scope > .shape.shape-rect[data-shape='rect']")];
        const slotBoxes = slots.map((slot) => slot.getBoundingClientRect());
        const visuals = slots.map((slot) => slot.querySelector(":scope > .shape-rect-visual"));
        const visualBoxes = visuals.map((visual) => visual.getBoundingClientRect());
        return {
          slotWidths: slotBoxes.map((box) => box.width),
          slotHeights: slotBoxes.map((box) => box.height),
          totalWidth: slotBoxes.at(-1).right - slotBoxes[0].left,
          slotGaps: slotBoxes.slice(1).map((box, index) => box.left - slotBoxes[index].right),
          visualHeights: visualBoxes.map((box) => box.height),
          visualTopOffsets: visualBoxes.map((box) => box.top - lineBox.top),
          borderWidths: slots.map((slot) => getComputedStyle(slot).borderTopWidth),
          colors: visuals.map((visual) => getComputedStyle(visual).backgroundColor),
        };
      });
    return {
      rows,
      unsupportedShapes: document.querySelectorAll(".shape.shape-unsupported").length,
    };
  });
}
