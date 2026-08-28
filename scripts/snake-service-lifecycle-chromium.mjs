#!/usr/bin/env node
/* global document, window */
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isolatedProject } from "./web-test-lib.mjs";
import { createLoopbackViteServer, viteServerPort } from "./vite-test-server.mjs";
import {
  captureCompleteTauriSnapshot,
  startCompleteSnapshotMonitor,
} from "./tauri-test-support.mjs";
import { createLifecycleImageGate } from "./snake-service-lifecycle-gate.mjs";
import { runSnakeServiceLifecycleClient } from "./snake-service-lifecycle-test-support.mjs";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return path.resolve(process.argv[index + 1]);
};
const project = argument("--project");
const successor = argument("--replacement-project");
const executablePath = await realpath(argument("--chromium-executable"));
const output = argument("--output");
if ((await realpath(project)) === (await realpath(successor)))
  throw new Error("successor must be a distinct source project");
await mkdir(output, { recursive: false });
const sourceCopy = await isolatedProject(project, { cleanSaves: true });
const successorCopy = await isolatedProject(successor, { cleanSaves: true });
const repository = fileURLToPath(new URL("..", import.meta.url));
let server, browser, gate, monitor, page, chromeProcess;
let failure;
try {
  server = await createLoopbackViteServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
  });
  // noDefaults applies only to the attached default context. Never install Playwright's
  // per-session focus override, including in the independent native probe window.
  const profile = path.join(output, "chromium-profile");
  await mkdir(profile);
  chromeProcess = spawn(
    executablePath,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=zh-CN",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromeProcess.stderr.pipe(process.stderr);
  const endpoint = await nativeBrowserEndpoint(chromeProcess, profile);
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("native Chromium did not provide its default context");
  page = context.pages()[0] ?? (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.bringToFront();
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
  });
  let selectedProject = sourceCopy.project;
  page.on("filechooser", (chooser) => {
    void chooser.setFiles(selectedProject).catch((error) => {
      failure = error;
      void page.close();
    });
  });
  await page.goto(`http://127.0.0.1:${viteServerPort(server)}`);
  await page.waitForFunction(() => window.__RUSTYERA_TEST__ != null);
  monitor = startCompleteSnapshotMonitor(
    { execute: (callback) => page.evaluate(callback) },
    {
      label: "Chromium lifecycle",
      eventType: "lifecycle-full-snapshot",
      output: (line) => appendFile(path.join(output, "watchdog.ndjson"), `${line}\n`),
    },
  );
  void monitor.failure.catch((error) => {
    failure = error;
    void page.close();
  });
  await page.evaluate(() =>
    window.__RUSTYERA_TEST__.configure({
      start: { type: "new_game", seed: "123456" },
      clock: "2026-01-01T00:00:00Z",
    }),
  );
  await page.locator(".welcome .primary").click();
  gate = await createLifecycleImageGate(sourceCopy.project);
  const adapter = playwrightLifecycleAdapter(browser, context, page);
  const result = await Promise.race([
    runSnakeServiceLifecycleClient(adapter, "browser", {
      gate,
      prepareReplacement: async () => {
        selectedProject = successorCopy.project;
      },
    }),
    monitor.failure,
  ]);
  if (failure) throw failure;
  const report = {
    browser: "chromium",
    version: browser.version(),
    executablePath,
    project: sourceCopy.project,
    successor: successorCopy.project,
    seed: 123456,
    clock: "2026-01-01T00:00:00Z",
    ...result,
  };
  await appendFile(path.join(output, "result.json"), JSON.stringify(report));
  console.log(JSON.stringify(report));
} catch (error) {
  // Preserve the precise failure frontier even when it falls between watchdog ticks.
  let snapshot, snapshotError;
  try {
    if (page && !page.isClosed())
      snapshot = await captureCompleteTauriSnapshot({
        execute: (callback) => page.evaluate(callback),
      });
  } catch (cause) {
    snapshotError = String(cause);
  }
  await appendFile(
    path.join(output, "failure.json"),
    JSON.stringify({ error: String(error), snapshot, snapshotError }),
  );
  throw error;
} finally {
  try {
    if (gate)
      await appendFile(path.join(output, "image-stream.json"), JSON.stringify(gate.status()));
  } finally {
    try {
      await gate?.close();
    } finally {
      try {
        await monitor?.stop();
      } finally {
        try {
          await browser?.close();
        } finally {
          try {
            await stopNativeBrowser(chromeProcess);
          } finally {
            await server?.close();
          }
        }
      }
    }
  }
}

function playwrightLifecycleAdapter(browser, context, page) {
  const windows = new Map([["main", { page, context }]]);
  let active = "main";
  const current = () => windows.get(active).page;
  const locator = (root, selector) =>
    selector.startsWith("button=")
      ? root.getByRole("button", { name: selector.slice(7), exact: true })
      : root.locator(selector);
  const element = (target) => ({
    setValue: (value) => target.fill(value),
    click: () => target.click(),
    moveTo: () => target.hover(),
    waitForDisplayed: ({ timeout = 5000 } = {}) => target.waitFor({ state: "visible", timeout }),
    $: async (selector) => element(locator(target, selector)),
  });
  return {
    execute: (callback, value) => current().evaluate(callback, value),
    $: async (selector) => element(locator(current(), selector)),
    keys: (key) => current().keyboard.press(key),
    async waitUntil(accept, { timeout, interval = 50, timeoutMsg }) {
      const deadline = Date.now() + timeout;
      while (!(await accept())) {
        if (Date.now() >= deadline) throw new Error(timeoutMsg);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    getWindowSize: async () => current().viewportSize(),
    setWindowSize: (width, height) => current().setViewportSize({ width, height }),
    async performActions(actions) {
      const move = actions[0].actions[0];
      await current().mouse.move(move.x, move.y);
    },
    releaseActions: async () => {},
    getWindowHandle: async () => active,
    async newWindow(url) {
      const control = await browser.newBrowserCDPSession();
      let nextPage;
      try {
        [nextPage] = await Promise.all([
          context.waitForEvent("page", { timeout: 5000 }),
          control.send("Target.createTarget", { url, newWindow: true, background: false }),
        ]);
      } finally {
        await control.detach();
      }
      active = "focus-probe";
      windows.set(active, { context, page: nextPage });
      await nextPage.bringToFront();
      // Native window activation is asynchronous. Observe the actual transfer before switching
      // back; otherwise a rapid pair of activation requests can leave the first window focused.
      await nextPage.waitForFunction(() => document.hasFocus(), undefined, { timeout: 3000 });
      await page.waitForFunction(() => !document.hasFocus(), undefined, { timeout: 3000 });
    },
    async switchToWindow(handle) {
      if (!windows.has(handle)) throw new Error("unknown lifecycle window");
      active = handle;
      await current().bringToFront();
    },
    async closeWindow() {
      const old = windows.get(active);
      windows.delete(active);
      await old.page.close();
    },
  };
}

async function nativeBrowserEndpoint(child, profile) {
  let launchError;
  const failed = (error) => {
    launchError = error;
  };
  child.on("error", failed);
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode != null || child.signalCode != null)
        throw new Error("native Chromium exited before its loopback endpoint became available");
      try {
        const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        );
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}`;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("native Chromium loopback endpoint did not become available within 10s");
  } finally {
    child.off("error", failed);
  }
}

async function stopNativeBrowser(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
      await exited;
    }
  } finally {
    clearTimeout(timer);
  }
}
