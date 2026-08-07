#!/usr/bin/env node
/* global document, getComputedStyle, HTMLInputElement, HTMLElement, MutationObserver, navigator, window */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { remote } from "webdriverio";

import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";

import {
  browserProjectProgressErrors,
  injectInGameSaveFlow,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  terminalRuntimeRejection,
} from "./web-test-lib.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const browserName = process.argv[process.argv.indexOf("--browser") + 1];
if (!browserName || !["firefox", "safari"].includes(browserName)) {
  throw new Error("usage: browser-compat-test --browser <firefox|safari>");
}
const projectIndex = process.argv.indexOf("--project");
if (projectIndex >= 0 && !process.argv[projectIndex + 1]) {
  throw new Error("--project requires a path");
}
const project = path.resolve(
  repository,
  projectIndex >= 0
    ? process.argv[projectIndex + 1]
    : "../emuera.em/emuera-reference-cli/tests/fixture",
);
const checkTooltip = process.argv.includes("--check-tooltip");
const files = await collectFiles(project);
if (projectIndex < 0) {
  const oracle = files.find((entry) => entry.path.toLowerCase() === "erb/oracle.erb");
  if (!oracle) throw new Error("browser compatibility fixture lacks erb/oracle.erb");
  oracle.base64 = Buffer.from(
    injectInGameSaveFlow(Buffer.from(oracle.base64, "base64").toString("utf8")),
  ).toString("base64");
}
let server;
let browser;
let snapshotMonitor;
let snapshotMonitorError;
let runError;
let compatibilityStage = "starting browser session";

