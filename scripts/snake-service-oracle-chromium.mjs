#!/usr/bin/env node
/* global window */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { captureConfiguration, prepareCaptureInputs } from "./snake-service-capture-io.mjs";
import {
  allowsServiceOracleFault,
  recordServiceOracleWatchdog,
  runServiceOracleCapture,
} from "./snake-service-capture-client.mjs";
import { isolatedProject } from "./web-test-lib.mjs";
import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";
import { createLoopbackViteServer, viteServerPort } from "./vite-test-server.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const projectIndex = process.argv.indexOf("--project");
if (projectIndex < 0 || !process.argv[projectIndex + 1])
  throw new Error("--project fixture directory is required");
const config = await captureConfiguration(
  process.argv,
  path.resolve(process.argv[projectIndex + 1]),
  "chromium",
);
const inputs = await prepareCaptureInputs(config);
const fixture = await isolatedProject(config.fixture, { cleanSaves: true });
let server, browser, monitor, page;
let monitorFailure;
try {
  server = await createLoopbackViteServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
  });
  const url = `http://127.0.0.1:${viteServerPort(server)}`;
  // An explicit preexisting executable is mandatory. There is no installation/download path.
  browser = await chromium.launch({ headless: true, executablePath: config.clientArtifact });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["local-fonts"], { origin: url });
  page = await context.newPage();
  // Use the real directory FileList path. The remote handle adapter requires file-serving
  // middleware, which this standalone capture server does not provide.
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
  });
  page.on("filechooser", (chooser) => {
    void chooser.setFiles(fixture.project).catch((error) => {
      monitorFailure = error;
      void page.close();
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__RUSTYERA_TEST__ != null);
  monitor = startCompleteSnapshotMonitor(
    { execute: (callback) => page.evaluate(callback) },
    {
      label: "Chromium service oracle capture",
      eventType: "service-oracle-full-snapshot",
      allowFault: allowsServiceOracleFault,
      onSnapshot: recordServiceOracleWatchdog,
      output: (line) =>
        appendFile(path.join(config.outputDirectory, "watchdog.ndjson"), `${line}\n`),
    },
  );
  void monitor.failure.catch((error) => {
    monitorFailure = error;
    void page.close();
  });
  await page.evaluate(
    (seed) =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: String(seed) },
        clock: "2026-01-01T00:00:00Z",
      }),
    config.fixtureManifest.seed,
  );
  await page.locator(".welcome .primary").click();
  const client = {
    version: browser.version(),
    execute: (callback, argument) => page.evaluate(callback, argument),
    async submit(value) {
      await page.locator(".prompt-bar input").fill(value);
      await page.locator(".prompt-bar input").press("Enter");
    },
  };
  const capture = await Promise.race([
    runServiceOracleCapture(client, config, inputs),
    monitor.failure,
  ]);
  if (monitorFailure) throw monitorFailure;
  console.log(JSON.stringify({ type: "snake-service-oracle-capture", ...capture }));
  if (capture.status === "captured_with_observation_blocks") process.exitCode = 2;
} finally {
  try {
    await monitor?.stop();
  } finally {
    await browser?.close();
    await server?.close();
  }
  // Keep the task-owned project and evidence for diagnosis/continuation, including failures.
  console.log(JSON.stringify({ type: "service-oracle-project-copy", path: fixture.project }));
}
