import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_HOT_RELOAD === "1" ? describe : describe.skip;
const PROJECT_TIMEOUT = 30_000;
let driver;

enabled("Tauri incremental and hot script reload", () => {
  it("preserves a running game while reloading all scripts, one folder, and one script", async () => {
    driver = browser;
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await waitForCommandWait("cold fixture did not reach its training command wait");

    const cachePath = process.env.VITE_RUSTYERA_TEST_PROJECT_FILE;
    await browser.waitUntil(async () => fileExists(cachePath), {
      timeout: 4_000,
      interval: 100,
      timeoutMsg: "compiled project cache was not persisted before the hot-reload test",
    });

    await $("button=文件").click();
    await $("button=重新开始").click();
    const restartDialog = await $(".dialog-panel[aria-label='重新开始游戏']");
    await restartDialog.waitForDisplayed();
    await restartDialog.$("button=重新开始").click();
    let state = await waitForCommandWait("cached fixture restart did not reach its command wait");
    assert.equal(state.startupTelemetry?.cacheHit, true);
    assert.match(state.output.join("\n"), /HOT_RELOAD_READY/);

    await Promise.all([
      replaceVersion("ERB/folder/command.erb", "FOLDER_VERSION=1", "FOLDER_VERSION=2"),
      replaceVersion("ERB/single/command.erb", "SINGLE_VERSION=1", "SINGLE_VERSION=2"),
    ]);
    state = await reloadSelected("folder", "ERB/folder", state.runtimeEpoch);
    assert.equal(state.wait?.kind, "integer_value");
    let previousWait = waitIdentity(state.wait);
    await submitCommand("1", previousWait);
    state = await waitForOutput("FOLDER_VERSION=2 STATE=40", previousWait);

    // The other changed script must still execute the cached generation until its own reload.
    previousWait = waitIdentity(state.wait);
    await submitCommand("2", previousWait);
    state = await waitForOutput("SINGLE_VERSION=1 STATE=41", previousWait);

    await replaceVersion("ERB/all/command.erb", "ALL_VERSION=1", "ALL_VERSION=2");
    state = await reloadSelected("script", "ERB/single/command.erb", state.runtimeEpoch);
    assert.equal(state.wait?.kind, "integer_value");
    previousWait = waitIdentity(state.wait);
    await submitCommand("2", previousWait);
    state = await waitForOutput("SINGLE_VERSION=2 STATE=42", previousWait);

    // A single-script reload must not absorb a simultaneous change in another folder.
    previousWait = waitIdentity(state.wait);
    await submitCommand("0", previousWait);
    state = await waitForOutput("ALL_VERSION=1 STATE=43", previousWait);

    state = await reloadAll(state.runtimeEpoch);
    assert.equal(state.wait?.kind, "integer_value");
    previousWait = waitIdentity(state.wait);
    await submitCommand("0", previousWait);
    state = await waitForOutput("ALL_VERSION=2 STATE=44", previousWait);

    assert.equal(state.fault, null);
    assert.equal(state.phase, "waiting_input");
    assert.equal(state.canInteract, true);
    assert.equal(
      state.output.filter((line) => line.includes("HOT_RELOAD_READY")).length,
      1,
      "hot reload unexpectedly restarted the running game",
    );
    assert.equal(
      state.logs.some((entry) =>
        /runtime\.input_undo_invalidated|重新加载项目失败|项目启动失败|content_hash_mismatch|command rejected \[(?!StaleRequest\].*projection observation)/i.test(
          String(entry?.message ?? entry),
        ),
      ),
      false,
      `hot reload emitted a rejection: ${JSON.stringify(state.logs.slice(-12))}`,
    );
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        cachePath,
        cacheHit: state.startupTelemetry?.cacheHit,
        bridgeKind: state.bridgeKind,
        runtimeEpoch: state.runtimeEpoch,
        wait: state.wait,
        verified: [
          "FOLDER_VERSION=2 STATE=40",
          "SINGLE_VERSION=1 STATE=41",
          "SINGLE_VERSION=2 STATE=42",
          "ALL_VERSION=1 STATE=43",
          "ALL_VERSION=2 STATE=44",
        ],
        outputTail: state.output.slice(-18),
      }),
    );
  });
});

