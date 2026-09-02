#!/usr/bin/env node
/* global document, getComputedStyle, HTMLInputElement, HTMLElement, MutationObserver, navigator, window */

import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { remote } from "webdriverio";

import {
  captureCompleteTauriSnapshot,
  startCompleteSnapshotMonitor,
} from "./tauri-test-support.mjs";
import {
  CaptureWriter,
  captureConfiguration,
  prepareCaptureInputs,
} from "./snake-service-capture-io.mjs";
import {
  allowsServiceOracleFault,
  recordServiceOracleWatchdog,
  runServiceOracleCapture,
  webdriverCaptureClient,
} from "./snake-service-capture-client.mjs";
import { createLoopbackViteServer, viteServerPort } from "./vite-test-server.mjs";
import { runSnakeDataClient, SNAKE_DATA_MARKERS } from "./snake-data-test-support.mjs";
import { createLifecycleImageGate } from "./snake-service-lifecycle-gate.mjs";
import { runSnakeServiceLifecycleClient } from "./snake-service-lifecycle-test-support.mjs";
import {
  runSnakeServicesClient,
  runSnakeBatch1Client,
  SNAKE_SERVICE_MARKERS,
} from "./snake-services-test-support.mjs";

import {
  browserProjectProgressErrors,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  nativeFirefoxCapabilities,
  focusNativeBrowser,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  snakeAudioRelations,
  snakeAudioStressRelations,
  terminalRuntimeRejection,
  waitForWebDriverDocument,
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
const projectFileIndex = process.argv.indexOf("--project-file");
if (projectFileIndex >= 0 && !process.argv[projectFileIndex + 1]) {
  throw new Error("--project-file requires a path");
}
const projectFile =
  projectFileIndex >= 0 ? path.resolve(repository, process.argv[projectFileIndex + 1]) : undefined;
const expectedOutputIndex = process.argv.indexOf("--expect-output");
if (expectedOutputIndex >= 0 && !process.argv[expectedOutputIndex + 1])
  throw new Error("--expect-output requires a marker");
const expectedOutput = expectedOutputIndex >= 0 ? process.argv[expectedOutputIndex + 1] : undefined;
const checkTooltip = process.argv.includes("--check-tooltip");
const snakeData = process.argv.includes("--snake-data");
const snakeServiceOracle = process.argv.includes("--snake-service-oracle");
const oracleConfig = snakeServiceOracle
  ? await captureConfiguration(process.argv, project, browserName)
  : undefined;
const oracleInputs = oracleConfig ? await prepareCaptureInputs(oracleConfig) : undefined;
if (snakeData && projectIndex < 0) throw new Error("--snake-data requires --project");
if (snakeData && projectFile) throw new Error("--snake-data requires the source fixture directory");
const snakeServices = process.argv.includes("--snake-services");
const snakeBatch1 = process.argv.includes("--snake-batch1");
const snakeServiceLifecycle = process.argv.includes("--snake-service-lifecycle");
const snakeAudio = process.argv.includes("--snake-audio");
const snakeAudioStress = process.argv.includes("--snake-audio-stress");
const snakeAudioFlow = snakeAudio || snakeAudioStress;
const replacementIndex = process.argv.indexOf("--replacement-project");
const lifecycleReplacement =
  snakeServiceLifecycle && replacementIndex >= 0 && process.argv[replacementIndex + 1]
    ? path.resolve(repository, process.argv[replacementIndex + 1])
    : undefined;
if (
  snakeServiceLifecycle &&
  (!lifecycleReplacement || (await realpath(lifecycleReplacement)) === (await realpath(project)))
)
  throw new Error(
    "lifecycle requires --replacement-project pointing to the distinct successor fixture",
  );
const lifecycleReplacementFiles = lifecycleReplacement
  ? await collectFiles(lifecycleReplacement)
  : undefined;
if (
  Number(snakeData) +
    Number(snakeServices) +
    Number(snakeBatch1) +
    Number(snakeServiceLifecycle) +
    Number(snakeAudio) +
    Number(snakeAudioStress) +
    Number(snakeServiceOracle) >
  1
)
  throw new Error("choose one snake fixture flow");
if (
  (snakeServices || snakeBatch1 || snakeServiceLifecycle || snakeAudioFlow || snakeServiceOracle) &&
  (projectIndex < 0 || projectFile)
)
  throw new Error("snake service flows require --project source directory");
const startupOnly =
  process.argv.includes("--startup-only") ||
  Boolean(expectedOutput) ||
  snakeData ||
  snakeServices ||
  snakeBatch1 ||
  snakeServiceLifecycle ||
  snakeAudioFlow ||
  snakeServiceOracle;
const cacheInputSmoke = process.argv.includes("--cache-input-smoke");
const logInputSmoke = process.argv.includes("--log-input-smoke");
const settingsHotApply = process.argv.includes("--settings-hot-apply");
const files = await collectFiles(project);
if (projectIndex < 0) {
  const oracle = files.find((entry) => entry.path.toLowerCase() === "erb/oracle.erb");
  if (!oracle) throw new Error("browser compatibility fixture lacks erb/oracle.erb");
  oracle.base64 = Buffer.from(
    injectInteractionAssistFlow(
      injectInGameSaveFlow(Buffer.from(oracle.base64, "base64").toString("utf8")),
    ),
  ).toString("base64");
}
let server;
let browser;
let snapshotMonitor;
let snapshotMonitorError;
let runError;
let compatibilityStage = "starting browser session";
const snapshotDirectory = path.join(
  repository,
  ".rustyera",
  "test-runs",
  `browser-compat-${browserName}-${Date.now()}`,
);
const snapshotPath = path.join(snapshotDirectory, "snapshots.ndjson");
mkdirSync(snapshotDirectory, { recursive: true });
console.log(JSON.stringify({ browser: browserName, type: "snapshot-log", path: snapshotPath }));

function reportCompatibilityStage(stage) {
  compatibilityStage = stage;
  console.log(JSON.stringify({ browser: browserName, type: "browser-compat-stage", stage }));
}

async function persistCompatibilityEvidence(name, packet) {
  const directory = path.join(snapshotDirectory, name);
  mkdirSync(directory);
  const writer = new CaptureWriter(directory);
  try {
    await writer.record(packet);
    return { ...(await writer.close()), path: writer.path };
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

try {
  server = await createLoopbackViteServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
    plugins:
      browserName === "safari" && projectFile ? [safariProjectFilePlugin(projectFile)] : undefined,
  });
  const port = viteServerPort(server);
  if (
    snakeServiceOracle &&
    browserName === "safari" &&
    (await realpath(oracleConfig.clientArtifact)) !==
      (await realpath("/Applications/Safari.app/Contents/MacOS/Safari"))
  )
    throw new Error("Safari capture artifact must identify the installed Safari executable");
  // Real window blur cannot be established in a headless session. Other flows keep their default.
  const firefoxCapabilities = nativeFirefoxCapabilities(process.platform, {
    headless: !snakeServiceLifecycle,
  });
  if (snakeServiceOracle && browserName === "firefox")
    firefoxCapabilities["moz:firefoxOptions"] = {
      ...firefoxCapabilities["moz:firefoxOptions"],
      binary: oracleConfig.clientArtifact,
    };
  browser = await remote({
    logLevel: "warn",
    connectionRetryTimeout: 20_000,
    connectionRetryCount: 1,
    capabilities:
      browserName === "firefox"
        ? firefoxCapabilities
        : {
            browserName: "safari",
            "wdio:enforceWebDriverClassic": true,
          },
  });
  if (browserName === "safari") {
    compatibilityStage = "restoring Safari automation window";
    await browser.maximizeWindow().catch(() => undefined);
    // SafariDriver can report maximize success while a window minimized by the previous run stays
    // non-interactive. Setting a concrete rect restores it according to the WebDriver window API.
    await browser.setWindowSize(1280, 900);
  }
  console.log(
    JSON.stringify({
      browser: browserName,
      type: "webdriver-transport",
      bidi: false,
      capabilities: browser.capabilities,
    }),
  );
  compatibilityStage = "navigating to compatibility client";
  const targetUrl = `http://127.0.0.1:${port}`;
  await browser.url(targetUrl);
  compatibilityStage = "waiting for compatibility document";
  const documentReady = await waitForWebDriverDocument(browser, targetUrl, {
    timeoutMs: 5_000,
    stage: compatibilityStage,
  });
  console.log(JSON.stringify({ browser: browserName, type: "document-ready", ...documentReady }));
  snapshotMonitor = startCompleteSnapshotMonitor(browser, {
    eventType: "browser-compat-snapshot",
    label: `${browserName} compatibility`,
    snapshotContext: () => ({ stage: compatibilityStage }),
    allowFault: () => snakeServiceOracle && allowsServiceOracleFault(),
    onSnapshot: (snapshot) =>
      snakeServiceOracle ? recordServiceOracleWatchdog(snapshot) : undefined,
    output(line) {
      appendFileSync(snapshotPath, `${line}\n`);
      const snapshot = JSON.parse(line);
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "browser-compat-snapshot-summary",
          path: snapshotPath,
          capturedAt: snapshot.capturedAt,
          stage: snapshot.operation?.stage,
          phase: snapshot.runtime?.phase,
          status: snapshot.runtime?.status,
          projectOpen: snapshot.runtime?.projectOpen,
          fault: snapshot.runtime?.fault ?? null,
        }),
      );
    },
  });
  void snapshotMonitor.failure.catch(async (error) => {
    snapshotMonitorError = error;
    await browser?.deleteSession().catch(() => undefined);
  });
  if (browserName === "safari" || snakeServiceLifecycle) {
    compatibilityStage = "establishing native browser foreground";
    await focusNativeBrowser(browser, browserName);
  }
  compatibilityStage = "waiting for frontend test control";
  await browser.waitUntil(
    () => browser.execute(() => typeof window.__RUSTYERA_TEST__?.snapshot === "function"),
    {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: "frontend test control was not installed after document readiness",
    },
  );
  compatibilityStage = "clearing OPFS for cold startup";
  const opfsReset = await browser.executeAsync(async (done) => {
    try {
      if (typeof navigator.storage.getDirectory !== "function") {
        done({ ok: false, error: "OPFS is unavailable" });
        return;
      }
      const root = await navigator.storage.getDirectory();
      const removed = [];
      for await (const [name] of root.entries()) {
        removed.push(name);
        await root.removeEntry(name, { recursive: true });
      }
      const remaining = [];
      for await (const [name] of root.entries()) remaining.push(name);
      done({ ok: remaining.length === 0, available: true, removed, remaining, cold: true });
    } catch (error) {
      done({
        ok: false,
        available: typeof navigator.storage.getDirectory === "function",
        error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      });
    }
  });
  if (!opfsReset.ok || !opfsReset.cold || opfsReset.remaining?.length) {
    throw new Error(`failed to clear OPFS for cold startup: ${JSON.stringify(opfsReset)}`);
  }
  console.log(JSON.stringify({ browser: browserName, type: "opfs-reset", ...opfsReset }));
  compatibilityStage = "checking browser startup guidance";
  const startupGuidance = await browser.execute(() => ({
    directProjectDirectoryAccess: typeof window.showDirectoryPicker === "function",
    hints: [...document.querySelectorAll(".welcome .hint")].map((hint) => hint.textContent?.trim()),
  }));
  if (
    startupGuidance.directProjectDirectoryAccess ||
    startupGuidance.hints.length !== 1 ||
    startupGuidance.hints[0] !== "该浏览器不支持文件系统访问API，启动性能会受影响"
  ) {
    throw new Error(`browser startup guidance mismatch: ${JSON.stringify(startupGuidance)}`);
  }
  const globalPreferencesBeforeProject = await verifyGlobalPreferencesBeforeProject(browser);
  console.log(
    JSON.stringify({
      browser: browserName,
      type: "global-preferences-before-project",
      ...globalPreferencesBeforeProject,
    }),
  );
  let minimized = false;
  reportCompatibilityStage(
    projectFile ? "installing packaged project picker" : "installing portable project picker",
  );
  const setup = projectFile
    ? await installPackagedProjectPicker(
        browser,
        projectFile,
        browserName === "safari" ? "/__rustyera_compat_project_file" : undefined,
      )
    : await installPortableProjectPicker(browser, project, files);
  if (!setup.ok) throw new Error(`browser project import failed: ${setup.error}`);
  reportCompatibilityStage("project picker installed");

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
      if (state?.canInteract || state?.status === "游戏运行中") {
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

  if (snakeData || snakeAudioFlow || snakeServiceOracle) {
    reportCompatibilityStage("configuring snake test runtime");
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
  }
  const openSelector = projectFile
    ? "//button[normalize-space(.)='从项目文件启动…']"
    : "button.primary.large";
  reportCompatibilityStage(
    projectFile
      ? "waiting for packaged project open control"
      : "waiting for fixture project open control",
  );
  const open = await browser.$(openSelector);
  await open.waitForClickable({ timeout: 30_000 });
  reportCompatibilityStage(projectFile ? "opening packaged project" : "opening fixture project");
  await clickElement(browser, open);
  let projectPreferencesDuringLoad;
  let projectPreferencesAfterLoad;
  if (projectFile) {
    compatibilityStage = "uploading packaged project";
    const input = await browser.$('input[type="file"][accept*=".reraproj"]');
    await input.waitForExist({ timeout: 5_000 });
    if (browserName === "safari") {
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const picker = window.__RUSTYERA_COMPAT_PICKER__;
            if (picker?.error) throw new Error(picker.error);
            return picker?.injected === true;
          }),
        {
          timeout: 30_000,
          interval: 50,
          timeoutMsg: "Safari project file injection did not complete",
        },
      );
    } else {
      // setValue clears first, which GeckoDriver rejects for the intentionally hidden fallback
      // input. addValue sends the local file path through the native file-upload command directly.
      await input.addValue(projectFile);
    }
    if (!startupOnly)
      projectPreferencesDuringLoad = await exerciseProjectPreferencesDuringLoad(browser);
  }
  let snakeAudioResult;
  try {
    if (snakeAudioFlow) {
      compatibilityStage = snakeAudioStress
        ? "validating snake audio provider stress relations"
        : "validating snake audio provider relations";
      await browser.waitUntil(
        async () => {
          const state = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
          if (state?.fault) throw new Error(JSON.stringify(state.fault));
          const relations = (snakeAudioStress ? snakeAudioStressRelations : snakeAudioRelations)({
            output: state?.output,
            frontend: state,
          });
          snakeAudioResult = { state, relations };
          return Object.values(relations).every(Boolean);
        },
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: () =>
            `snake audio${snakeAudioStress ? " stress" : ""} relations failed: ${JSON.stringify(snakeAudioResult?.relations)}`,
        },
      );
    } else await waitForCompatibilityRuntime(browser, browserName);
  } catch (error) {
    const diagnosis = await browser.execute(() => ({
      openButton: document.querySelector("button.primary.large")?.textContent?.trim(),
      fileInputs: [...document.querySelectorAll('input[type="file"]')].map((input) => ({
        accept: input.getAttribute("accept"),
        directory: input.hasAttribute("webkitdirectory"),
        multiple: input.hasAttribute("multiple"),
      })),
      picker: window.__RUSTYERA_COMPAT_PICKER__,
      progress: window.__RUSTYERA_COMPAT_PROGRESS__?.progress,
      state: window.__RUSTYERA_TEST__?.snapshot(),
      status: document.querySelector(".runtime-status")?.textContent,
      viewport: Boolean(document.querySelector(".game-viewport")),
    }));
    throw new Error(`${error.message}; diagnosis=${JSON.stringify(diagnosis)}`);
  }
  if (snakeData) {
    compatibilityStage = "running snake data integration through the visible input";
    const observed = await runSnakeDataClient(browser, "browser");
    console.log(
      JSON.stringify({
        browser: browserName,
        type: "snake-data-integration",
        verified: SNAKE_DATA_MARKERS,
        output: observed.output,
        bridgeKind: observed.bridgeKind,
        displayState: observed.displayState,
      }),
    );
  }
  if (snakeServices || snakeBatch1) {
    compatibilityStage = "running snake services through visible controls";
    const observed = await (snakeBatch1 ? runSnakeBatch1Client : runSnakeServicesClient)(
      browser,
      "browser",
    );
    console.log(
      JSON.stringify({
        browser: browserName,
        type: snakeBatch1 ? "snake-batch1-integration" : "snake-service-integration",
        verified: SNAKE_SERVICE_MARKERS,
        output: observed.output,
        bridgeKind: observed.bridgeKind,
      }),
    );
  }
  if (snakeAudioFlow) {
    console.log(
      JSON.stringify({
        browser: browserName,
        type: snakeAudioStress ? "snake-audio-stress-integration" : "snake-audio-integration",
        relations: snakeAudioResult.relations,
        audioProvider: snakeAudioResult.state.audioProvider,
        audioPlayback: snakeAudioResult.state.audioPlayback,
      }),
    );
  }
  if (expectedOutput) {
    compatibilityStage = `checking output marker ${expectedOutput}`;
    await browser.waitUntil(
      () =>
        browser.execute((marker) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          if (state?.fault) throw new Error(JSON.stringify(state.fault));
          return state?.canInteract && state.output.some((line) => String(line).includes(marker));
        }, expectedOutput),
      { timeout: 10_000, interval: 100, timeoutMsg: `missing output marker ${expectedOutput}` },
    );
  }
  if (projectFile && !startupOnly)
    projectPreferencesAfterLoad = await verifyProjectPreferencesAfterLoad(browser);
  compatibilityStage = "validating project progress";
  const projectProgress = await browser.execute(() => {
    const observed = window.__RUSTYERA_COMPAT_PROGRESS__;
    observed?.capture();
    observed?.observer.disconnect();
    const state = window.__RUSTYERA_TEST__?.snapshot();
    const picker = window.__RUSTYERA_COMPAT_PICKER__;
    return {
      ...observed?.progress,
      cacheHit: state?.logs.some((entry) =>
        String(entry.message).includes("runtime.compiled_cache_hit"),
      ),
      portableImport: {
        fallback: picker?.fallback,
        focusBeforeChange: picker?.focusBeforeChange,
        directoryPicker: picker?.attempts.some((attempt) => attempt.isDirectoryPicker),
      },
      startupTelemetry: state?.startupTelemetry,
    };
  });
  projectProgress.projectPreferencesDuringLoad = projectPreferencesDuringLoad;
  projectProgress.projectPreferencesAfterLoad = projectPreferencesAfterLoad;
  const projectProgressErrors = projectFile
    ? packagedProjectProgressErrors(projectProgress, !startupOnly)
    : browserProjectProgressErrors(projectProgress);
  if (projectProgressErrors.length > 0) {
    throw new Error(
      `project progress was incomplete (${projectProgressErrors.join(", ")}): ${JSON.stringify(projectProgress)}`,
    );
  }
  if (cacheInputSmoke || logInputSmoke) {
    await runCacheInputSmoke(browser, browserName, projectProgress, setup, opfsReset);
    if (logInputSmoke) await runLogInputSmoke(browser, browserName);
  } else if (startupOnly) {
    compatibilityStage = "collecting cold-start report";
    const observed = await collectCompatibilityReport(browser);
    if (projectFile) assertPackagedStartup(observed.startupTelemetry);
    else assertColdStartup(observed.startupTelemetry);
    if (snakeServiceLifecycle) {
      // Keep the initial cold-start proof separate from the intentional later restart telemetry.
      compatibilityStage =
        "running snake service lifecycle through real pointer, keyboard and window actions";
      const gate = await createLifecycleImageGate(project);
      try {
        const lifecycle = await runSnakeServiceLifecycleClient(browser, "browser", {
          gate,
          prepareReplacement: async () => {
            const selection = await installPortableProjectPicker(
              browser,
              lifecycleReplacement,
              lifecycleReplacementFiles,
            );
            if (!selection.ok)
              throw new Error(`independent lifecycle picker failed: ${selection.error}`);
          },
        });
        // Driver warnings share stdout, so the complete result must have its own file.
        const artifact = await persistCompatibilityEvidence("lifecycle", {
          browser: browserName,
          type: "snake-service-lifecycle",
          ...lifecycle,
        });
        console.log(
          JSON.stringify({ browser: browserName, type: "snake-service-lifecycle", artifact }),
        );
      } finally {
        console.log(JSON.stringify({ type: "lifecycle-image-stream", ...gate.status() }));
        await gate.close();
      }
    }
    if (snakeServiceOracle) {
      compatibilityStage = "capturing exact service oracle case through the real input";
      const capture = await runServiceOracleCapture(
        webdriverCaptureClient(browser),
        oracleConfig,
        oracleInputs,
      );
      console.log(JSON.stringify({ type: "snake-service-oracle-capture", ...capture }));
      if (capture.status === "captured_with_observation_blocks") process.exitCode = 2;
    }
    console.log(
      JSON.stringify({
        browser: browserName,
        browserVersion: browser.capabilities.browserVersion,
        minimized,
        projectName: setup.projectName,
        projectFile,
        opfs: setup.opfs,
        opfsReset,
        startupGuidance,
        projectProgress,
        startupOnly: true,
        expectedOutput,
        ...observed,
      }),
    );
  } else {
    const clickButton = async (label) => {
      compatibilityStage = `clicking ${label}`;
      const button = await browser.$(`//button[normalize-space(.)=${JSON.stringify(label)}]`);
      await button.waitForClickable({ timeout: 30_000 });
      await clickElement(browser, button);
    };
    compatibilityStage = "checking automatic interaction assistance";
    const automaticInteractionAssist = await inspectAutomaticInteractionAssist(browser);
    compatibilityStage = "enabling interaction assistance";
    await enableGlobalInteractionAssist(browser);
    compatibilityStage = "checking the interaction assistance panel";
    const interactionAssist = await inspectInteractionAssistPanel(browser);
    console.log(
      JSON.stringify({ browser: browserName, automaticInteractionAssist, interactionAssist }),
    );
    for (const action of [
      { menuLabel: "重新开始", title: "重新开始游戏" },
      { menuLabel: "返回标题", title: "返回标题" },
    ]) {
      const beforeConfirmation = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      await clickFileMenuAction(browser, action.menuLabel);
      compatibilityStage = `checking ${action.title} confirmation`;
      const confirmation = await browser.$(`section[aria-label='${action.title}']`);
      await confirmation.waitForDisplayed({ timeout: 30_000 });
      if (!(await confirmation.getText()).includes("可能会丢失尚未保存的游戏进度")) {
        throw new Error(`${action.title} confirmation did not warn about progress loss`);
      }
      const cancelled = await browser.execute((title) => {
        const dialog = document.querySelector(`section[aria-label='${title}']`);
        const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
          (candidate) => candidate.textContent?.trim() === "取消",
        );
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      }, action.title);
      if (!cancelled) throw new Error(`${action.title} confirmation has no cancel button`);
      await confirmation.waitForDisplayed({ reverse: true, timeout: 30_000 });
      const afterCancellation = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      if (
        afterCancellation.runtimeEpoch !== beforeConfirmation.runtimeEpoch ||
        afterCancellation.presentationRevision !== beforeConfirmation.presentationRevision ||
        JSON.stringify(afterCancellation.output) !== JSON.stringify(beforeConfirmation.output)
      ) {
        throw new Error(`${action.title} cancellation changed the running game`);
      }
    }
    await clickFileMenuAction(browser, "项目设置…");
    compatibilityStage = "checking font settings";
    const settingsDialog = await browser.$("section[aria-label='RustyEra Web · 项目设置']");
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
    if (settingsHotApply) {
      compatibilityStage = "waiting for the OPFS project cache before applying settings";
      await browser.waitUntil(async () => (await inspectOpfsProjectCache(browser)).exists, {
        timeout: 120_000,
        interval: 250,
        timeoutMsg: "OPFS compiled-project.reracache was not generated",
      });
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const state = window.__RUSTYERA_TEST__?.snapshot();
            return state?.transfer?.export == null && state.status === "游戏运行中";
          }),
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: "compiled-cache feedback did not restore the stable status",
        },
      );
      const cacheBeforeSettings = await inspectOpfsProjectCache(browser);
      compatibilityStage = "hot-applying browser font settings";
      await gameFont.setValue("monospace");
      await settingsDialog.$("#setting-FontSize").setValue("19");
      await clickButton("应用");
      await browser.waitUntil(
        () =>
          browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().status === "项目设置已应用"),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "settings completion feedback was not displayed",
        },
      );
      await browser.waitUntil(
        () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().status === "游戏运行中"),
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "settings completion feedback did not restore the stable status",
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const viewport = document.querySelector(".game-viewport");
            if (!(viewport instanceof HTMLElement)) return null;
            const style = getComputedStyle(viewport);
            return style.fontFamily === "monospace" && style.fontSize === "19px";
          }),
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: "browser did not hot-apply the saved game font",
        },
      );
      compatibilityStage = "checking the refreshed OPFS project cache";
      await browser.waitUntil(
        async () => {
          const cache = await inspectOpfsProjectCache(browser, cacheBeforeSettings.size);
          const appendedBytes = cache.size - cacheBeforeSettings.size;
          return (
            cache.exists &&
            ((cache.hasConfigurationJournal &&
              cache.prefixDigest === cacheBeforeSettings.prefixDigest &&
              appendedBytes > 0 &&
              appendedBytes < 4_096) ||
              cache.prefixDigest !== cacheBeforeSettings.prefixDigest ||
              cache.size !== cacheBeforeSettings.size)
          );
        },
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: "browser did not append the reraconfig transaction to its OPFS cache",
        },
      );
      const cacheAfterSettings = await inspectOpfsProjectCache(browser, cacheBeforeSettings.size);
      const appendedBytes = cacheAfterSettings.size - cacheBeforeSettings.size;
      const cacheUpdate =
        cacheAfterSettings.hasConfigurationJournal &&
        cacheAfterSettings.prefixDigest === cacheBeforeSettings.prefixDigest &&
        appendedBytes > 0 &&
        appendedBytes < 4_096
          ? "journal"
          : "rebuilt";
      console.log(
        JSON.stringify({
          browser: browserName,
          settingsHotApply: true,
          fontFamily: "monospace",
          fontSize: "19px",
          cacheUpdate,
          opfsProjectCacheBytes: cacheAfterSettings.size,
          opfsProjectCacheAppendBytes: appendedBytes,
        }),
      );
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
    await clickFileMenuAction(browser, "导出操作序列…");
    compatibilityStage = "receiving exported operation sequence";
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(
            window.__RUSTYERA_TEST_DOWNLOADS__?.some((download) =>
              /^input-replay_\d{8}-\d{6}\.jsonl$/.test(download.name),
            ),
          ),
        ),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "operation sequence download was not produced",
      },
    );
    const operationSequence = await browser.execute(() => {
      const index = window.__RUSTYERA_TEST_DOWNLOADS__?.findIndex((download) =>
        /^input-replay_\d{8}-\d{6}\.jsonl$/.test(download.name),
      );
      if (index == null || index < 0) return { ok: false, error: "download disappeared" };
      const [download] = window.__RUSTYERA_TEST_DOWNLOADS__.splice(index, 1);
      try {
        const records = new TextDecoder()
          .decode(download.bytes)
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        return { ok: true, name: download.name, records };
      } catch (error) {
        return {
          ok: false,
          error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
        };
      }
    });
    if (
      !operationSequence.ok ||
      !/^input-replay_\d{8}-\d{6}\.jsonl$/.test(operationSequence.name) ||
      operationSequence.records?.[0]?.record !== "header" ||
      operationSequence.records?.[0]?.fidelity !== "manual_path"
    ) {
      throw new Error(
        `operation sequence export is malformed: ${JSON.stringify(operationSequence)}`,
      );
    }
    await clickFileMenuAction(browser, "导出存档…");
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
      JSON.stringify(gameSave.download.bytes.slice(0, 4)) !==
        JSON.stringify([0xef, 0xbb, 0xbf, 0x34])
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
    await clickFileMenuAction(browser, "导入存档…");
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
    await clickFileMenuAction(browser, "导出存档…");
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
      startupTelemetry: window.__RUSTYERA_TEST__?.snapshot().startupTelemetry,
    }));
    assertColdStartup(observed.startupTelemetry);
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
        opfsReset,
        startupGuidance,
        projectProgress,
        fontAccess,
        operationSequence,
        saveTransfer,
        tooltip,
        ...observed,
      }),
    );
  }
} catch (error) {
  // Preserve a failure between periodic ticks before disposing the native session.
  try {
    let snapshot, snapshotError;
    try {
      snapshot = await captureCompleteTauriSnapshot(browser);
    } catch (cause) {
      snapshotError = String(cause);
    }
    const artifact = await persistCompatibilityEvidence("failure", {
      browser: browserName,
      stage: compatibilityStage,
      error: String(error),
      lifecycleEvidence: error?.lifecycleEvidence,
      snapshot,
      snapshotError,
    });
    console.error(JSON.stringify({ type: "browser-compat-failure-artifact", artifact }));
  } catch (cause) {
    console.error(JSON.stringify({ type: "failure-artifact-error", error: String(cause) }));
  }
  console.error(
    JSON.stringify({
      browser: browserName,
      type: "browser-compat-error",
      stage: compatibilityStage,
      name: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 2_000),
    }),
  );
  runError = error;
} finally {
  await browser
    ?.execute(() => {
      window.__RUSTYERA_COMPAT_PICKER_CLEANUP__?.();
      window.__RUSTYERA_COMPAT_PROGRESS__?.observer.disconnect();
    })
    .catch(() => {});
  try {
    await snapshotMonitor?.stop();
  } catch (error) {
    console.error(
      JSON.stringify({
        browser: browserName,
        type: "browser-compat-monitor-error",
        stage: compatibilityStage,
        name: error?.name ?? "Error",
        message: String(error?.message ?? error).slice(0, 2_000),
      }),
    );
    snapshotMonitorError = error;
  }
  await browser?.deleteSession().catch(() => {});
  await server?.close().catch(() => {});
}

