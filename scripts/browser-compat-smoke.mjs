/* global navigator, window */

import assert from "node:assert/strict";
import { applyBackgroundDomInput } from "./dom-test-input.mjs";

export function createBrowserCompatibilitySmokeHelpers({
  backgroundDom,
  clickElement,
  collectCompatibilityReport,
  setStage,
}) {
  async function inspectOpfsProjectCache(activeBrowser, prefixBytes = undefined) {
    return activeBrowser.executeAsync(async (requestedPrefixBytes, done) => {
      try {
        const storage = await navigator.storage.getDirectory();
        const imports = await storage.getDirectoryHandle(".rustyera-imports");
        let project;
        for await (const [, handle] of imports.entries()) {
          if (handle.kind === "directory") {
            project = handle;
            break;
          }
        }
        if (!project) {
          done({ exists: false, size: 0, hasConfigurationJournal: false });
          return;
        }
        const privateDirectory = await project.getDirectoryHandle(".rustyera");
        const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
        const handle = await cacheDirectory.getFileHandle("compiled-project.reracache");
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prefixLength = requestedPrefixBytes ?? bytes.length;
        const prefixHash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes.subarray(0, prefixLength)),
        );
        const prefixDigest = [...prefixHash]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const magic = new TextEncoder().encode("RERACFG1");
        const hasConfigurationJournal = bytes.some((_, start) =>
          magic.every((byte, offset) => bytes[start + offset] === byte),
        );
        done({ exists: true, size: file.size, prefixDigest, hasConfigurationJournal });
      } catch (error) {
        if (error?.name === "NotFoundError") {
          done({ exists: false, size: 0, hasConfigurationJournal: false });
          return;
        }
        done({
          exists: false,
          size: 0,
          hasConfigurationJournal: false,
          error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
        });
      }
    }, prefixBytes);
  }

  async function runCacheInputSmoke(
    activeBrowser,
    activeBrowserName,
    projectProgress,
    setup,
    opfsReset,
  ) {
    setStage("waiting for compiled cache generation");
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute(() => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return (
            state?.canInteract && state.transfer?.export?.name === "compiled-project.reracache"
          );
        }),
      { timeout: 30_000, interval: 50, timeoutMsg: "compiled cache generation did not start" },
    );
    const titleWaitId = await activeBrowser.execute(
      () => window.__RUSTYERA_TEST__?.snapshot().wait?.wait_id ?? null,
    );
    setStage("clicking the new-game button during compiled cache generation");
    const newGame = await activeBrowser.$(".game-viewport .game-button");
    await newGame.waitForClickable({ timeout: 30_000 });
    await clickElement(activeBrowser, newGame);
    setStage("waiting for game input during compiled cache generation");
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute((previousWaitId) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return state?.canInteract && state.wait?.wait_id !== previousWaitId;
        }, titleWaitId),
      {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: "game input was blocked by compiled cache generation",
      },
    );
    const observed = await collectCompatibilityReport(activeBrowser);
    const inputFailures = await activeBrowser.execute(
      () =>
        window.__RUSTYERA_TEST__
          ?.snapshot()
          .logs.filter((entry) =>
            /input wait identity is stale|no input is pending|input was rejected/.test(
              String(entry.message),
            ),
          ) ?? [],
    );
    if (inputFailures.length > 0)
      throw new Error(`compiled cache input was rejected: ${JSON.stringify(inputFailures)}`);
    console.log(
      JSON.stringify({
        browser: activeBrowserName,
        browserVersion: activeBrowser.capabilities.browserVersion,
        cacheInputSmoke: true,
        projectName: setup.projectName,
        opfs: setup.opfs,
        opfsReset,
        projectProgress,
        ...observed,
      }),
    );
  }

  async function runLogInputSmoke(activeBrowser, activeBrowserName) {
    await advanceMessageWaitsUntil(activeBrowser, "我回来了……", 80);

    let logWaitId = await openGameLog(activeBrowser);
    setStage("returning from the game log with an ordinary key");
    await activeBrowser.keys(["Space"]);
    await waitForReturnedDialogue(activeBrowser, logWaitId);

    logWaitId = await openGameLog(activeBrowser);
    setStage("returning from the game log with a left viewport click");
    await clickElement(activeBrowser, await activeBrowser.$(".game-viewport"));
    await waitForReturnedDialogue(activeBrowser, logWaitId);

    logWaitId = await openGameLog(activeBrowser);
    setStage("skipping the current scene from the game log");
    await (await activeBrowser.$(".game-viewport")).click({ button: "right" });
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute((previousWaitId) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return (
            state?.canInteract &&
            state.wait?.wait_id !== previousWaitId &&
            state.wait?.stop_message_skip === true &&
            state.output.some((line) => String(line).includes("暗之公会"))
          );
        }, logWaitId),
      { timeout: 180_000, interval: 50, timeoutMsg: "game-log skip did not reach the dark guild" },
    );
    const result = await activeBrowser.execute(() => {
      const state = window.__RUSTYERA_TEST__?.snapshot();
      return {
        fault: state?.fault,
        wait: state?.wait,
        inputFailures:
          state?.logs.filter((entry) =>
            /input wait identity is stale|no input is pending|input was rejected/.test(
              String(entry.message),
            ),
          ) ?? [],
      };
    });
    if (result.fault != null || result.inputFailures.length > 0) {
      throw new Error(`game-log input failed: ${JSON.stringify(result)}`);
    }
    console.log(
      JSON.stringify({
        browser: activeBrowserName,
        browserVersion: activeBrowser.capabilities.browserVersion,
        logInputSmoke: true,
        ...result,
      }),
    );
  }

  async function advanceMessageWaitsUntil(activeBrowser, expectedText, maximum) {
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      setStage(`advancing dialogue to ${expectedText}`);
      const state = await activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      if (state?.canInteract && state.output.some((line) => String(line).includes(expectedText)))
        return;
      const waitId = state?.wait?.wait_id;
      if (waitId == null) {
        await activeBrowser.pause(16);
        continue;
      }
      if (state.wait.deadline_ns == null) {
        if (state.wait.kind === "string_value" && state.wait.one_input) {
          await clickElement(activeBrowser, await activeBrowser.$(".game-viewport .game-button"));
        } else {
          await clickElement(
            activeBrowser,
            await activeBrowser.$(".prompt-bar button[type=submit]"),
          );
        }
      }
      await waitForChangedInput(activeBrowser, waitId);
    }
    throw new Error(`${expectedText} was not visible after ${maximum} message waits`);
  }

  async function openGameLog(activeBrowser) {
    setStage("opening the in-game message log");
    const button = await activeBrowser.$("//button[contains(normalize-space(.), '[+] 日志')]");
    await button.waitForClickable({ timeout: 30_000 });
    await clickElement(activeBrowser, button);
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot().wait?.kind === "any_key"),
      { timeout: 30_000, interval: 50, timeoutMsg: "game log did not expose an AnyKey wait" },
    );
    return activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot().wait.wait_id);
  }

  async function waitForReturnedDialogue(activeBrowser, previousWaitId) {
    await waitForChangedInput(activeBrowser, previousWaitId);
    const returned = await activeBrowser.execute(() => {
      const state = window.__RUSTYERA_TEST__?.snapshot();
      return state?.output.some((line) => String(line).includes("我回来了……"));
    });
    if (!returned) throw new Error("game-log continuation advanced past the current dialogue");
  }

  async function waitForChangedInput(activeBrowser, previousWaitId) {
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute((waitId) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return state?.fault != null || (state?.canInteract && state.wait?.wait_id !== waitId);
        }, previousWaitId),
      { timeout: 30_000, interval: 50, timeoutMsg: "game input did not advance" },
    );
  }

  async function loadSnakeInteropSlot(activeBrowser) {
    // SYSTEM_TITLE initializes TW's SQL connections before the real LOADDATA path.
    // Lifecycle restoration from a fresh session cannot replace that initialization.
    for (const [label, selector] of [
      ["continue game", "//button[contains(normalize-space(.), '[1] 继续游戏')]"],
      ["load save1000", "//button[contains(normalize-space(.), '[1000]')]"],
      [
        "confirm load",
        "//button[contains(normalize-space(.), '[0]') and contains(normalize-space(.), '是')]",
      ],
    ]) {
      setStage(`snake interoperability: ${label}`);
      const buttons = await activeBrowser.$$(selector);
      assert.equal(buttons.length, 1, `${label}: one matching game button required`);
      const button = buttons[0];
      assert.ok(await button.isDisplayed(), `${label}: visible button required`);
      assert.ok(await button.isEnabled(), `${label}: enabled button required`);
      const before = await activeBrowser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary());
      if (label === "confirm load")
        assert.ok(before.output.some((line) => line.includes("读取该存档")));
      console.log(
        JSON.stringify({
          type: "snake-interop-input",
          label,
          text: await button.getText(),
          wait: before.wait,
        }),
      );
      await clickElement(activeBrowser, button);
      let lastWait = before.wait?.wait_id;
      let continuations = 0;
      await activeBrowser.waitUntil(
        async () => {
          const state = await activeBrowser.execute(() =>
            window.__RUSTYERA_TEST__.snapshotSummary(),
          );
          if (state.fault) throw new Error(JSON.stringify(state.fault));
          if (!state.canInteract || !state.wait || state.wait.wait_id === lastWait) return false;
          if (!["enter_key", "any_key"].includes(state.wait.kind)) return true;
          assert.ok(continuations++ < 16, `${label}: too many message continuations`);
          const input = await activeBrowser.$(".prompt-bar input");
          if (backgroundDom) {
            const evidence = await activeBrowser.execute(applyBackgroundDomInput, input, "");
            console.log(JSON.stringify({ type: "background-dom-input", ...evidence }));
          } else await input.setValue("");
          lastWait = state.wait.wait_id;
          await clickElement(
            activeBrowser,
            await activeBrowser.$(".prompt-bar button[type=submit]"),
          );
          return false;
        },
        { timeout: 300_000, interval: 100, timeoutMsg: `${label}: next input was not reached` },
      );
    }
  }

  return {
    inspectOpfsProjectCache,
    runCacheInputSmoke,
    runLogInputSmoke,
    loadSnakeInteropSlot,
  };
}
