import assert from "node:assert/strict";

import { driveRuntimeUntil, waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const OPENING_INTRO_MARKERS = ["亚兰德――", "之后时光流逝，直到现在――"];

export async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

export async function waitForProject() {
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

export async function submitPrompt(value) {
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
}

export async function submit(value, requireStable = false) {
  const before = await snapshot();
  await submitPrompt(value);
  await waitForWaitChange(before.wait?.wait_id, requireStable);
}

export async function reachTitle(maximum) {
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

export async function skipOpeningToWorkshop() {
  const introduction = await driveRuntimeUntil({
    browser,
    snapshot,
    label: "Rorona opening text before viewport message skip",
    totalTimeout: 180_000,
    pollInterval: 100,
    accept: (state) =>
      state.canInteract &&
      OPENING_INTRO_MARKERS.some((marker) => state.output.slice(-60).join("\n").includes(marker)),
  });
  await clickViewportBottom("right");
  await waitForWaitChange(introduction.wait.wait_id);
  let clicks = 1;
  if (!(await snapshot()).output.slice(-60).join("\n").includes("亚斯特丽德的工房")) {
    const boundary = await snapshot();
    await clickViewportBottom("left");
    await waitForWaitChange(boundary.wait.wait_id);
    clicks += 1;
  }
  await browser.waitUntil(
    async () => (await snapshot()).output.slice(-60).join("\n").includes("亚斯特丽德的工房"),
    { timeout: STEP_TIMEOUT, timeoutMsg: "opening skip did not reach the workshop" },
  );
  return clicks;
}

export async function clickViewportBottom(button) {
  const viewport = await $(".game-viewport");
  const click = await browser.execute(() => {
    const element = document.querySelector(".game-viewport");
    if (!(element instanceof HTMLElement)) return null;
    element.scrollTop = element.scrollHeight;
    const bounds = element.getBoundingClientRect();
    const clientX = bounds.left + bounds.width / 2;
    const clientY = bounds.bottom - 4;
    const target = document.elementFromPoint(clientX, clientY);
    return {
      x: 0,
      y: Math.max(0, Math.floor(bounds.height / 2) - 4),
      clientX,
      clientY,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      target: target
        ? {
            tag: target.tagName.toLowerCase(),
            className: target.className,
            text: target.textContent?.slice(-160) ?? "",
          }
        : null,
    };
  });
  assert.ok(click, "game viewport must exist before clicking its bottom edge");
  await viewport.click({ button, x: click.x, y: click.y });
  return { button, ...click };
}

export async function advanceEnterWaitsUntil(expectedText, maximum, requireImage = false) {
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
    if (state.wait.deadline_ns != null) {
      automaticTimedWaits += 1;
      await waitForWaitChange(state.wait.wait_id);
      continue;
    }
    assert.ok(
      ["enter_key", "any_key", "void"].includes(state.wait.kind) ||
        (state.wait.one_input && state.wait.kind === "string_value"),
      `opening flow reached unexpected ${state.wait.kind ?? "missing"} prompt`,
    );
    if (state.wait.kind === "string_value") await $(".game-viewport .game-button").click();
    else await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
  throw new Error(`${expectedText} was not visible after ${maximum} Enter waits`);
}

export async function waitForNextWait() {
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state.fault != null || (state.phase === "waiting_input" && state.wait != null);
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game did not expose its next input wait" },
  );
}

export async function waitForWaitChange(waitId, requireStable = false) {
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
