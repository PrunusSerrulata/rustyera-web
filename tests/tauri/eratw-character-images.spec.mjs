import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 180_000;
const STEP_TIMEOUT = 30_000;
const eraTwCharacterImages = process.env.VITE_RUSTYERA_TAURI_ERATW_CHARACTER_IMAGES
  ? describe
  : describe.skip;

eraTwCharacterImages("Tauri eraTW clock and character images", () => {
  it("restores save 18, follows Reimu, and renders the clock and portrait", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "eraTW traditional save did not reach its first input",
      totalTimeout: PROJECT_TIMEOUT,
      accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
    });

    await advanceTransientWaitsToInteger(100);
    await submit("100");
    await advanceEnterWaitsUntilLook(500);
    await submit("995");
    await submit("482");
    const route = await advanceIntermediateWaitsUntilMediaSources(2, 100, "0");

    try {
      await browser.waitUntil(
        async () => {
          const metrics = await positionedMetrics();
          return metrics.length === 2 && metrics.every((item) => item.visible && item.loaded);
        },
        { timeout: STEP_TIMEOUT, timeoutMsg: "eraTW clock and character images did not load" },
      );
    } catch (error) {
      const failureState = await snapshot();
      console.error(
        JSON.stringify({
          failureStage: "wait for positioned images",
          error: error instanceof Error ? error.message : String(error),
          bridgeKind: failureState.bridgeKind,
          phase: failureState.phase,
          wait: failureState.wait,
          fault: failureState.fault,
          outputTail: failureState.output.slice(-20),
          metrics: await positionedMetrics(),
          media: await browser.execute(() => window.__RUSTYERA_TEST__.mediaPlacements()),
          viewport: await viewportMetrics(),
        }),
      );
      throw error;
    }

    const state = await snapshot();
    const metrics = await positionedMetrics();
    console.log(
      JSON.stringify({
        bridgeKind: state.bridgeKind,
        phase: state.phase,
        wait: state.wait,
        outputTail: state.output.slice(-20),
        metrics,
      }),
    );
    assert.equal(state.fault, null);
    assert.ok(state.output.some((line) => line.includes("[Look]")));
    assert.ok(state.output.some((line) => line.includes("[霊夢]")));
    assert.ok(route.numericInputs > 0, "the route must accept every encountered character prompt");
    assert.equal(metrics.length, 2, "expected the clock and current character portrait");
    assert.ok(
      metrics.every((item) => item.visible),
      "both positioned visuals must be visible",
    );
    assert.ok(
      metrics.every((item) => item.loaded),
      "both image sources must finish decoding",
    );
    assert.ok(
      metrics.every((item) => item.insideViewport),
      "images must remain inside the viewport",
    );
    assert.ok(
      metrics.every((item) => !item.lineContain.includes("paint")),
      "positioned visuals must not be paint-clipped by their virtual rows",
    );
    assert.ok(
      metrics.some((item) => item.rightGap <= 16),
      "clock must remain at the right edge",
    );
    assert.equal(
      new Set(metrics.map((item) => item.src)).size,
      2,
      "clock and Reimu portrait must use distinct decoded resources",
    );
    assert.ok(
      metrics.some((item) => item.height > item.slotHeight),
      "character visual must extend outside its one-row layout slot",
    );
    assert.ok(
      metrics.every((item) => !item.overlapsPrompt),
      "clock and character portrait must not overlap the input prompt",
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value) {
  const state = await snapshot();
  assert.equal(state.wait?.kind, "integer_value", "numeric input requires an integer wait");
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await waitForWaitChange(state.wait?.wait_id);
}

async function advanceTransientWaitsToInteger(maximum) {
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    const state = await snapshot();
    if (state.wait?.kind === "integer_value") return;
    if (attempt === maximum)
      throw new Error(`integer wait budget exhausted after ${maximum} inputs`);
    assert.ok(
      ["enter_key", "any_key", "void"].includes(state.wait?.kind),
      `save opening reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
    );
    await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
}

async function advanceEnterWaitsUntilLook(maximum) {
  let lastReportAt = Date.now();
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    const state = await snapshot();
    if (state.output.some((line) => line.includes("[Look]"))) return;
    if (attempt === maximum) throw new Error(`Look wait budget exhausted after ${maximum} inputs`);
    assert.ok(
      ["enter_key", "any_key", "void"].includes(state.wait?.kind),
      `opening flow reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
    );
    await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
    if (Date.now() - lastReportAt >= 15_000) {
      console.log(
        JSON.stringify({
          waitingFor: "eraTW [Look] screen",
          attempts: attempt + 1,
          phase: state.phase,
          wait: state.wait,
          outputTail: state.output.slice(-12),
        }),
      );
      lastReportAt = Date.now();
    }
  }
}

