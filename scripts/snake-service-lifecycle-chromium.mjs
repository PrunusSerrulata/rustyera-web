#!/usr/bin/env node
/* global window */
import { appendFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isolatedProject } from "./web-test-lib.mjs";
import { createLoopbackViteServer, viteServerPort } from "./vite-test-server.mjs";
import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";
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
let server, browser, gate, monitor;
let failure;
try {
  server = await createLoopbackViteServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
  });
  // Explicit installed binary only. Headful windows provide real focus transitions.
  browser = await chromium.launch({ executablePath, headless: false });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
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
          await server?.close();
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
      const next = await browser.newContext();
      const nextPage = await next.newPage();
      await nextPage.goto(url);
      active = "focus-probe";
      windows.set(active, { context: next, page: nextPage });
      await nextPage.bringToFront();
    },
    async switchToWindow(handle) {
      if (!windows.has(handle)) throw new Error("unknown lifecycle window");
      active = handle;
      await current().bringToFront();
    },
    async closeWindow() {
      const old = windows.get(active);
      windows.delete(active);
      await old.context.close();
    },
  };
}