try {
  server = await createServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" ? address.port : 1420;
  browser = await remote({
    logLevel: "warn",
    capabilities:
      browserName === "firefox"
        ? {
            browserName: "firefox",
            "wdio:enforceWebDriverClassic": true,
            "moz:firefoxOptions": {
              binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
              args: ["-headless"],
            },
          }
        : {
            browserName: "safari",
            "wdio:enforceWebDriverClassic": true,
          },
  });
  await browser.url(`http://127.0.0.1:${port}`);
  snapshotMonitor = startCompleteSnapshotMonitor(browser, {
    eventType: "browser-compat-snapshot",
    label: `${browserName} compatibility`,
    snapshotContext: () => ({ stage: compatibilityStage }),
  });
  void snapshotMonitor.failure.catch(async () => {
    await browser?.deleteSession().catch(() => undefined);
  });
  let minimized = false;
  compatibilityStage = "installing portable project picker";
  const setup = await browser.executeAsync(
    async (payload, done) => {
      try {
        const selected = payload.files.map((entry) => {
          const raw = atob(entry.base64);
          const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
          const file = new File([bytes], entry.path.split("/").at(-1));
          Object.defineProperty(file, "webkitRelativePath", {
            value: `${payload.projectName}/${entry.path}`,
          });
          return file;
        });
        const nativeCreateElement = document.createElement;
        const picker = {
          fallback: false,
          focusBeforeChange: false,
          confirmationDelayMs: 50,
          attempts: [],
        };
        Object.defineProperty(window, "showDirectoryPicker", {
          configurable: true,
          value: undefined,
        });
        document.createElement = function (tagName, options) {
          const element = nativeCreateElement.call(this, tagName, options);
          if (!(element instanceof HTMLInputElement)) return element;

          const nativeClick = element.click.bind(element);
          Object.defineProperty(element, "click", {
            configurable: true,
            value() {
              // Safari does not consistently expose the directory flag through the same DOM
              // property path as Firefox. The project fallback is uniquely a multi-file picker
              // without an accept filter; traditional save pickers are single-file and filtered.
              const isDirectoryPicker =
                element.type === "file" && element.multiple && !element.accept;
              picker.attempts.push({
                accept: element.accept,
                directoryAttribute: element.hasAttribute("webkitdirectory"),
                directoryProperty: Boolean(element.webkitdirectory),
                isDirectoryPicker,
                multiple: element.multiple,
                type: element.type,
              });
              if (!isDirectoryPicker) {
                nativeClick();
                return;
              }
              picker.fallback = true;
              window.dispatchEvent(new Event("focus"));
              picker.focusBeforeChange = true;
              window.setTimeout(() => {
                Object.defineProperty(element, "files", {
                  configurable: true,
                  value: selected,
                });
                element.dispatchEvent(new Event("change", { bubbles: true }));
                document.createElement = nativeCreateElement;
              }, picker.confirmationDelayMs);
            },
          });
          return element;
        };
        window.__RUSTYERA_COMPAT_PICKER__ = picker;
        done({
          ok: true,
          projectName: payload.projectName,
          opfs: typeof navigator.storage.getDirectory === "function",
        });
      } catch (error) {
        done({ ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
      }
    },
    { projectName: path.basename(project), files },
  );
  if (!setup.ok) throw new Error(`browser project import failed: ${setup.error}`);

  await browser.execute(() => {
    const progress = { active: false, completed: false, gaps: 0, labels: [] };
    const capture = () => {
      const element = document.querySelector(".project-load-progress");
      if (element) {
        progress.active = true;
        const label = element.querySelector("span")?.textContent?.trim();
        if (label && progress.labels.at(-1) !== label) progress.labels.push(label);
        return;
      }
      if (!progress.active) return;
      const state = window.__RUSTYERA_TEST__?.snapshot();
      if (state?.canInteract || state?.status === "项目编译完成") {
        progress.active = false;
        progress.completed = true;
      } else {
        progress.gaps += 1;
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.__RUSTYERA_COMPAT_PROGRESS__ = { capture, observer, progress };
    capture();
  });

  compatibilityStage = "opening fixture project";
  const open = await browser.$("button.primary.large");
  await open.waitForClickable({ timeout: 30_000 });
  await open.click();
  try {
    await waitForCompatibilityRuntime(browser, browserName);
  } catch (error) {
    const diagnosis = await browser.execute(() => ({
      openButton: document.querySelector("button.primary.large")?.textContent?.trim(),
      fileInput: Boolean(document.querySelector('input[type="file"][webkitdirectory]')),
      picker: window.__RUSTYERA_COMPAT_PICKER__,
      progress: window.__RUSTYERA_COMPAT_PROGRESS__?.progress,
      state: window.__RUSTYERA_TEST__?.snapshot(),
      status: document.querySelector(".runtime-status")?.textContent,
      viewport: Boolean(document.querySelector(".game-viewport")),
    }));
    throw new Error(`${error.message}; diagnosis=${JSON.stringify(diagnosis)}`);
  }
  compatibilityStage = "validating project progress";
  const projectProgress = await browser.execute(() => {
    const observed = window.__RUSTYERA_COMPAT_PROGRESS__;
    observed?.capture();
    observed?.observer.disconnect();
    const state = window.__RUSTYERA_TEST__?.snapshot();
    return {
      ...observed?.progress,
      cacheHit: state?.logs.some((entry) =>
        String(entry.message).includes("runtime.compiled_cache_hit"),
      ),
    };
  });
  const projectProgressErrors = browserProjectProgressErrors(projectProgress);
  if (projectProgressErrors.length > 0) {
    throw new Error(
      `project progress was incomplete (${projectProgressErrors.join(", ")}): ${JSON.stringify(projectProgress)}`,
    );
  }
  const clickButton = async (label) => {
    compatibilityStage = `clicking ${label}`;
    const button = await browser.$(`//button[normalize-space(.)=${JSON.stringify(label)}]`);
    await button.waitForClickable({ timeout: 30_000 });
    await button.click();
  };
  await clickButton("文件");
  await clickButton("设置…");
  compatibilityStage = "checking font settings";
  const settingsDialog = await browser.$("section[aria-label='RustyEra Web · 设置']");
  await settingsDialog.waitForDisplayed({ timeout: 30_000 });
  await clickButton("显示");
  const gameFont = await settingsDialog.$("#setting-FontName");
  await gameFont.setValue("Manually Entered Font");
  const fontAccess = await browser.execute(() => {
    const input = document.querySelector("#setting-FontName");
    const status = document.querySelector(".font-access-status");
    return {
      inputTag: input?.tagName.toLowerCase(),
      inputType: input?.getAttribute("type"),
      list: input?.getAttribute("list"),
      value: input instanceof HTMLInputElement ? input.value : null,
      status: status?.getAttribute("data-state"),
      statusText: status?.textContent?.trim(),
      options: [...document.querySelectorAll("#available-game-fonts option")].map((option) =>
        option.getAttribute("value"),
      ),
    };
  });
  if (
    fontAccess.inputTag !== "input" ||
    fontAccess.inputType !== "text" ||
    fontAccess.list !== "available-game-fonts" ||
    fontAccess.value !== "Manually Entered Font" ||
    fontAccess.status !== "unsupported" ||
    fontAccess.options.length !== 0
  ) {
    throw new Error(`font picker fallback mismatch: ${JSON.stringify(fontAccess)}`);
  }
  await clickButton("取消");
  const safariSaveWaitId =
    browserName === "safari"
      ? await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().wait?.wait_id ?? null)
      : null;
  await clickButton("[ 0] ----");
  compatibilityStage = "waiting for in-game save";
  await browser.waitUntil(
    () =>
      browser.execute(
        (activeBrowser, previousWaitId) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return (
            state?.phase === "waiting_input" &&
            state.canInteract &&
            (activeBrowser !== "safari" || state.wait?.wait_id !== previousWaitId) &&
            !state.logs.some((entry) =>
              String(entry.message).includes("text save lacks unique code"),
            )
          );
        },
        browserName,
        safariSaveWaitId,
      ),
    { timeout: 30_000, interval: 100, timeoutMsg: "in-game save did not complete" },
  );
  await clickButton("文件");
  await clickButton("导出存档…");
  await (await browser.$("section[aria-label='导出存档']")).waitForDisplayed({ timeout: 30_000 });
  await clickButton("导出");
  compatibilityStage = "receiving exported save";
  const gameSave = await browser.executeAsync(async (done) => {
    try {
      done({ ok: true, download: await window.__RUSTYERA_TEST__.takeDownload(30_000) });
    } catch (error) {
      done({ ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
    }
  });
  if (!gameSave.ok) throw new Error(`in-game save export failed: ${gameSave.error}`);
  if (
    gameSave.download.name !== "save00.sav" ||
    gameSave.download.bytes.length === 0 ||
    JSON.stringify(gameSave.download.bytes.slice(0, 4)) !== JSON.stringify([0xef, 0xbb, 0xbf, 0x34])
  ) {
    throw new Error(`in-game save is empty or malformed: ${JSON.stringify(gameSave.download)}`);
  }
  await browser.execute((bytes) => {
    const nativeInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file" || this.webkitdirectory || !this.accept.includes(".sav")) {
        nativeInputClick.call(this);
        return;
      }
      const file = new File([Uint8Array.from(bytes)], "generated.sav", {
        type: "application/octet-stream",
      });
      Object.defineProperty(this, "files", { configurable: true, value: [file] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
      HTMLInputElement.prototype.click = nativeInputClick;
    };
  }, gameSave.download.bytes);
  await clickButton("文件");
  await clickButton("导入存档…");
  await (await browser.$("section[aria-label='导入存档']")).waitForDisplayed({ timeout: 30_000 });
  await clickButton("选择 .sav 文件…");
  compatibilityStage = "waiting for imported save selection";
  await browser.waitUntil(
    async () =>
      (await browser.$("section[aria-label='导入存档']").getText()).includes("generated.sav"),
    { timeout: 30_000, interval: 100, timeoutMsg: "traditional save file was not selected" },
  );
  const importSlot = await browser.$("section[aria-label='导入存档'] select");
  await importSlot.selectByVisibleText("槽位 01（空）");
  await clickButton("导入");
  compatibilityStage = "waiting for save import";
  const imported = await browser
    .waitUntil(
      () =>
        browser.execute(() => {
          const transfer = window.__RUSTYERA_TEST__?.snapshot().saveTransfer;
          return transfer?.mode == null && !transfer.busy && !transfer.error;
        }),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "traditional save was not imported",
      },
    )
    .then(() => true)
    .catch(() => false);
  if (!imported) {
    const diagnosis = await browser.execute(() => ({
      status: document.querySelector(".runtime-status")?.textContent,
      dialog: document.querySelector("section[aria-label='导入存档']")?.textContent,
      selectedSlot: document.querySelector("section[aria-label='导入存档'] select")?.value,
      state: window.__RUSTYERA_TEST__?.snapshot(),
    }));
    throw new Error(`traditional save was not imported: ${JSON.stringify(diagnosis)}`);
  }
  await clickButton("文件");
  await clickButton("导出存档…");
  await (await browser.$("section[aria-label='导出存档']")).waitForDisplayed({ timeout: 30_000 });
  const exportSlot = await browser.$("section[aria-label='导出存档'] select");
  await exportSlot.selectByVisibleText("槽位 01（已有存档）");
  await clickButton("导出");
  compatibilityStage = "receiving round-trip save";
  await browser.waitUntil(
    () => browser.execute(() => window.__RUSTYERA_TEST_DOWNLOADS__?.[0]?.name === "save01.sav"),
    { timeout: 10_000, interval: 100, timeoutMsg: "round-trip save download was not produced" },
  );
  const exportedSave = await browser.execute(() => {
    const download = window.__RUSTYERA_TEST_DOWNLOADS__?.shift();
    if (!download) return null;
    let hash = 0x811c9dc5;
    for (const byte of download.bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return {
      name: download.name,
      byteLength: download.bytes.length,
      signature: (hash >>> 0).toString(16).padStart(8, "0"),
    };
  });
  if (!exportedSave) throw new Error("traditional save export produced no download");
  const saveTransfer = {
    inGameSave: true,
    imported: true,
    exportedName: exportedSave.name,
    roundTrip: exportedSave.signature === byteSignature(gameSave.download.bytes),
    byteLength: exportedSave.byteLength,
  };
  if (saveTransfer.exportedName !== "save01.sav" || !saveTransfer.roundTrip) {
    throw new Error(`traditional save round trip mismatch: ${JSON.stringify(saveTransfer)}`);
  }
  let tooltip;
  if (checkTooltip) {
    const target = await browser.$("button[data-era-tooltip]");
    await target.waitForDisplayed({ timeout: 20_000 });
    await target.moveTo();
    const floating = await browser.$(".game-tooltip");
    await floating.waitForDisplayed({ timeout: 20_000 });
    tooltip = await browser.execute(() => {
      const element = document.querySelector(".game-tooltip");
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim(),
        role: element.getAttribute("role"),
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        visible: element.getClientRects().length > 0,
      };
    });
    if (
      !tooltip?.visible ||
      tooltip.text !== "button tip\nsecond line" ||
      tooltip.role !== "tooltip"
    ) {
      throw new Error(`tooltip rendering mismatch: ${JSON.stringify(tooltip)}`);
    }
  }
  compatibilityStage = "collecting final compatibility report";
  const observed = await browser.execute(() => ({
    userAgent: navigator.userAgent,
    status: document.querySelector(".runtime-status")?.textContent,
    output: document.querySelector(".game-viewport")?.textContent,
    picker: window.__RUSTYERA_COMPAT_PICKER__,
  }));
  if (!observed.picker?.fallback || !observed.picker.focusBeforeChange) {
    throw new Error(
      `portable directory picker was not exercised: ${JSON.stringify(observed.picker)}`,
    );
  }
  if (browserName === "safari") {
    compatibilityStage = "minimizing Safari automation window";
    minimized = await browser
      .minimizeWindow()
      .then(() => true)
      .catch(() => false);
  }
  console.log(
    JSON.stringify({
      browser: browserName,
      browserVersion: browser.capabilities.browserVersion,
      minimized,
      projectName: setup.projectName,
      opfs: setup.opfs,
      projectProgress,
      fontAccess,
      saveTransfer,
      tooltip,
      ...observed,
    }),
  );
} catch (error) {
  runError = error;
} finally {
  try {
    await snapshotMonitor?.stop();
  } catch (error) {
    snapshotMonitorError = error;
  }
  await browser?.deleteSession().catch(() => {});
  await server?.close().catch(() => {});
}
if (snapshotMonitorError) throw snapshotMonitorError;
if (runError) throw runError;

async function collectFiles(root) {
  const output = [];
  await walk(root, "", output);
  return output;

  async function walk(directory, prefix, target) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, `${relative}/`, target);
      else if (entry.isFile()) {
        target.push({ path: relative, base64: (await readFile(absolute)).toString("base64") });
      }
    }
  }
}

