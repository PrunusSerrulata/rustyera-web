import assert from "node:assert/strict";

import { establishReferenceWindow, paintedImageBounds } from "./media-geometry.mjs";
import { driveRuntimeUntil, waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const roronaImages = process.env.VITE_RUSTYERA_TAURI_RORONA_IMAGES ? describe : describe.skip;

roronaImages("Tauri erarorona image rendering", () => {
  it("keeps the title and workshop image between their surrounding text", async () => {
    let automaticTimedWaits = 0;
    // Establish the reference client area after the project has applied its
    // window configuration.
    await waitForProject();
    await establishReferenceWindow(1400, 1050);
    automaticTimedWaits += await reachTitle(20);

    let title;
    try {
      await browser.waitUntil(
        async () => {
          title = await titleMetrics();
          return title.count === 1 && title.insideViewport && title.metadataGap >= 0;
        },
        { timeout: STEP_TIMEOUT, timeoutMsg: "title image geometry did not stabilize" },
      );
    } catch (error) {
      const failureState = await snapshot();
      console.error(
        JSON.stringify({
          failureStage: "title geometry",
          title,
          phase: failureState.phase,
          wait: failureState.wait,
          fault: failureState.fault,
          outputTail: failureState.output.slice(-30),
          media: await visibleMedia(),
        }),
      );
      throw error;
    }
    assert.equal(title.count, 1);
    assert.ok(title.insideViewport, "title image must remain fully inside the viewport");
    assert.ok(title.metadataGap >= 0, "title image must not cover its metadata");

    await submit(0);
    await skipOpeningWithRightClick();

    let workshop;
    await browser.waitUntil(
      async () => {
        workshop = await workshopMetrics();
        return workshop.count === 1 && workshop.statusGap >= 0 && workshop.dialogueGap >= 0;
      },
      { timeout: STEP_TIMEOUT, timeoutMsg: "workshop image geometry did not stabilize" },
    );
    const state = await snapshot();
    console.log(JSON.stringify({ title, workshop, wait: state.wait, fault: state.fault }));
    assert.equal(state.fault, null);
    assert.equal(workshop.count, 1);
    assert.ok(workshop.statusGap >= 0, "workshop image must start below the status header");
    assert.ok(workshop.dialogueGap >= 0, "workshop image must end above the dialogue");

    automaticTimedWaits += await advanceEnterWaitsUntil("师傅还没回来啊", 1600);
    const firstDialogue = await dialoguePortraitMetrics();
    assertDialoguePortraits(firstDialogue, 1);

    automaticTimedWaits += await advanceEnterWaitsUntil("抱歉，请问您是", 400);
    const secondDialogue = await dialoguePortraitMetrics();
    assertDialoguePortraits(secondDialogue, 2);
    assert.ok(
      automaticTimedWaits > 0,
      "opening fades and dialogue typewriter frames must advance without clicking",
    );
    console.log(JSON.stringify({ firstDialogue, secondDialogue, automaticTimedWaits }));
  });
});

async function waitForProject() {
  await browser.waitUntil(async () => Boolean(await snapshot()), {
    timeout: 20_000,
    timeoutMsg: "test control was not installed in the Tauri WebView",
  });
  assert.equal((await snapshot()).bridgeKind, "tauri");
  await $(".welcome .primary").click();
  await waitForRuntimeProgress({
    browser,
    snapshot,
    label: "erarorona did not reach its first input",
    totalTimeout: PROJECT_TIMEOUT,
    accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
  });
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value, requireStable = false) {
  const before = await snapshot();
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await waitForWaitChange(before.wait?.wait_id, requireStable);
}

async function reachTitle(maximum) {
  let automaticTimedWaits = 0;
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const state = await snapshot();
    const tail = state.output.slice(-80).join("\n");
    if (
      tail.includes("era萝乐娜") &&
      tail.includes("[0] 新的游戏") &&
      state.wait?.kind === "integer_value" &&
      state.wait?.stability === "stable_input"
    )
      return automaticTimedWaits;
    if (state.wait?.deadline_ns != null) {
      automaticTimedWaits += 1;
      await waitForWaitChange(state.wait.wait_id);
      continue;
    }
    const value = tail.includes("我已阅读须知并同意")
      ? 0
      : tail.includes("是否要开启声音")
        ? 0
        : tail.includes("[999] 设置完毕")
          ? 999
          : tail.includes("[9] 关闭信息")
            ? 9
            : undefined;
    assert.notEqual(value, undefined, `unexpected pre-title prompt: ${state.wait?.kind}`);
    await submit(value, true);
  }
  throw new Error(`title was not reached after ${maximum} state-driven setup inputs`);
}

async function skipOpeningWithRightClick() {
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state.fault != null || (state.canInteract && state.wait?.kind === "enter_key");
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "new-game opening did not expose an Enter wait" },
  );
  await $(".game-viewport").click({ button: "right" });
  await driveRuntimeUntil({
    browser,
    snapshot,
    label: "Rorona dialogue and workshop background after right-click skip",
    totalTimeout: 180_000,
    pollInterval: 100,
    accept: async (state) => {
      const workshop = await workshopMetrics();
      return (
        workshop.count === 1 &&
        workshop.statusGap >= 0 &&
        workshop.dialogueGap >= 0 &&
        state.output.slice(-60).join("\n").includes("亚斯特丽德的工房")
      );
    },
  });
}