function safariProjectFilePlugin(selectedProjectFile) {
  return {
    name: "rustyera-safari-project-file",
    configureServer(viteServer) {
      viteServer.middlewares.use("/__rustyera_compat_project_file", (request, response, next) => {
        if (request.method !== "GET") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/octet-stream");
        createReadStream(selectedProjectFile)
          .on("error", (error) => response.destroy(error))
          .pipe(response);
      });
    },
  };
}

async function installPackagedProjectPicker(activeBrowser, selectedProjectFile, browserFetchUrl) {
  return activeBrowser.executeAsync(
    async (projectName, projectUrl, done) => {
      try {
        const nativeCreateElement = document.createElement;
        const pickerDescriptor = Object.getOwnPropertyDescriptor(window, "showOpenFilePicker");
        const fetchController = new AbortController();
        const picker = {
          fallback: true,
          focusBeforeChange: false,
          attempts: [],
          browserFetch: Boolean(projectUrl),
          injected: false,
          error: null,
        };
        const restoreCreateElement = () => {
          document.createElement = nativeCreateElement;
        };
        window.__RUSTYERA_COMPAT_PICKER_CLEANUP__ = () => {
          fetchController.abort();
          restoreCreateElement();
          if (pickerDescriptor)
            Object.defineProperty(window, "showOpenFilePicker", pickerDescriptor);
          else delete window.showOpenFilePicker;
        };
        Object.defineProperty(window, "showOpenFilePicker", {
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
              const isProjectFilePicker =
                element.type === "file" &&
                !element.multiple &&
                element.accept.includes(".reraproj");
              picker.attempts.push({
                accept: element.accept,
                isProjectFilePicker,
                multiple: element.multiple,
                type: element.type,
              });
              if (!isProjectFilePicker) {
                nativeClick();
                return;
              }
              picker.focusBeforeChange = true;
              window.dispatchEvent(new Event("focus"));
              if (projectUrl) {
                void fetch(projectUrl, { signal: fetchController.signal })
                  .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.arrayBuffer();
                  })
                  .then((bytes) => {
                    const file = new File([bytes], projectName, {
                      type: "application/octet-stream",
                    });
                    Object.defineProperty(element, "files", { configurable: true, value: [file] });
                    element.dispatchEvent(new Event("change", { bubbles: true }));
                    picker.injected = true;
                    restoreCreateElement();
                  })
                  .catch((error) => {
                    if (error?.name !== "AbortError") picker.error = String(error);
                  });
                return;
              }
              element.addEventListener("change", restoreCreateElement, { once: true });
            },
          });
          return element;
        };
        window.__RUSTYERA_COMPAT_PICKER__ = picker;
        done({
          ok: true,
          projectName,
          opfs: typeof navigator.storage.getDirectory === "function",
        });
      } catch (error) {
        done({ ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
      }
    },
    path.basename(selectedProjectFile),
    browserFetchUrl,
  );
}