async function advanceIntermediateWaitsUntilMediaSources(minimum, maximum, integerValue) {
  let numericInputs = 0;
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    const sourceCount = await distinctMediaSourceCount();
    if (sourceCount >= minimum) return { attempts: attempt, numericInputs, sourceCount };
    if (attempt === maximum)
      throw new Error(`route wait budget exhausted before ${minimum} media sources appeared`);
    const state = await snapshot();
    assert.ok(state.wait, "route progression requires an active input wait");
    if (state.wait.deadline_ns != null) {
      await waitForWaitChange(state.wait.wait_id);
      continue;
    }
    if (state.wait.kind === "integer_value") {
      await submit(integerValue);
      numericInputs += 1;
    } else if (
      ["enter_key", "any_key", "void"].includes(state.wait.kind) ||
      (state.wait.one_input && state.wait.kind === "string_value")
    ) {
      if (state.wait.kind === "string_value") await $(".game-viewport .game-button").click();
      else await $(".prompt-bar button[type=submit]").click();
      await waitForWaitChange(state.wait.wait_id);
    } else {
      throw new Error(`route progression reached unexpected ${state.wait.kind} prompt`);
    }
  }
}

async function distinctMediaSourceCount() {
  const media = await browser.execute(() => window.__RUSTYERA_TEST__.mediaPlacements());
  return new Set(media.images.map((item) => item.source).filter(Boolean)).size;
}

async function waitForWaitChange(waitId) {
  if (waitId == null) return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return (
        state.fault != null ||
        (state.phase === "waiting_input" && state.canInteract && state.wait?.wait_id !== waitId)
      );
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game input did not advance" },
  );
}

async function positionedMetrics() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport")?.getBoundingClientRect();
    const prompt = document.querySelector(".prompt-bar")?.getBoundingClientRect();
    return [...document.querySelectorAll(".media-positioned > .media-visual")].map((visual) => {
      const bounds = visual.getBoundingClientRect();
      const slot = visual.closest(".media-positioned")?.getBoundingClientRect();
      const line = visual.closest(".game-line");
      const image = visual.matches("img") ? visual : visual.querySelector("img");
      return {
        className: visual.className,
        src: image instanceof HTMLImageElement ? image.src : "",
        style: visual.getAttribute("style") ?? "",
        visible: bounds.width > 0 && bounds.height > 0,
        loaded:
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
        naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
        naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        width: bounds.width,
        height: bounds.height,
        slotHeight: slot?.height ?? 0,
        rightGap: viewport ? viewport.right - bounds.right : Infinity,
        insideViewport: Boolean(
          viewport &&
          bounds.left >= viewport.left &&
          bounds.top >= viewport.top &&
          bounds.right <= viewport.right &&
          bounds.bottom <= viewport.bottom,
        ),
        overlapsPrompt: Boolean(
          prompt &&
          bounds.left < prompt.right &&
          bounds.right > prompt.left &&
          bounds.top < prompt.bottom &&
          bounds.bottom > prompt.top,
        ),
        lineContain: line ? getComputedStyle(line).contain : "",
      };
    });
  });
}

async function viewportMetrics() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const history = document.querySelector(".virtual-history");
    return {
      clientHeight: viewport?.clientHeight ?? 0,
      scrollHeight: viewport?.scrollHeight ?? 0,
      scrollTop: viewport?.scrollTop ?? 0,
      historyHeight: history?.getBoundingClientRect().height ?? 0,
      renderedLineCount: document.querySelectorAll(".game-line").length,
      mediaLineCount: document.querySelectorAll(".game-line:has(.media-positioned)").length,
    };
  });
}
