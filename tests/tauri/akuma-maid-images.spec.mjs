import assert from "node:assert/strict";

import { establishReferenceWindow, paintedImageBounds } from "./media-geometry.mjs";
import { driveRuntimeUntil } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const PORTRAIT_TIMEOUT = 60_000;
const akumaMaidImages = process.env.VITE_RUSTYERA_TAURI_AKUMA_MAID_IMAGES
  ? describe
  : describe.skip;

akumaMaidImages("Tauri eraAkumaMaid image rendering", () => {
  it("renders the positioned title and the generated maid portrait", async () => {
    let stage = "install test control";
    let title;
    try {
      // The project's configured 16px font makes the title art 576px tall. Establish the
      // reference client area after the project has applied its window config.
      await browser.waitUntil(async () => Boolean(await snapshot()), {
        timeout: 20_000,
        timeoutMsg: "test control was not installed in the Tauri WebView",
      });
      assert.equal((await snapshot()).bridgeKind, "tauri");

      stage = "open eraAkumaMaid";
      await $(".welcome .primary").click();
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
        },
        {
          timeout: PROJECT_TIMEOUT,
          timeoutMsg: "eraAkumaMaid did not reach its title input",
        },
      );
      // Project configuration intentionally restores its own window size while
      // loading, so establish the reference observation window afterwards.
      await establishReferenceWindow(1120, 1010);
      await $(".media-positioned .media-sprite img").waitForDisplayed({
        timeout: STEP_TIMEOUT,
      });

      stage = "verify title image";
      title = await titleMetrics();
      assert.equal(title.spacerWidth, 576);
      assert.equal(title.imageHeight, 576);
      assert.equal(title.imageTop, -528);
      // The negative ypos intentionally crops the 36em asset to its bottom 3em title strip.
      assert.ok(title.imageViewportBottom > 0, "the cropped title strip must remain visible");
      assert.ok(
        title.imageViewportBottom <= title.viewportHeight + 0.5,
        "title image must not be clipped below the viewport",
      );
      assert.ok(
        title.dividerGap >= -0.5 && title.dividerGap <= 12,
        "title image must be bottom-aligned to the following divider without overlapping it",
      );
      assert.ok(title.textGap >= -0.5, "title image must not overlap the following title text");
      await reportProgress(stage);

      const inputs = [0, 0, 0, 100, 100, 100, 100, 0];
      for (const [index, value] of inputs.entries()) {
        stage = `submit initialization input ${index + 1}/${inputs.length}: ${value}`;
        await submit(value, index === inputs.length - 1 ? "enter_key" : "integer_value");
        await reportProgress(stage);
      }

      stage = "advance opening messages";
      for (let attempts = 0; attempts < 48; attempts += 1) {
        const state = await snapshot();
        if (state.output?.some((line) => line.includes("弗理希艾尔"))) break;
        assert.ok(
          ["enter_key", "void"].includes(state.wait?.kind),
          `opening flow reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
        );
        const waitId = state.wait.wait_id;
        await $(".prompt-bar button[type=submit]").click();
        await browser.waitUntil(
          async () => {
            const current = await snapshot();
            return (
              current.wait?.wait_id !== waitId ||
              current.output?.some((line) => line.includes("弗理希艾尔"))
            );
          },
          { timeout: STEP_TIMEOUT, timeoutMsg: "timed opening wait did not advance" },
        );
        await reportProgress(`${stage}: ${state.wait.kind} ${attempts + 1}`);
      }

      stage = "wait for generated maid portrait";
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          if (!state?.output?.some((line) => line.includes("弗理希艾尔"))) return false;
          const portrait = await portraitMetrics();
          return portrait.count > 0 && portrait.loaded === portrait.count;
        },
        {
          timeout: PORTRAIT_TIMEOUT,
          timeoutMsg: "generated maid portrait did not become visible",
        },
      );

      const state = await snapshot();
      const portrait = await portraitMetrics();
      console.log(
        JSON.stringify({
          project: process.env.VITE_RUSTYERA_TEST_PROJECT,
          bridgeKind: state.bridgeKind,
          phase: state.phase,
          wait: state.wait,
          outputTail: state.output.slice(-12),
          title,
          portrait,
        }),
      );
      assert.equal(state.bridgeKind, "tauri");
      assert.equal(state.fault, null);
      assert.equal(portrait.count, 10);
      assert.equal(portrait.loaded, portrait.count);
      assert.ok(portrait.width > 0 && portrait.height > portrait.slotHeight);
      assert.ok(portrait.positionedLayerCount >= portrait.count - 1);
      assert.ok(portrait.leftSpread < 1, "portrait layers must share one horizontal origin");
      assert.ok(portrait.topSpread < 1, "portrait layers must share one vertical origin");

      stage = "submit the character name and skip to the room";
      await browser.waitUntil(async () => (await snapshot()).wait?.kind === "string_value", {
        timeout: STEP_TIMEOUT,
        timeoutMsg: "character customization did not reach its string prompt",
      });
      await submitString("0");
      await advanceOpeningToRoom(480);

      stage = "verify room image composition";
      await browser.waitUntil(async () => (await roomMetrics()).nontransparentPixels >= 100, {
        timeout: PORTRAIT_TIMEOUT,
        timeoutMsg: "generated portrait canvas did not finish rendering",
      });
      const room = await roomMetrics();
      console.log(JSON.stringify({ stage, room }));
      assert.equal(room.canvasCount, 1);
      assert.ok(room.nontransparentPixels >= 100, "generated portrait canvas must contain pixels");
      assert.equal(room.sexSymbolCount, 2);
      assert.equal(room.clothingLayerCount, 6);
      assert.ok(room.clothingLeftSpread < 1, "clothing layers must share one horizontal origin");
      assert.ok(room.clothingTopSpread < 1, "clothing layers must share one vertical origin");
      assert.ok(room.portraitGap >= 0, "generated portrait must not cover character commands");
      assert.ok(room.clothingGap >= 0, "clothing layers must not cover character commands");
    } catch (error) {
      const state = await snapshot().catch(() => null);
      const portrait = await portraitMetrics().catch(() => null);
      console.error(
        JSON.stringify({
          failureStage: stage,
          error: error instanceof Error ? error.message : String(error),
          bridgeKind: state?.bridgeKind,
          phase: state?.phase,
          wait: state?.wait,
          fault: state?.fault,
          outputTail: state?.output?.slice(-12),
          title,
          portrait,
        }),
      );
      throw error;
    }
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value, nextWaitKind) {
  const initial = await snapshot();
  assert.equal(initial.wait?.kind, "integer_value", `input ${value} requires an integer prompt`);
  const before = initial.wait.wait_id;
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await browser.waitUntil(
    async () => {
      const current = await snapshot();
      return (
        current?.phase === "waiting_input" &&
        current.canInteract &&
        current.wait?.wait_id !== before &&
        current.wait?.kind === nextWaitKind
      );
    },
    {
      timeout: STEP_TIMEOUT,
      timeoutMsg: `input ${value} did not reach the next ${nextWaitKind} prompt`,
    },
  );
}

async function submitString(value) {
  const initial = await snapshot();
  assert.equal(initial.wait?.kind, "string_value");
  const before = initial.wait.wait_id;
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await browser.waitUntil(
    async () => {
      const current = await snapshot();
      return current.wait?.wait_id !== before && current.wait?.kind === "enter_key";
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "character name did not reach the opening message" },
  );
}

async function advanceOpeningToRoom(maximum) {
  let submitted = 0;
  await driveRuntimeUntil({
    browser,
    snapshot,
    label: "maid room portrait",
    totalTimeout: 180_000,
    pollInterval: 100,
    accept: async (state) =>
      state.output.some((line) => line.includes("你的房間")) &&
      (await $(".canvas-replay").isDisplayed()),
    advance: async (state) => {
      if (state.phase === "running" || state.wait == null || state.wait.deadline_ns != null)
        return false;
      assert.ok(
        ["enter_key", "void"].includes(state.wait.kind),
        `opening flow reached unexpected ${state.wait.kind} prompt`,
      );
      if (submitted === maximum)
        throw new Error(`maid room was not visible after ${maximum} Enter waits`);
      const waitId = state.wait.wait_id;
      await $(".prompt-bar button[type=submit]").click();
      submitted += 1;
      await browser.waitUntil(async () => (await snapshot()).wait?.wait_id !== waitId, {
        timeout: STEP_TIMEOUT,
        timeoutMsg: "opening Enter wait did not advance",
      });
      return true;
    },
  });
}

async function reportProgress(stage) {
  const state = await snapshot();
  console.log(
    JSON.stringify({
      stage,
      phase: state?.phase,
      wait: state?.wait,
      fault: state?.fault,
      outputTail: state?.output?.slice(-4),
    }),
  );
}

async function titleMetrics() {
  const paintedBounds = await paintedImageBounds(
    ".media-positioned .media-sprite img",
    ".media-positioned .media-sprite",
  );
  return browser.execute((paintedBounds) => {
    const spacer = document.querySelector(".html-shape-space");
    const image = document.querySelector(".media-positioned .media-sprite");
    const viewport = document.querySelector(".game-viewport");
    const imageBounds = image?.getBoundingClientRect();
    const viewportBounds = viewport?.getBoundingClientRect();
    const imageLineIndex = Number(image?.closest(".game-line")?.getAttribute("data-index"));
    const laterLines = [...document.querySelectorAll(".game-line")].filter(
      (line) => Number(line.getAttribute("data-index")) > imageLineIndex,
    );
    const dividerBounds = laterLines
      .map((line) => line.querySelector(".separator")?.getBoundingClientRect())
      .find(Boolean);
    const textBounds = laterLines
      .filter((line) => !line.querySelector(".separator"))
      .find((line) => line.textContent?.trim())
      ?.getBoundingClientRect();
    return {
      spacerWidth: spacer?.getBoundingClientRect().width ?? 0,
      imageHeight: image?.getBoundingClientRect().height ?? 0,
      imageTop: Number.parseFloat(getComputedStyle(image).top) || 0,
      paintedBounds,
      viewportHeight: viewportBounds?.height ?? 0,
      scrollTop: viewport?.scrollTop ?? 0,
      scrollHeight: viewport?.scrollHeight ?? 0,
      imageViewportTop:
        paintedBounds && viewportBounds
          ? paintedBounds.top - viewportBounds.top
          : Number.NEGATIVE_INFINITY,
      imageViewportBottom:
        paintedBounds && viewportBounds
          ? paintedBounds.bottom - viewportBounds.top
          : Number.POSITIVE_INFINITY,
      imageContentTop:
        paintedBounds && viewportBounds
          ? paintedBounds.top - viewportBounds.top + (viewport?.scrollTop ?? 0)
          : Number.NEGATIVE_INFINITY,
      imageContentBottom:
        paintedBounds && viewportBounds
          ? paintedBounds.bottom - viewportBounds.top + (viewport?.scrollTop ?? 0)
          : Number.POSITIVE_INFINITY,
      dividerGap:
        imageBounds && dividerBounds
          ? dividerBounds.top - imageBounds.bottom
          : Number.NEGATIVE_INFINITY,
      textGap:
        imageBounds && textBounds ? textBounds.top - imageBounds.bottom : Number.NEGATIVE_INFINITY,
    };
  }, paintedBounds);
}

async function portraitMetrics() {
  return browser.execute(() => {
    const layers = [...document.querySelectorAll(".html-node .media-positioned .media-sprite img")];
    const image = layers[0];
    const visual = image?.parentElement;
    const slot = visual?.parentElement;
    const bounds = layers.map((layer) => layer.parentElement?.getBoundingClientRect());
    const lefts = bounds.flatMap((item) => (item ? [item.left] : []));
    const tops = bounds.flatMap((item) => (item ? [item.top] : []));
    return {
      count: layers.length,
      loaded: layers.filter((layer) => layer.complete && layer.naturalWidth > 0).length,
      width: visual?.getBoundingClientRect().width ?? 0,
      height: visual?.getBoundingClientRect().height ?? 0,
      slotHeight: slot?.getBoundingClientRect().height ?? 0,
      top: visual ? Number.parseFloat(getComputedStyle(visual).top) || 0 : 0,
      positionedLayerCount: layers.filter((layer) => layer.closest(".html-node-positioned")).length,
      leftSpread: lefts.length ? Math.max(...lefts) - Math.min(...lefts) : Number.POSITIVE_INFINITY,
      topSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : Number.POSITIVE_INFINITY,
    };
  });
}

async function roomMetrics() {
  return browser.execute(() => {
    const canvas = document.querySelector(".canvas-replay");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
    let nontransparentPixels = 0;
    for (let index = 3; index < pixels.length; index += 4)
      if (pixels[index] !== 0) nontransparentPixels += 1;

    const portrait = canvas?.closest(".media-visual")?.getBoundingClientRect();
    const clothing = [
      ...document.querySelectorAll(
        ".game-line:has(.html-node-positioned:nth-child(6)) .media-visual.media-sprite",
      ),
    ];
    const clothingBounds = clothing.map((layer) => layer.getBoundingClientRect());
    const target = [...document.querySelectorAll(".game-button")].find((button) =>
      button.textContent?.startsWith("[1]弗理希艾尔"),
    );
    const targetBounds = target?.getBoundingClientRect();
    const lefts = clothingBounds.map((bounds) => bounds.left);
    const tops = clothingBounds.map((bounds) => bounds.top);
    return {
      canvasCount: canvas ? 1 : 0,
      nontransparentPixels,
      sexSymbolCount: document.querySelectorAll(
        ".game-line:has(> .game-button) > .media-positioned > .media-visual.media-sprite",
      ).length,
      clothingLayerCount: clothing.length,
      clothingLeftSpread: lefts.length
        ? Math.max(...lefts) - Math.min(...lefts)
        : Number.POSITIVE_INFINITY,
      clothingTopSpread: tops.length
        ? Math.max(...tops) - Math.min(...tops)
        : Number.POSITIVE_INFINITY,
      portraitGap: portrait && targetBounds ? targetBounds.top - portrait.bottom : -Infinity,
      clothingGap:
        clothingBounds.length && targetBounds
          ? targetBounds.top - Math.max(...clothingBounds.map((bounds) => bounds.bottom))
          : -Infinity,
    };
  });
}