async function installPortableProjectPicker(activeBrowser, selectedProject, files) {
  await activeBrowser.execute(() => {
    window.__RUSTYERA_COMPAT_SELECTED__ = [];
    window.__RUSTYERA_COMPAT_PAYLOADS__ = new Map();
    window.__RUSTYERA_COMPAT_BATCH__ = 0;
  });
  const projectName = path.basename(selectedProject);
  for (const batch of portableFileBatches(files)) {
    await activeBrowser.execute(
      (entries, selectedProjectName) => {
        const selected = window.__RUSTYERA_COMPAT_SELECTED__;
        const payloads = window.__RUSTYERA_COMPAT_PAYLOADS__;
        for (const entry of entries) {
          const chunks = payloads.get(entry.path) ?? [];
          const raw = atob(entry.base64);
          chunks.push(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
          if (!entry.final) {
            payloads.set(entry.path, chunks);
            continue;
          }
          payloads.delete(entry.path);
          const file = new File(chunks, entry.path.split("/").at(-1));
          Object.defineProperty(file, "webkitRelativePath", {
            value: `${selectedProjectName}/${entry.path}`,
          });
          selected.push(file);
        }
        window.__RUSTYERA_COMPAT_BATCH__ += 1;
        document.documentElement.dataset.rustyeraTestFileBatch = `${window.__RUSTYERA_COMPAT_BATCH__}:${selected.length}:${payloads.size}`;
      },
      batch,
      projectName,
    );
  }
  return activeBrowser.executeAsync(async (selectedProjectName, done) => {
    try {
      const selected = window.__RUSTYERA_COMPAT_SELECTED__;
      const nativeCreateElement = document.createElement;
      const pickerDescriptor = Object.getOwnPropertyDescriptor(window, "showDirectoryPicker");
      const picker = {
        fallback: false,
        focusBeforeChange: false,
        confirmationDelayMs: 50,
        attempts: [],
      };
      const restoreCreateElement = () => {
        document.createElement = nativeCreateElement;
      };
      window.__RUSTYERA_COMPAT_PICKER_CLEANUP__ = () => {
        restoreCreateElement();
        if (pickerDescriptor)
          Object.defineProperty(window, "showDirectoryPicker", pickerDescriptor);
        else delete window.showDirectoryPicker;
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
              Object.defineProperty(element, "files", { configurable: true, value: selected });
              element.dispatchEvent(new Event("change", { bubbles: true }));
              restoreCreateElement();
            }, picker.confirmationDelayMs);
          },
        });
        return element;
      };
      window.__RUSTYERA_COMPAT_PICKER__ = picker;
      delete document.documentElement.dataset.rustyeraTestFileBatch;
      delete window.__RUSTYERA_COMPAT_BATCH__;
      delete window.__RUSTYERA_COMPAT_PAYLOADS__;
      done({
        ok: true,
        projectName: selectedProjectName,
        opfs: typeof navigator.storage.getDirectory === "function",
      });
    } catch (error) {
      done({ ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
    }
  }, projectName);
}

