import assert from "node:assert/strict";

import { captureCompleteTauriSnapshot } from "../../scripts/tauri-test-support.mjs";
import { driveRuntimeUntil, waitForRuntimeProgress } from "./runtime-progress.mjs";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
export const OPENING_INTRO_TIMEOUT = 3_000;
const OPENING_WORKSHOP_MARKER = "亚斯特丽德的工房";
const OPENING_STEPS = [
  {
    marker: "亚兰德――",
    endMarker: "开一间炼金术的工房。",
    stopMessageSkip: false,
    button: "right",
  },
  { marker: "开一间炼金术的工房。", stopMessageSkip: true, button: "left" },
  {
    marker: "之后时光流逝，直到现在――",
    stopMessageSkip: false,
    button: "right",
  },
  { marker: "萝乐娜――", stopMessageSkip: true, button: "left" },
];

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
  await driveRuntimeUntil({
    browser,
    snapshot,
    label: "Rorona first opening FADE_ALL input",
    totalTimeout: 180_000,
    pollInterval: 20,
    accept: (state) => nextOpeningAction(state, 0)?.button === "right",
  });
  const interactions = [];
  let stepIndex = 0;
  const introductionStartedAt = Date.now();
  let lastState;

  for (;;) {
    const state = await snapshot();
    lastState = state;
    if (state?.fault != null) {
      throw new Error(`opening skip runtime faulted: ${JSON.stringify(state.fault)}`);
    }
    const elapsedMs = Date.now() - introductionStartedAt;
    if (elapsedMs >= OPENING_INTRO_TIMEOUT) break;
    const action = nextOpeningAction(state, stepIndex);
    if (action?.done) {
      const result = { elapsedMs, interactions, boundary: openingDiagnosticState(state) };
      console.log(JSON.stringify({ openingSkip: result }));
      return result;
    }
    if (action?.button) {
      interactions.push({
        step: stepIndex + 1,
        marker: action.marker,
        ...(await clickViewportBottom(action.button, { requireNonInteractive: true })),
      });
      stepIndex += 1;
      continue;
    }
    await browser.pause(20);
  }

  const elapsedMs = Date.now() - introductionStartedAt;
  const completeSnapshot = await captureCompleteTauriSnapshot(browser);
  const diagnostic = {
    failureStage: "opening introduction skip",
    timeoutMs: OPENING_INTRO_TIMEOUT,
    elapsedMs,
    nextStep: stepIndex + 1,
    interactions,
    state: openingDiagnosticState(lastState),
    ...completeSnapshot,
  };
  console.error(JSON.stringify(diagnostic));
  throw new Error(
    `opening introduction remained visible for at least ${OPENING_INTRO_TIMEOUT}ms: ${JSON.stringify(diagnostic)}`,
  );
}

export async function clickViewportBottom(button, { requireNonInteractive = false } = {}) {
  const click = await browser.execute(() => {
    const element = document.querySelector(".game-viewport");
    if (!(element instanceof HTMLElement)) return null;
    element.scrollTop = element.scrollHeight;
    const bounds = element.getBoundingClientRect();
    const clientX = Math.floor(bounds.left + bounds.width / 2);
    const clientY = Math.floor(bounds.bottom - 4);
    const target = document.elementFromPoint(clientX, clientY);
    const capture = { element, events: [], listeners: [] };
    for (const eventType of ["mousedown", "mouseup", "click", "contextmenu"]) {
      const listener = (event) => {
        const eventTarget = event.target;
        capture.events.push({
          type: event.type,
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          target:
            eventTarget instanceof Element
              ? {
                  tag: eventTarget.tagName.toLowerCase(),
                  className: eventTarget.className,
                  text: eventTarget.textContent?.slice(-160) ?? "",
                }
              : null,
        });
      };
      capture.listeners.push({ eventType, listener });
      element.addEventListener(eventType, listener, { capture: true });
    }
    window.__RUSTYERA_TAURI_VIEWPORT_CLICK__ = capture;
    return {
      x: clientX - Math.floor(bounds.left + bounds.width / 2),
      y: clientY - Math.floor(bounds.top + bounds.height / 2),
      clientX,
      clientY,
      viewport: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      },
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      targetInteractive: Boolean(
        target?.closest("button, a, input, select, textarea, [role='button'], [data-no-continue]"),
      ),
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
  assert.ok(click.target, "viewport bottom-center click point must hit a document element");
  if (requireNonInteractive) {
    assert.equal(
      click.targetInteractive,
      false,
      "viewport bottom-center click point must not hit an interactive control",
    );
  }
  let events = [];
  try {
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: "viewport", x: click.clientX, y: click.clientY })
      .down({ button: button === "right" ? 2 : 0 })
      .pause(50)
      .up({ button: button === "right" ? 2 : 0 })
      .perform();
  } finally {
    events = await browser.execute(() => {
      const capture = window.__RUSTYERA_TAURI_VIEWPORT_CLICK__;
      if (!capture) return [];
      for (const { eventType, listener } of capture.listeners) {
        capture.element.removeEventListener(eventType, listener, true);
      }
      delete window.__RUSTYERA_TAURI_VIEWPORT_CLICK__;
      return capture.events;
    });
  }
  const expectedEventTypes =
    button === "right" ? ["mousedown", "mouseup"] : ["mousedown", "mouseup", "click"];
  const expectedButton = button === "right" ? 2 : 0;
  const requiredEvents = expectedEventTypes.map((eventType) => {
    const event = events.find((candidate) => candidate.type === eventType);
    assert.ok(
      event,
      `WebDriver ${button} click did not emit ${eventType} in the game viewport: ${JSON.stringify(events)}`,
    );
    assert.equal(event.button, expectedButton);
    assert.ok(
      Math.abs(event.clientX - click.clientX) <= 1,
      `viewport ${eventType} x coordinate drifted`,
    );
    assert.ok(
      Math.abs(event.clientY - click.clientY) <= 1,
      `viewport ${eventType} y coordinate drifted`,
    );
    return event;
  });
  return { button, planned: click, events, requiredEvents };
}

export function nextOpeningAction(state, stepIndex) {
  const output = state?.output?.slice(-80).join("\n") ?? "";
  // EVENT/00_序章.ERB enters SHOW_SITUATION only after both introductory
  // FADE_ALL calls and their FORCEWAIT barriers have completed.
  if (output.includes(OPENING_WORKSHOP_MARKER)) return { done: true };
  const step = OPENING_STEPS[stepIndex];
  if (
    !step ||
    !state?.canInteract ||
    state.wait?.kind !== "enter_key" ||
    state.wait?.stop_message_skip !== step.stopMessageSkip ||
    !output.includes(step.marker) ||
    (step.endMarker != null && output.includes(step.endMarker))
  ) {
    return null;
  }
  return step;
}

function openingDiagnosticState(state) {
  return {
    phase: state?.phase,
    canInteract: state?.canInteract,
    wait: state?.wait,
    presentationRevision: state?.presentationRevision,
    outputTail: state?.output?.slice(-20),
    fault: state?.fault,
    logTail: state?.logs?.slice(-8),
  };
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
