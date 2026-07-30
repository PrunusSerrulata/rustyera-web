#!/usr/bin/env node
/* global document, navigator, window */

import { createReadStream } from "node:fs";
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
const project = path.resolve(repository, "../emuera.em/emuera-reference-cli/tests/fixture");
const files = await collectFiles(project);
let server;
let browser;

try {
  server = await createServer({
    root: repository,
    mode: "test",
    define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
    plugins: [
      {
        name: "rustyera-browser-compat-wasm",
        configureServer(viteServer) {
          viteServer.middlewares.use((request, response, next) => {
            const name = request.url?.match(/^\/__rustyera_test_wasm\/([^?]+)/)?.[1];
            if (!name || !["era_web_wasm.js", "era_web_wasm_bg.wasm"].includes(name)) {
              next();
              return;
            }
            response.setHeader(
              "Content-Type",
              name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            );
            createReadStream(path.join(repository, "public/wasm", name)).pipe(response);
          });
        },
      },
    ],
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
        const module = await import("/src/platform/browserDirectory.ts");
        const selected = payload.files.map((entry) => {
          const raw = atob(entry.base64);
          const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
          const file = new File([bytes], entry.path.split("/").at(-1));
          Object.defineProperty(file, "webkitRelativePath", {
            value: `${payload.projectName}/${entry.path}`,
          });
          return file;
        });
        const picked = await module.importBrowserDirectory(
          selected,
          await navigator.storage.getDirectory(),
        );
        window.showDirectoryPicker = async () => picked.handle;
        done({
          ok: true,
          projectName: picked.projectName,
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
    async () =>
      (await browser.$(".game-viewport").isExisting()) &&
      (await browser.$("body").getText()).includes("TITLE_CHARANUM=0"),
    {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "WASM project did not reach the reference fixture input wait",
    },
  );
  const observed = await browser.execute(() => ({
    userAgent: navigator.userAgent,
    status: document.querySelector(".runtime-status")?.textContent,
    output: document.querySelector(".game-viewport")?.textContent,
  }));
  console.log(
    JSON.stringify({
      browser: browserName,
      browserVersion: browser.capabilities.browserVersion,
      minimized,
      projectName: setup.projectName,
      opfs: setup.opfs,
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