async function exerciseProjectPreferencesDuringLoad(activeBrowser) {
  compatibilityStage = "waiting for packaged project preference availability";
  await activeBrowser.waitUntil(
    () =>
      activeBrowser.execute(() => {
        const state = window.__RUSTYERA_TEST__?.snapshot();
        return state?.projectOpen === true && state?.projectLoading === true;
      }),
    {
      timeout: 30_000,
      interval: 25,
      timeoutMsg: "project preferences did not become available during project loading",
    },
  );
  await clickFileMenuAction(activeBrowser, "偏好设置…");
  const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
  await dialog.waitForDisplayed({ timeout: 5_000 });
  const projectTab = await dialog.$("#preference-tab-project");
  const projectTabEnabled = await projectTab.isEnabled();
  if (!projectTabEnabled) throw new Error("project preference tab was disabled during loading");
  await clickElement(activeBrowser, projectTab);
  const field = await dialog.$("#preference-project-UseMouse-override");
  await field.waitForEnabled({ timeout: 5_000 });
  const projectFieldEditable = await field.isEnabled();
  if (!(await field.isSelected())) await clickElement(activeBrowser, field);
  await clickElement(activeBrowser, await dialog.$("button=应用"));
  await dialog.waitForDisplayed({ reverse: true, timeout: 30_000 });
  return {
    observedLoading: true,
    dialogOpened: true,
    projectTabEnabled,
    projectFieldEditable,
    saveSubmitted: true,
    saveCompleted: true,
  };
}

