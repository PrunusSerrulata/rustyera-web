/* global document, HTMLElement, MutationObserver, navigator, window */

import { mkdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

import { remote } from "webdriverio";
import { inspectWebdriverTyped, assertProjectStorage, typedValues } from "./interop-assertions.mjs";
import { prepareNativeProjectUpload, uploadNativeProject } from "./native-project-upload.mjs";
import { seedPackagedInteropStorage } from "./packaged-interop-storage.mjs";
import { CaptureWriter } from "./snake-service-capture-io.mjs";
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
  packagedProjectProgressErrors,
  nativeFirefoxCapabilities,
  focusNativeBrowser,
  snakeAudioRelations,
  snakeAudioStressRelations,
  waitForWebDriverDocument,
} from "./web-test-lib.mjs";
import { loadCompatibilityOptions } from "./browser-compat-options.mjs";
import {
  assertColdStartup,
  assertPackagedStartup,
  collectCompatibilityReport,
  persistCompatibilityFailure,
  safariProjectFilePlugin,
  waitForCompatibilityRuntime,
} from "./browser-compat-support.mjs";
import { startCompatibilitySnapshotMonitor } from "./browser-compat-monitor.mjs";
import { createBrowserCompatibilityHelpers } from "./browser-compat-ui.mjs";
import { createBrowserCompatibilitySmokeHelpers } from "./browser-compat-smoke.mjs";
import { runInteractiveCompatibility } from "./browser-compat-interactive.mjs";