function byteSignature(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function waitForCompatibilityRuntime(browser, browserName) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastReportAt = startedAt;
  let lastSignature;
  let lastObservation;

  while (Date.now() - startedAt < 180_000) {
    const observation = await browser.execute(() => ({
      picker: window.__RUSTYERA_COMPAT_PICKER__,
      progress: window.__RUSTYERA_COMPAT_PROGRESS__?.progress,
      state: window.__RUSTYERA_TEST__?.snapshot(),
      status: document.querySelector(".runtime-status")?.textContent,
      viewport: Boolean(document.querySelector(".game-viewport")),
    }));
    lastObservation = observation;
    const state = observation.state;
    if (state?.fault) {
      throw new Error(`WASM runtime fault: ${JSON.stringify(runtimeProgressDiagnostic(state))}`);
    }
    const rejection = terminalRuntimeRejection(state);
    if (rejection) {
      throw new Error(
        `WASM runtime rejected startup: ${JSON.stringify({
          rejection,
          runtime: runtimeProgressDiagnostic(state),
        })}`,
      );
    }
    if (observation.viewport && state?.phase === "waiting_input" && state.canInteract) return;

    const now = Date.now();
    const signature = JSON.stringify({
      picker: observation.picker,
      progress: observation.progress,
      runtime: runtimeProgressSignature(state),
      viewport: observation.viewport,
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = now;
    }
    if (now - startedAt >= 10_000 && !observation.picker?.fallback && !state?.projectOpen) {
      throw new Error(
        `project directory picker was not exercised within 10000ms: ${JSON.stringify(
          compatibilityDiagnostic(observation),
        )}`,
      );
    }
    if (now - lastProgressAt >= 60_000) {
      throw new Error(
        `WASM startup made no observable progress for ${now - lastProgressAt}ms: ${JSON.stringify(
          compatibilityDiagnostic(observation),
        )}`,
      );
    }
    if (now - lastReportAt >= 15_000) {
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "progress",
          waitingFor: "stable WASM input",
          ...compatibilityDiagnostic(observation),
        }),
      );
      lastReportAt = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `WASM project did not reach a stable input wait within 180000ms: ${JSON.stringify(
      compatibilityDiagnostic(lastObservation),
    )}`,
  );
}

function compatibilityDiagnostic(observation) {
  return {
    picker: observation?.picker,
    progress: observation?.progress,
    runtime: runtimeProgressDiagnostic(observation?.state),
    status: observation?.status,
    viewport: observation?.viewport,
  };
}