async function verifyProjectPreferencesAfterLoad(activeBrowser) {
  compatibilityStage = "verifying packaged project preferences after load";
  await clickFileMenuAction(activeBrowser, "偏好设置…");
  const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
  await dialog.waitForDisplayed({ timeout: 5_000 });
  const projectTab = await dialog.$("#preference-tab-project");
  const projectTabEnabled = await projectTab.isEnabled();
  if (!projectTabEnabled) throw new Error("project preference tab was disabled after game load");
  await clickElement(activeBrowser, projectTab);
  const field = await dialog.$("#preference-project-UseMouse-override");
  await field.waitForEnabled({ timeout: 5_000 });
  const projectFieldEditable = await field.isEnabled();
  const savedOverrideSelected = await field.isSelected();
  await clickElement(activeBrowser, await dialog.$("button=取消"));
  await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
  return { projectTabEnabled, projectFieldEditable, savedOverrideSelected };
}

async function inspectInteractionAssistPanel(activeBrowser) {
  const panel = await activeBrowser.$("section[aria-label='交互辅助面板']");
  await panel.waitForDisplayed({ timeout: 30_000 });
  const firstAction = await panel.$(".interaction-assist-action");
  await firstAction.waitForClickable({ timeout: 30_000 });
  const before = await activeBrowser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    return {
      height: viewport?.getBoundingClientRect().height,
      scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
    };
  });
  await clickElement(activeBrowser, await panel.$("button[aria-label='展开']"));
  const expanded = await activeBrowser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const panel = document.querySelector("section[aria-label='交互辅助面板']");
    const actions = [...document.querySelectorAll(".interaction-assist-action")];
    return {
      viewportHeight: viewport?.getBoundingClientRect().height,
      viewportScrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
      panelHeight: panel?.getBoundingClientRect().height,
      actionCount: actions.length,
      firstLabel: actions[0]?.getAttribute("aria-label"),
      expanded: panel?.classList.contains("expanded"),
    };
  });
  if (
    !expanded.expanded ||
    expanded.actionCount < 1 ||
    !expanded.firstLabel ||
    Math.abs(expanded.viewportHeight - before.height) > 0.5 ||
    expanded.viewportScrollTop !== before.scrollTop ||
    expanded.panelHeight > before.height * 0.75 + 0.5
  ) {
    throw new Error(
      `interaction assistance panel geometry mismatch: ${JSON.stringify({ before, expanded })}`,
    );
  }
  await clickElement(activeBrowser, await panel.$("button[aria-label='折叠']"));
  return { before, expanded };
}