async function snapshot() {
  return driver.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitForCommandWait(label) {
  return waitForRuntimeProgress({
    browser: driver,
    snapshot,
    label,
    totalTimeout: PROJECT_TIMEOUT,
    stallTimeout: PROJECT_TIMEOUT,
    accept: (state) =>
      state?.projectOpen &&
      state.phase === "waiting_input" &&
      state.canInteract &&
      state.wait?.kind === "integer_value" &&
      state.output.some((line) => line.includes("HOT_RELOAD_COMMANDS")),
  });
}

async function waitForOutput(expected, previousWait) {
  return waitForRuntimeProgress({
    browser: driver,
    snapshot,
    label: `game did not execute reloaded script: ${expected}`,
    totalTimeout: 4_000,
    stallTimeout: 4_000,
    pollInterval: 50,
    accept: (state) =>
      state?.phase === "waiting_input" &&
      state.canInteract &&
      waitIdentity(state.wait) !== previousWait &&
      state.output.some((line) => line.includes(expected)),
  });
}

function waitIdentity(wait) {
  return `${wait?.wait_id}:${wait?.submission_token?.epoch}:${wait?.submission_token?.id}`;
}

async function reloadAll(previousEpoch) {
  await $("button=文件").click();
  await $("button=重新加载全部脚本").click();
  return waitForReload(previousEpoch, "all scripts did not finish hot reloading");
}

async function reloadSelected(mode, target, previousEpoch) {
  await $("button=文件").click();
  await $(mode === "folder" ? "button=重新加载文件夹…" : "button=重新加载单个脚本…").click();
  const label = mode === "folder" ? "重新加载脚本文件夹" : "重新加载单个脚本";
  const dialog = await $(`.dialog-panel[aria-label='${label}']`);
  await dialog.waitForDisplayed();
  await dialog.$("select").setValue(target);
  await dialog.$("button=重新加载").click();
  return waitForReload(previousEpoch, `${target} did not finish hot reloading`);
}

async function waitForReload(previousEpoch, label) {
  return waitForRuntimeProgress({
    browser: driver,
    snapshot,
    label,
    totalTimeout: PROJECT_TIMEOUT,
    stallTimeout: PROJECT_TIMEOUT,
    accept: (state) => {
      if (String(state?.status).startsWith("重新加载项目失败")) {
        throw new Error(`${label}: ${state.status}: ${JSON.stringify(state.logs.slice(-12))}`);
      }
      if (Number(state?.runtimeEpoch) > Number(previousEpoch) + 1)
        throw new Error(
          `${label}: reload advanced more than one runtime epoch (${previousEpoch} -> ${state.runtimeEpoch})`,
        );
      return (
        state?.phase === "waiting_input" &&
        state.canInteract &&
        Number(state.runtimeEpoch) === Number(previousEpoch) + 1
      );
    },
  });
}

async function submitCommand(value, previousWait) {
  const input = await $(".prompt-bar input");
  const submit = await $(".prompt-bar button[type='submit']");
  await input.waitForEnabled({ timeout: 2_000 });
  await submit.waitForEnabled({ timeout: 2_000 });
  const submittedValue = await driver.execute((nextValue) => {
    const input = document.querySelector(".prompt-bar input");
    if (!(input instanceof HTMLInputElement)) throw new Error("visible game input is unavailable");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter || input.disabled) throw new Error("visible game input is disabled");
    input.focus();
    valueSetter.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (input.value !== nextValue) throw new Error("visible game input value was not retained");
    return input.value;
  }, value);
  assert.equal(submittedValue, value, `visible game input did not retain ${value}`);
  await driver.execute(() => {
    const button = document.querySelector(".prompt-bar button[type='submit']");
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error("visible game submit button is unavailable");
    }
    button.click();
  });
  await driver.waitUntil(
    async () => {
      const state = await snapshot();
      return waitIdentity(state.wait) !== previousWait;
    },
    {
      timeout: 2_000,
      interval: 25,
      timeoutMsg: `game input ${value} did not enter Runtime from wait ${previousWait}`,
    },
  );
}

async function replaceVersion(relativePath, previous, next) {
  const sourcePath = path.join(process.env.VITE_RUSTYERA_TEST_PROJECT, relativePath);
  const source = await readFile(sourcePath, "utf8");
  assert.equal(source.includes(previous), true, `${relativePath} did not contain ${previous}`);
  await writeFile(sourcePath, source.replace(previous, next), "utf8");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
