import assert from "node:assert/strict";

import { establishReferenceWindow, paintedImageBounds } from "./media-geometry.mjs";
import { driveRuntimeUntil } from "./runtime-progress.mjs";
import {
  advanceEnterWaitsUntil,
  clickViewportBottom,
  reachTitle,
  skipOpeningToWorkshop,
  snapshot,
  submitPrompt,
  waitForProject,
} from "./rorona-flow.mjs";

const STEP_TIMEOUT = 30_000;
const roronaImages = process.env.VITE_RUSTYERA_TAURI_RORONA_IMAGES ? describe : describe.skip;

roronaImages("Tauri erarorona image rendering", () => {
  it("keeps title, dialogue, and action-screen media aligned and colored", async () => {
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

    await submitPrompt(0);
    const openingSkip = await skipOpeningToWorkshop();
    assert.deepEqual(
      openingSkip.interactions.map((interaction) => interaction.button),
      ["right", "left", "right", "left"],
      "the two FADE_ALL blocks must each use right-click skip followed by left-click FORCEWAIT continuation",
    );

    let workshop;
    await browser.waitUntil(
      async () => {
        workshop = await workshopMetrics();
        return workshop.count === 1 && workshop.statusGap >= 0 && workshop.dialogueGap >= 0;
      },
      { timeout: STEP_TIMEOUT, timeoutMsg: "workshop image geometry did not stabilize" },
    );
    const state = await snapshot();
    console.log(
      JSON.stringify({
        title,
        workshop,
        openingSkip,
        wait: state.wait,
        fault: state.fault,
      }),
    );
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
    await enableMessageSkip();
    const actionScreenClicks = await alternateClicksUntilActionScreen();
    assert.ok(actionScreenClicks > 0, "the action screen must require alternating viewport clicks");
    const actionScreen = await actionScreenMetrics();
    assertActionScreen(actionScreen);
    assert.ok(
      automaticTimedWaits > 0,
      "opening fades and dialogue typewriter frames must advance without clicking",
    );
    console.log(
      JSON.stringify({
        firstDialogue,
        secondDialogue,
        actionScreen,
        actionScreenClicks,
        automaticTimedWaits,
      }),
    );
  });
});

async function enableMessageSkip() {
  const buttons = await $$(".game-button");
  for (const button of buttons) {
    if ((await button.getText()).includes("[*] 跳过")) {
      await button.click();
      return;
    }
  }
  throw new Error("the visible [*] message-skip control was not found");
}

async function alternateClicksUntilActionScreen() {
  let clicks = 0;
  await driveRuntimeUntil({
    browser,
    snapshot,
    label: "Rorona Jan 9 workshop action screen after alternating-click skip",
    totalTimeout: 180_000,
    pollInterval: 100,
    accept: async (state) =>
      state.canInteract &&
      state.wait?.stability === "stable_input" &&
      (await actionScreenVisible()),
    advance: async () => {
      await clickViewportBottom(clicks % 2 === 0 ? "left" : "right");
      clicks += 1;
      return true;
    },
  });
  return clicks;
}

async function actionScreenVisible() {
  return browser.execute(() => {
    const text = document.querySelector(".game-viewport")?.textContent ?? "";
    return ["调教对象", "调合等级", "温馨提示："].every((marker) => text.includes(marker));
  });
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

async function actionScreenMetrics() {
  return browser.execute(() => {
    const identityLine = [...document.querySelectorAll(".game-line")].find(
      (line) => line.textContent?.includes("萝乐娜") && line.textContent?.includes("调合等级"),
    );
    const identityBounds = identityLine?.getBoundingClientRect();
    const portraitLayers = identityLine
      ? [...identityLine.querySelectorAll(".html-division-visual .media-visual")].map((image) => {
          const bounds = image.getBoundingClientRect();
          return {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bounds.height,
          };
        })
      : [];
    const fontRuns = [...document.querySelectorAll(".html-font")].map((element) => ({
      text: element.textContent ?? "",
      color: getComputedStyle(element).color,
    }));
    return {
      identityLineTop: identityBounds?.top ?? null,
      portraitLayers,
      barColors: [
        ...new Set(fontRuns.filter((run) => run.text.includes("▮")).map((run) => run.color)),
      ],
      disabledStartColor: fontRuns.find((run) => run.text.includes("[0] 开始调教"))?.color ?? null,
    };
  });
}

function assertActionScreen(metrics) {
  assert.ok(metrics.identityLineTop != null, "the Rorona identity row must be visible");
  assert.ok(metrics.portraitLayers.length >= 2, "the layered Rorona avatar must be visible");
  const [first, ...remaining] = metrics.portraitLayers;
  assert.ok(
    Math.abs(first.top - metrics.identityLineTop) <= 2,
    `avatar top ${first.top} must align with its identity row ${metrics.identityLineTop}`,
  );
  for (const layer of remaining) {
    assert.deepEqual(layer, first, "all avatar layers must occupy the same rectangle");
  }
  assert.ok(metrics.barColors.includes("rgb(192, 112, 112)"), "the health bar must be red");
  assert.ok(metrics.barColors.includes("rgb(112, 112, 192)"), "the stamina bar must be blue");
  assert.ok(metrics.barColors.includes("rgb(112, 192, 112)"), "the mana bar must be green");
  assert.equal(metrics.disabledStartColor, "rgb(64, 64, 64)");
}