async function inspectAutomaticInteractionAssist(activeBrowser) {
  const original = await activeBrowser.getWindowSize();
  const desktop = { width: Math.max(1024, original.width), height: Math.max(800, original.height) };
  await activeBrowser.setWindowSize(desktop.width, desktop.height);
  const panel = await activeBrowser.$("section[aria-label='交互辅助面板']");
  await panel.waitForDisplayed({ reverse: true, timeout: 5_000 });

  const mobile = { width: 600, height: 800 };
  await activeBrowser.setWindowSize(mobile.width, mobile.height);
  await panel.waitForDisplayed({ timeout: 5_000 });
  const mobileState = await activeBrowser.execute(() => ({
    visible: document.querySelector("section[aria-label='交互辅助面板']")?.ariaHidden === "false",
  }));
  if (!mobileState.visible)
    throw new Error(
      `automatic interaction assistance did not enable on mobile: ${JSON.stringify(mobileState)}`,
    );

  await activeBrowser.setWindowSize(desktop.width, desktop.height);
  await panel.waitForDisplayed({ reverse: true, timeout: 5_000 });
  return { desktop, mobile, mobileState };
}

async function clickFileMenuAction(activeBrowser, label) {
  const menuButton = await activeBrowser.$("#menu-file");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    compatibilityStage = `opening 文件 menu for ${label} (attempt ${attempt})`;
    // Projects can hide the menu bar until hover. Safari may otherwise dispatch the click
    // while the 120 ms reveal transform is still moving the button under the pointer. Safari's
    // in-page click does not need pointer geometry, and SafariDriver moveTo can block its command
    // queue long enough to starve the complete-snapshot monitor.
    if (browserName !== "safari") {
      await menuButton.moveTo();
      await activeBrowser.pause(200);
    }
    await menuButton.waitForDisplayed({ timeout: 2_000 });
    if ((await menuButton.getAttribute("aria-expanded")) !== "true")
      await clickElement(activeBrowser, menuButton);
    const opened = await activeBrowser
      .waitUntil(() => menuButton.getAttribute("aria-expanded").then((value) => value === "true"), {
        timeout: 1_000,
        interval: 50,
      })
      .then(() => true)
      .catch(() => false);
    if (!opened) continue;
    compatibilityStage = `clicking ${label}`;
    const action = await activeBrowser.$(
      `//button[@id='menu-file']/following-sibling::*[contains(@class,'menu-popup')]//button[normalize-space(.)=${JSON.stringify(label)}]`,
    );
    const displayed = await action
      .waitForDisplayed({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!displayed) continue;
    await clickElement(activeBrowser, action);
    return;
  }
  throw new Error(`文件 menu action did not become clickable: ${label}`);
}