export async function runBrowserCompatibility(argv) {
  const {
    repository,
    browserName,
    project,
    projectFile,
    expectedOutput,
    checkTooltip,
    fullProjectExport,
    snakeData,
    snakeServiceOracle,
    oracleConfig,
    oracleInputs,
    snakeServices,
    snakeBatch1,
    snakeServiceLifecycle,
    snakeAudioStress,
    snakeAudioFlow,
    snakeInterop,
    nativeDriverInputs,
    backgroundDom,
    webdriverOpen,
    safariAllowAutoplay,
    traditionalState,
    expectedWatches,
    lifecycleReplacement,
    lifecycleReplacementFiles,
    startupOnly,
    cacheInputSmoke,
    logInputSmoke,
    settingsHotApply,
    files,
  } = await loadCompatibilityOptions(argv);

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

  const setStage = (stage) => {
    compatibilityStage = stage;
  };
  const {
    installPackagedProjectPicker,
    installPortableProjectPicker,
    exerciseProjectPreferencesDuringLoad,
    verifyProjectPreferencesAfterLoad,
    inspectInteractionAssistPanel,
    inspectAutomaticInteractionAssist,
    clickFileMenuAction,
    clickElement,
    enableGlobalInteractionAssist,
    verifyGlobalPreferencesBeforeProject,
  } = createBrowserCompatibilityHelpers({
    browserName,
    backgroundDom,
    nativeDriverInputs,
    setStage,
  });
  const { inspectOpfsProjectCache, runCacheInputSmoke, runLogInputSmoke, loadSnakeInteropSlot } =
    createBrowserCompatibilitySmokeHelpers({
      backgroundDom,
      clickElement,
      collectCompatibilityReport,
      setStage,
    });

  try {
    server = await createLoopbackViteServer({
      root: repository,
      mode: "test",
      define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
      plugins:
        !nativeDriverInputs && browserName === "safari" && projectFile
          ? [safariProjectFilePlugin(projectFile)]
          : undefined,
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
              // SafariDriver applies this only to the new automation session. Omit
              // the capability entirely when testing the default playback policy.
              ...(safariAllowAutoplay ? { "webkit:alwaysAllowAutoplay": true } : {}),
            },
    });
    if (browserName === "safari" && !backgroundDom) {
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
    console.log(
      JSON.stringify({
        browser: browserName,
        type: "browser-input-mode",
        mode: backgroundDom ? "background-dom" : nativeDriverInputs ? "native" : "compatibility",
        projectOpenInput: webdriverOpen ? "webdriver-element" : "mode-default",
        autoplayPolicy: safariAllowAutoplay ? "session-allow" : "default",
        trustedInputCoverage: nativeDriverInputs && !backgroundDom,
      }),
    );
    snapshotMonitor = startCompatibilitySnapshotMonitor({
      browser,
      browserName,
      snapshotPath,
      snapshotContext: () => ({ stage: compatibilityStage }),
      allowFault: () => snakeServiceOracle && allowsServiceOracleFault(),
      onSnapshot: (snapshot) =>
        snakeServiceOracle ? recordServiceOracleWatchdog(snapshot) : undefined,
      onFailure(error) {
        snapshotMonitorError = error;
      },
    });
    if (!backgroundDom && (browserName === "safari" || snakeServiceLifecycle)) {
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
      hints: [...document.querySelectorAll(".welcome .hint")].map((hint) =>
        hint.textContent?.trim(),
      ),
    }));
    if (
      startupGuidance.directProjectDirectoryAccess ||
      startupGuidance.hints.length !== 1 ||
      startupGuidance.hints[0] !== "该浏览器不支持文件系统访问API，启动性能会受影响"
    ) {
      throw new Error(`browser startup guidance mismatch: ${JSON.stringify(startupGuidance)}`);
    }
    const globalPreferencesBeforeProject =
      nativeDriverInputs || backgroundDom
        ? { scope: "project acceptance; preferences covered separately" }
        : await verifyGlobalPreferencesBeforeProject(browser);
    console.log(
      JSON.stringify({
        browser: browserName,
        type: "global-preferences-before-project",
        ...globalPreferencesBeforeProject,
      }),
    );
    let minimized = false;
    if (snakeInterop && projectFile) {
      compatibilityStage = "preparing reference saves in isolated packaged project storage";
      const expected = JSON.parse(
        await readFile(path.join(project, "batch5-interop-expect.json"), "utf8"),
      );
      const seeded = await seedPackagedInteropStorage(browser, {
        projectFile,
        savesDirectory: path.join(project, "sav"),
        expectedHashes: expected.file_sha256,
      });
      const evidence = await persistCompatibilityEvidence("interop-storage-fixture", seeded);
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "interop-storage-fixture",
          ...seeded,
          evidence,
        }),
      );
    }
    reportCompatibilityStage(
      projectFile ? "installing packaged project picker" : "installing portable project picker",
    );
    const setup = nativeDriverInputs
      ? await prepareNativeProjectUpload(browser)
      : projectFile
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

    if (snakeData || snakeAudioFlow || snakeServiceOracle || snakeInterop || traditionalState) {
      reportCompatibilityStage("configuring snake test runtime");
      await browser.execute(
        (bytes) =>
          window.__RUSTYERA_TEST__.configure({
            start: bytes
              ? { type: "traditional_save", bytes: new Uint8Array(bytes) }
              : { type: "new_game", seed: "123456" },
            clock: "2026-01-01T00:00:00Z",
          }),
        traditionalState,
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
    if (webdriverOpen) {
      await browser.execute((element) => {
        window.__RUSTYERA_OPEN_EVENTS__ = [];
        for (const type of ["pointerdown", "mousedown", "click"])
          element.addEventListener(
            type,
            (event) =>
              window.__RUSTYERA_OPEN_EVENTS__.push({
                type: event.type,
                trusted: event.isTrusted,
                activation: navigator.userActivation?.isActive ?? null,
                documentFocused: document.hasFocus(),
                visibility: document.visibilityState,
              }),
            { once: true },
          );
      }, open);
      await open.click();
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "webdriver-project-open-events",
          events: await browser.execute(() => window.__RUSTYERA_OPEN_EVENTS__),
        }),
      );
    } else await clickElement(browser, open);
    if (nativeDriverInputs) {
      reportCompatibilityStage("uploading project through native WebDriver");
      const upload = await uploadNativeProject(browser, { project, projectFile });
      console.log(
        JSON.stringify({ browser: browserName, type: "native-project-upload", ...upload }),
      );
    }
    let projectPreferencesDuringLoad;
    let projectPreferencesAfterLoad;
    if (projectFile && !nativeDriverInputs) {
      compatibilityStage = "uploading packaged project";
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
        const input = await browser.$('input[type="file"][accept*=".reraproj"]');
        await input.waitForExist({ timeout: 5_000 });
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
    if (expectedWatches) {
      if (snakeInterop) await loadSnakeInteropSlot(browser);
      compatibilityStage = "comparing restored state through the debug protocol";
      const watches = {
        values: await inspectWebdriverTyped(browser, Object.keys(expectedWatches)),
      };
      const evidence = await persistCompatibilityEvidence("interop-watches", watches);
      const values = typedValues(watches.values, Object.keys(expectedWatches));
      const storage = await browser.execute(() => {
        return window.__RUSTYERA_TEST__.protocolEvidence(["storage_request", "storage_response"]);
      });
      const storageEvidence = await persistCompatibilityEvidence("interop-storage", storage);
      assertProjectStorage(storage);
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "interop-watches",
          values,
          evidence,
          storageEvidence,
          restorePath: snakeInterop
            ? "visible title Continue → save1000 → confirm → LOADDATA"
            : "lifecycle restore of explicit file bytes; not a Save/read claim",
        }),
      );
      assert.deepEqual(values, expectedWatches, "restored save differs from reference state");
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
    // Select progress policy by the actual project source, independently of the input driver.
    const projectProgressErrors = projectFile
      ? packagedProjectProgressErrors(projectProgress, !startupOnly)
      : nativeDriverInputs
        ? [
            !projectProgress.completed && "load did not complete",
            projectProgress.gaps > 0 && "progress gaps",
          ].filter(Boolean)
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
      if (fullProjectExport) {
        compatibilityStage = "exporting the full project through the visible menu";
        // Observe the Blob produced by the real download path without replacing its click handler.
        // Keep only its header and length, never a second complete project byte array.
        await browser.execute(() => {
          window.__FULL_PROJECT_DOWNLOAD__ = null;
          const observe = async (event) => {
            const anchor = event.target;
            if (!(anchor instanceof HTMLElement) || !anchor.matches("a[download$='.reraproj']"))
              return;
            document.removeEventListener("click", observe, true);
            try {
              const response = await fetch(anchor.href);
              const size = Number(response.headers.get("Content-Length"));
              const reader = response.body.getReader();
              const header = new Uint8Array(8);
              let received = 0;
              try {
                while (received < header.length) {
                  const { done, value } = await reader.read();
                  if (done) throw new Error("project download header is truncated");
                  const count = Math.min(value.length, header.length - received);
                  header.set(value.subarray(0, count), received);
                  received += count;
                }
              } finally {
                await reader.cancel();
              }
              window.__FULL_PROJECT_DOWNLOAD__ = {
                name: anchor.download,
                size,
                magic: new TextDecoder().decode(header),
              };
            } catch (error) {
              window.__FULL_PROJECT_DOWNLOAD__ = { error: String(error) };
            }
          };
          document.addEventListener("click", observe, true);
        });
        await clickFileMenuAction(browser, "导出全量项目文件…");
        await browser.waitUntil(
          () =>
            browser.execute(() => {
              const download = window.__FULL_PROJECT_DOWNLOAD__;
              if (download?.error) throw new Error(download.error);
              return Boolean(
                download &&
                !document.querySelector(".full-project-export") &&
                window.__RUSTYERA_TEST__.snapshotSummary().canInteract,
              );
            }),
          { timeout: 180_000, interval: 50, timeoutMsg: "full project export did not finish" },
        );
        const download = await browser.execute(() => window.__FULL_PROJECT_DOWNLOAD__);
        assert.equal(download.magic, "RERAPROJ");
        assert.ok(download.size > 8);
        console.log(
          JSON.stringify({ type: "full-project-export", browser: browserName, download }),
        );
      }
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
      await runInteractiveCompatibility({
        browser,
        browserName,
        setup,
        opfsReset,
        startupGuidance,
        projectProgress,
        settingsHotApply,
        checkTooltip,
        setStage,
        clickElement,
        clickFileMenuAction,
        inspectAutomaticInteractionAssist,
        enableGlobalInteractionAssist,
        inspectInteractionAssistPanel,
        inspectOpfsProjectCache,
        assertColdStartup,
      });
    }
  } catch (error) {
    // Preserve a failure between periodic ticks before disposing the native session.
    runError = await persistCompatibilityFailure({
      browser,
      browserName,
      stage: compatibilityStage,
      error,
      persistEvidence: persistCompatibilityEvidence,
    });
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

  if (snapshotMonitorError) throw snapshotMonitorError;
  if (runError) throw runError;
}
