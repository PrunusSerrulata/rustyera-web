import assert from "node:assert/strict";

import {
  advanceEnterWaitsUntil,
  clickViewportBottom,
  reachTitle,
  skipOpeningToWorkshop,
  snapshot,
  submitPrompt,
  waitForProject,
  waitForWaitChange,
} from "./rorona-flow.mjs";

const STEP_TIMEOUT = 30_000;
const roronaLogInputs = process.env.VITE_RUSTYERA_TAURI_RORONA_LOG_INPUTS
  ? describe
  : describe.skip;

roronaLogInputs("Tauri erarorona game log input", () => {
  it("returns on a key or left click and skips the current scene on right click", async () => {
    await waitForProject();
    await reachTitle(20);
    await submitPrompt(0);
    await skipOpeningToWorkshop();
    await advanceEnterWaitsUntil("我回来了……", 80);

    let logWaitId = await openGameLog();
    await browser.keys(["Space"]);
    await assertReturnedToDialogue(logWaitId);

    logWaitId = await openGameLog();
    await clickViewportBottom("left");
    await assertReturnedToDialogue(logWaitId);

    logWaitId = await openGameLog();
    await clickViewportBottom("right");
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return (
          state.wait?.wait_id !== logWaitId &&
          state.canInteract &&
          state.wait?.stop_message_skip === true &&
          state.output.slice(-60).join("\n").includes("暗之公会")
        );
      },
      {
        timeout: 180_000,
        timeoutMsg: "right-clicking the game log did not stop at the dark guild",
      },
    );

    const state = await snapshot();
    assert.equal(state.fault, null);
    assert.equal(state.wait?.stop_message_skip, true);
    const runtimeWarnings = state.frontend?.logs ?? state.logs ?? [];
    assert.ok(
      runtimeWarnings.every(
        (entry) =>
          !String(entry.message ?? entry).includes("input wait identity is stale") &&
          !String(entry.message ?? entry).includes("no input is pending"),
      ),
      "game-log input must not produce stale or missing-input rejections",
    );
  });
});

async function openGameLog() {
  const button = await $("//button[contains(normalize-space(.), '[+] 日志')]");
  await button.waitForClickable({ timeout: STEP_TIMEOUT });
  await button.click();
  await browser.waitUntil(async () => (await snapshot()).wait?.kind === "any_key", {
    timeout: STEP_TIMEOUT,
    timeoutMsg: "game log did not expose an AnyKey wait",
  });
  return (await snapshot()).wait.wait_id;
}

async function assertReturnedToDialogue(logWaitId) {
  await waitForWaitChange(logWaitId);
  const state = await snapshot();
  assert.ok(
    state.output.slice(-60).join("\n").includes("我回来了……"),
    "ordinary continuation must return to the same dialogue without advancing it",
  );
}