async function clickElement(activeBrowser, element) {
  if (browserName === "safari") {
    await activeBrowser.execute((target) => target.click(), element);
    return;
  }
  await element.click();
}

async function enableGlobalInteractionAssist(activeBrowser) {
  await clickFileMenuAction(activeBrowser, "偏好设置…");
  const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
  await dialog.waitForDisplayed({ timeout: 5_000 });
  await clickElement(activeBrowser, await dialog.$("#preference-global-interactionAssistMode-on"));
  await clickElement(activeBrowser, await dialog.$("button=应用"));
  await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
  await activeBrowser.waitUntil(
    () =>
      activeBrowser.execute(
        () => document.querySelector("section[aria-label='交互辅助面板']")?.ariaHidden === "false",
      ),
    { timeout: 5_000, interval: 50, timeoutMsg: "interaction assistance did not switch on" },
  );
}

async function verifyGlobalPreferencesBeforeProject(activeBrowser) {
  const openDialog = async () => {
    compatibilityStage = "opening global preferences before project load";
    const button = await activeBrowser.$("#welcome-preferences");
    await button.waitForClickable({ timeout: 5_000 });
    await clickElement(activeBrowser, button);
    const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
    const opened = await dialog
      .waitForDisplayed({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      // SafariDriver can report a successful native element click without dispatching it when a
      // previous automation session left Safari in the background. Exercise the same mounted UI
      // control in-page before treating the missing dialog as a product failure.
      await activeBrowser.execute(() => document.querySelector("#welcome-preferences")?.click());
    }
    await dialog.waitForDisplayed({ timeout: 5_000 });
    return dialog;
  };

  let dialog = await openDialog();
  const projectTab = await dialog.$("#preference-tab-project");
  const imageScale = await dialog.$("#preference-global-imageScale");
  const interactionAssistMode = await dialog.$("#preference-global-interactionAssistMode-auto");
  const imageScaleLabel = await dialog.$("label[for='preference-global-imageScale']");
  if (await projectTab.isEnabled())
    throw new Error("project preferences were enabled without a project");
  if (!(await imageScale.isEnabled()))
    throw new Error("global image scale was disabled without a project");
  const tooltip = await imageScaleLabel.getAttribute("title");
  if (!tooltip) throw new Error("global image scale did not expose its explanatory tooltip");
  const fontOverride = await dialog.$("#preference-global-FontName-override");
  await clickElement(activeBrowser, fontOverride);
  const fontInput = await dialog.$("#preference-global-FontName");
  await fontInput.waitForDisplayed({ timeout: 5_000 });
  const fontInputDetails = {
    type: await fontInput.getAttribute("type"),
    list: await fontInput.getAttribute("list"),
    describedBy: await fontInput.getAttribute("aria-describedby"),
  };
  if (fontInputDetails.type !== "text" || fontInputDetails.list !== "available-game-fonts") {
    throw new Error(
      `global game font did not use the editable project-settings list: ${JSON.stringify(fontInputDetails)}`,
    );
  }
  await fontInput.setValue("RustyEra Compatibility Font");
  const typedFont = await fontInput.getValue();
  if (typedFont !== "RustyEra Compatibility Font")
    throw new Error(`global game font was not editable: ${typedFont}`);
  await clickElement(activeBrowser, fontOverride);

  compatibilityStage = "saving global preferences before project load";
  await imageScale.setValue("1.25");
  if (!(await interactionAssistMode.isSelected()))
    await clickElement(activeBrowser, interactionAssistMode);
  await clickElement(activeBrowser, await dialog.$("button=应用"));
  await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
  await activeBrowser.waitUntil(
    () =>
      activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot().status === "全局偏好已应用"),
    {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: "global preferences were not saved before project load",
    },
  );

  dialog = await openDialog();
  const persisted = await (await dialog.$("#preference-global-imageScale")).getValue();
  const persistedInteractionAssistMode = (await (
    await dialog.$("#preference-global-interactionAssistMode-auto")
  ).isSelected())
    ? "auto"
    : "other";
  if (persisted !== "1.25")
    throw new Error(`global preferences did not reopen with the saved value: ${persisted}`);
  if (persistedInteractionAssistMode !== "auto")
    throw new Error(
      `global interaction assistance mode did not persist: ${persistedInteractionAssistMode}`,
    );
  await (await dialog.$("#preference-global-imageScale")).setValue("1");
  await clickElement(activeBrowser, await dialog.$("button=应用"));
  await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
  return {
    projectTabEnabled: false,
    imageScaleEditable: true,
    fontInputDetails,
    typedFont,
    persisted,
    persistedInteractionAssistMode,
    restored: "1",
    tooltip,
  };
}

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
  compatibilityStage = "waiting for compiled cache generation";
  await activeBrowser.waitUntil(
    () =>
      activeBrowser.execute(() => {
        const state = window.__RUSTYERA_TEST__?.snapshot();
        return state?.canInteract && state.transfer?.export?.name === "compiled-project.reracache";
      }),
    { timeout: 30_000, interval: 50, timeoutMsg: "compiled cache generation did not start" },
  );
  const titleWaitId = await activeBrowser.execute(
    () => window.__RUSTYERA_TEST__?.snapshot().wait?.wait_id ?? null,
  );
  compatibilityStage = "clicking the new-game button during compiled cache generation";
  const newGame = await activeBrowser.$(".game-viewport .game-button");
  await newGame.waitForClickable({ timeout: 30_000 });
  await clickElement(activeBrowser, newGame);
  compatibilityStage = "waiting for game input during compiled cache generation";
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
  compatibilityStage = "returning from the game log with an ordinary key";
  await activeBrowser.keys(["Space"]);
  await waitForReturnedDialogue(activeBrowser, logWaitId);

  logWaitId = await openGameLog(activeBrowser);
  compatibilityStage = "returning from the game log with a left viewport click";
  await clickElement(activeBrowser, await activeBrowser.$(".game-viewport"));
  await waitForReturnedDialogue(activeBrowser, logWaitId);

  logWaitId = await openGameLog(activeBrowser);
  compatibilityStage = "skipping the current scene from the game log";
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
    compatibilityStage = `advancing dialogue to ${expectedText}`;
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
        await clickElement(activeBrowser, await activeBrowser.$(".prompt-bar button[type=submit]"));
      }
    }
    await waitForChangedInput(activeBrowser, waitId);
  }
  throw new Error(`${expectedText} was not visible after ${maximum} message waits`);
}

