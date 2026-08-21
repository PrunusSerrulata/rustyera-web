#!/usr/bin/env node
/* global caches, document, location, navigator */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { preview } from "vite";

import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repository, ".playwright-browsers");
const { chromium } = await import("playwright");

const runDirectory = path.join(repository, ".rustyera", "test-runs", `pwa-${Date.now()}`);
const snapshotPath = path.join(runDirectory, "snapshots.ndjson");
mkdirSync(runDirectory, { recursive: true });

let server;
let browser;
let context;
let monitor;
let monitorError;
let stage = "starting production preview";

try {
  server = await preview({
    root: repository,
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const address = server.httpServer.address();
  if (typeof address !== "object" || address == null) {
    throw new Error("PWA preview did not bind a TCP port");
  }
  const targetUrl = `http://127.0.0.1:${address.port}/`;

  stage = "launching Chromium";
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "RustyEra" }).waitFor({ state: "visible" });

  monitor = startCompleteSnapshotMonitor(
    { execute: (operation) => page.evaluate(operation) },
    {
      eventType: "pwa-snapshot",
      label: "Chromium PWA",
      snapshotContext: () => ({ stage }),
      output(line) {
        appendFileSync(snapshotPath, `${line}\n`);
        const snapshot = JSON.parse(line);
        console.log(
          JSON.stringify({
            type: "pwa-snapshot-summary",
            path: snapshotPath,
            capturedAt: snapshot.capturedAt,
            stage: snapshot.operation?.stage,
            elements: snapshot.document.length,
            runtime: snapshot.runtime,
          }),
        );
      },
    },
  );
  void monitor.failure.catch(async (error) => {
    monitorError = error;
    await Promise.allSettled([context.close(), server.close()]);
  });

  stage = "validating install manifest";
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    if (!href) throw new Error("document has no web app manifest link");
    const response = await fetch(href);
    if (!response.ok) throw new Error(`manifest request failed with ${response.status}`);
    return response.json();
  });
  if (
    manifest.name !== "RustyEra" ||
    manifest.display !== "standalone" ||
    !manifest.icons?.some((icon) => icon.sizes === "192x192") ||
    !manifest.icons?.some((icon) => icon.sizes === "512x512")
  ) {
    throw new Error(`install manifest mismatch: ${JSON.stringify(manifest)}`);
  }

  stage = "waiting for service worker precache";
  const registration = await page.evaluate(async () => {
    const value = await navigator.serviceWorker.ready;
    const worker = value.active;
    if (!worker) throw new Error("service worker registration has no active worker");
    if (worker.state !== "activated") {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("service worker activation timed out")),
          20_000,
        );
        const stateChanged = () => {
          if (worker.state !== "activated") return;
          clearTimeout(timeout);
          worker.removeEventListener("statechange", stateChanged);
          resolve(undefined);
        };
        worker.addEventListener("statechange", stateChanged);
        stateChanged();
      });
    }
    return { active: worker.state, scope: value.scope };
  });
  if (registration.active !== "activated") {
    throw new Error(`service worker did not activate: ${JSON.stringify(registration)}`);
  }

  stage = "claiming the installed worker";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller != null, undefined, {
    timeout: 10_000,
  });
  const cacheState = await page.evaluate(async () => {
    const wasmUrl = new URL("wasm/era_web_wasm_bg.wasm", location.href).href;
    const names = await caches.keys();
    const cachedWasm = await Promise.all(
      names.map(async (name) =>
        Boolean(await (await caches.open(name)).match(wasmUrl, { ignoreSearch: true })),
      ),
    );
    return { names, wasmUrl, cachedWasm: cachedWasm.some(Boolean) };
  });
  if (!cacheState.names.length || !cacheState.cachedWasm) {
    throw new Error(`runtime WASM was not precached: ${JSON.stringify(cacheState)}`);
  }

  stage = "reloading the installed app offline";
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "RustyEra" }).waitFor({ state: "visible" });
  const offline = await page.evaluate(async () => {
    const response = await fetch(new URL("wasm/era_web_wasm_bg.wasm", location.href));
    return {
      controlled: navigator.serviceWorker.controller != null,
      wasmAvailable: response.ok,
      wasmBytes: Number(response.headers.get("content-length") ?? 0),
    };
  });
  if (!offline.controlled || !offline.wasmAvailable) {
    throw new Error(`installed app did not start offline: ${JSON.stringify(offline)}`);
  }

  console.log(
    JSON.stringify({
      type: "pwa-result",
      browser: await browser.version(),
      manifest,
      registration,
      cacheState,
      offline,
      snapshotPath,
    }),
  );
} finally {
  await context?.setOffline(false).catch(() => undefined);
  await monitor?.stop().catch((error) => {
    monitorError ??= error;
  });
  await browser?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
}

if (monitorError) throw monitorError;