async function advanceEnterWaitsUntil(expectedText, maximum, requireImage = false) {
  let automaticTimedWaits = 0;
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    const state = await snapshot();
    const textReached = state.output.slice(-60).join("\n").includes(expectedText);
    const imageReached =
      !requireImage || (await $(".media-visual.media-sprite").isDisplayed()).valueOf();
    if (textReached && imageReached && state.wait?.deadline_ns == null) return automaticTimedWaits;
    if (!state.wait) {
      await waitForNextWait();
      continue;
    }
    if (state.wait?.deadline_ns != null) {
      automaticTimedWaits += 1;
      await waitForWaitChange(state.wait.wait_id);
      continue;
    }
    assert.ok(
      ["enter_key", "any_key", "void"].includes(state.wait?.kind) ||
        (state.wait?.one_input && state.wait?.kind === "string_value"),
      `opening flow reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
    );
    if (state.wait.kind === "string_value") await $(".game-viewport .game-button").click();
    else await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
  throw new Error(`${expectedText} was not visible after ${maximum} Enter waits`);
}

async function waitForNextWait() {
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state.fault != null || (state.phase === "waiting_input" && state.wait != null);
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game did not expose its next input wait" },
  );
}

async function waitForWaitChange(waitId, requireStable = false) {
  if (waitId == null) return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return (
        state.fault != null ||
        (state.phase === "waiting_input" &&
          state.canInteract &&
          state.wait?.wait_id !== waitId &&
          (!requireStable || state.wait?.stability === "stable_input"))
      );
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game input did not advance" },
  );
}

async function titleMetrics() {
  const paintedBounds = await paintedImageBounds(
    ".media-visual.media-sprite img",
    ".media-visual.media-sprite",
  );
  return browser.execute((paintedBounds) => {
    const image = document.querySelector(".media-visual.media-sprite");
    const viewport = document.querySelector(".game-viewport");
    const metadata = [...document.querySelectorAll(".game-line")].find(
      (line) => line.textContent?.trim() === "era萝乐娜",
    );
    const bounds = image?.getBoundingClientRect();
    const viewportBounds = viewport?.getBoundingClientRect();
    const metadataBounds = metadata?.getBoundingClientRect();
    return {
      count: image ? 1 : 0,
      imageBounds: bounds
        ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
        : null,
      paintedBounds,
      viewportBounds: viewportBounds
        ? {
            left: viewportBounds.left,
            top: viewportBounds.top,
            right: viewportBounds.right,
            bottom: viewportBounds.bottom,
          }
        : null,
      insideViewport: Boolean(
        paintedBounds &&
        viewportBounds &&
        paintedBounds.left >= viewportBounds.left &&
        paintedBounds.top >= viewportBounds.top &&
        paintedBounds.right <= viewportBounds.right &&
        paintedBounds.bottom <= viewportBounds.bottom,
      ),
      metadataGap: bounds && metadataBounds ? metadataBounds.top - bounds.bottom : -Infinity,
    };
  }, paintedBounds);
}

async function visibleMedia() {
  return browser.execute(() =>
    [...document.querySelectorAll(".media-image, .canvas-replay")].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        className: element.className,
        source: element instanceof HTMLImageElement ? element.currentSrc : "",
        bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      };
    }),
  );
}

async function workshopMetrics() {
  return browser.execute(() => {
    const image = document.querySelector(".media-visual.media-sprite");
    const status = [...document.querySelectorAll(".game-line")]
      .filter((line) => line.textContent?.includes("第1年  1月  8日"))
      .at(-1);
    const dialogue = [...document.querySelectorAll(".game-line")].find((line) =>
      line.textContent?.includes("萝乐娜"),
    );
    const bounds = image?.getBoundingClientRect();
    const statusBounds = status?.getBoundingClientRect();
    const dialogueBounds = dialogue?.getBoundingClientRect();
    return {
      count: image ? 1 : 0,
      statusGap: bounds && statusBounds ? bounds.top - statusBounds.bottom : -Infinity,
      dialogueGap: bounds && dialogueBounds ? dialogueBounds.top - bounds.bottom : -Infinity,
    };
  });
}

async function dialoguePortraitMetrics() {
  return browser.execute(() => {
    const images = [...document.querySelectorAll(".media-visual.media-sprite")].map((image) => {
      const bounds = image.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    });
    const [background, ...portraits] = images;
    const dialogue = [...document.querySelectorAll(".game-line")]
      .filter((line) => line.textContent?.includes("萝乐娜"))
      .at(-1);
    const dialogueBounds = dialogue?.getBoundingClientRect();
    return {
      imageCount: images.length,
      background,
      portraits,
      dialogueTop: dialogueBounds?.top ?? null,
    };
  });
}

function assertDialoguePortraits(metrics, expectedPortraits) {
  assert.ok(metrics.background, "dialogue background must be rendered");
  assert.equal(metrics.portraits.length, expectedPortraits);
  for (const portrait of metrics.portraits) {
    assert.ok(
      Math.abs(portrait.bottom - metrics.background.bottom) <= 2,
      `portrait bottom ${portrait.bottom} must align with background ${metrics.background.bottom}`,
    );
    assert.ok(
      portrait.left >= metrics.background.left - 2 &&
        portrait.top >= metrics.background.top - 2 &&
        portrait.right <= metrics.background.right + 2,
      "portrait must remain inside the scene background",
    );
    assert.ok(
      metrics.dialogueTop == null || portrait.bottom <= metrics.dialogueTop,
      "portrait must not overlap the dialogue text",
    );
  }
}