async function openGameLog(activeBrowser) {
  compatibilityStage = "opening the in-game message log";
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
if (snapshotMonitorError) throw snapshotMonitorError;
if (runError) throw runError;

async function collectFiles(root) {
  const output = [];
  await walk(root, "", output);
  return output;

  async function walk(directory, prefix, target) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".rustyera") continue;
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, `${relative}/`, target);
      else if (entry.isFile()) {
        target.push({ path: relative, base64: (await readFile(absolute)).toString("base64") });
      }
    }
  }
}

function* portableFileBatches(
  files,
  maximumEncodedBytes = 512 * 1024,
  maximumChunkBytes = 256 * 1024,
) {
  let batch = [];
  let encodedBytes = 0;
  for (const file of files) {
    const total = file.base64.length;
    for (let offset = 0; offset < Math.max(1, total); offset += maximumChunkBytes) {
      const base64 = file.base64.slice(offset, offset + maximumChunkBytes);
      const chunkBytes = file.path.length + base64.length;
      if (batch.length && encodedBytes + chunkBytes > maximumEncodedBytes) {
        yield batch;
        batch = [];
        encodedBytes = 0;
      }
      batch.push({ path: file.path, base64, final: offset + base64.length >= total });
      encodedBytes += chunkBytes;
    }
  }
  if (batch.length) yield batch;
}

async function collectCompatibilityReport(browser) {
  return browser.execute(() => ({
    userAgent: navigator.userAgent,
    status: document.querySelector(".runtime-status")?.textContent,
    output: document.querySelector(".game-viewport")?.textContent,
    picker: window.__RUSTYERA_COMPAT_PICKER__,
    startupTelemetry: window.__RUSTYERA_TEST__?.snapshot().startupTelemetry,
  }));
}

function assertColdStartup(telemetry) {
  if (
    telemetry?.scenario !== "cold" ||
    telemetry.cacheHit !== false ||
    telemetry.outcome !== "success"
  ) {
    throw new Error(`startup was not a successful cold load: ${JSON.stringify(telemetry)}`);
  }
}

function assertPackagedStartup(telemetry) {
  if (
    telemetry?.scenario !== "project_file" ||
    telemetry.cacheHit !== true ||
    telemetry.outcome !== "success"
  ) {
    throw new Error(
      `startup was not a successful packaged cache hit: ${JSON.stringify(telemetry)}`,
    );
  }
}

function packagedProjectProgressErrors(progress, requirePreferences = true) {
  const errors = [];
  const labels = progress.labels ?? [];
  if (!progress.cacheHit) errors.push("compiled cache hit");
  if (!labels.some((label) => label.startsWith("正在读取项目文件："))) errors.push("file read");
  if (!labels.some((label) => label.startsWith("项目缓存命中，正在准备脚本热重载…")))
    errors.push("cache handoff");
  if (
    labels.some(
      (label) =>
        label.startsWith("正在准备 Runtime 资源：") &&
        !/^正在准备 Runtime 资源：[01]\/1（(?:0|100)%）/.test(label),
    )
  ) {
    errors.push("source preparation slow path");
  }
  if (progress.active || !progress.completed) {
    errors.push("continuous completed progress");
  }
  if (requirePreferences) {
    if (
      !progress.projectPreferencesDuringLoad?.observedLoading ||
      !progress.projectPreferencesDuringLoad.dialogOpened ||
      !progress.projectPreferencesDuringLoad.projectTabEnabled ||
      !progress.projectPreferencesDuringLoad.projectFieldEditable ||
      !progress.projectPreferencesDuringLoad.saveSubmitted ||
      !progress.projectPreferencesDuringLoad.saveCompleted
    ) {
      errors.push("project preferences during loading");
    }
    if (
      !progress.projectPreferencesAfterLoad?.projectTabEnabled ||
      !progress.projectPreferencesAfterLoad.projectFieldEditable ||
      !progress.projectPreferencesAfterLoad.savedOverrideSelected
    ) {
      errors.push("project preferences after loading");
    }
  }
  return errors;
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
