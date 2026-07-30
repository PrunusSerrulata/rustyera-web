#!/usr/bin/env node
/* global document, getComputedStyle, HTMLInputElement, HTMLElement, navigator, window */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { remote } from "webdriverio";

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
let server;
let browser;

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
  let minimized = false;
  if (browserName === "safari") {
    minimized = await browser
      .minimizeWindow()
      .then(() => true)
      .catch(() => false);
  }
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
        const nativeInputClick = HTMLInputElement.prototype.click;
        const picker = {
          fallback: false,
          focusBeforeChange: false,
          confirmationDelayMs: 50,
        };
        Object.defineProperty(window, "showDirectoryPicker", {
          configurable: true,
          value: undefined,
        });
        HTMLInputElement.prototype.click = function () {
          if (this.type !== "file" || !this.webkitdirectory) {
            nativeInputClick.call(this);
            return;
          }
          picker.fallback = true;
          window.dispatchEvent(new Event("focus"));
          picker.focusBeforeChange = true;
          window.setTimeout(() => {
            Object.defineProperty(this, "files", { configurable: true, value: selected });
            this.dispatchEvent(new Event("change", { bubbles: true }));
            HTMLInputElement.prototype.click = nativeInputClick;
          }, picker.confirmationDelayMs);
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

  const open = await browser.$("button.primary.large");
  await open.waitForClickable({ timeout: 30_000 });
  await open.click();
  await browser.waitUntil(
    async () => {
      if (!(await browser.$(".game-viewport").isExisting())) return false;
      return browser.execute(() => {
        const state = window.__RUSTYERA_TEST__?.snapshot();
        return state?.phase === "waiting_input" && state.canInteract;
      });
    },
    {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "WASM project did not reach a stable input wait",
    },
  );
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
  console.log(
    JSON.stringify({
      browser: browserName,
      browserVersion: browser.capabilities.browserVersion,
      minimized,
      projectName: setup.projectName,
      opfs: setup.opfs,
      tooltip,
      ...observed,
    }),
  );
} finally {
  await browser?.deleteSession().catch(() => {});
  await server?.close().catch(() => {});
}

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
