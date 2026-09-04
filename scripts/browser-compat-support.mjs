/* global document, navigator, window */

import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  terminalRuntimeRejection,
} from "./web-test-lib.mjs";
import { captureCompleteTauriSnapshot } from "./tauri-test-support.mjs";

export async function persistCompatibilityFailure({
  browser,
  browserName,
  stage,
  error,
  persistEvidence,
}) {
  try {
    let snapshot, snapshotError;
    try {
      snapshot = await captureCompleteTauriSnapshot(browser);
    } catch (cause) {
      snapshotError = String(cause);
    }
    const artifact = await persistEvidence("failure", {
      browser: browserName,
      stage,
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
      stage,
      name: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 2_000),
    }),
  );
  return error;
}

export function safariProjectFilePlugin(selectedProjectFile) {
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

export async function collectFiles(root) {
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

export function* portableFileBatches(
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

export async function collectCompatibilityReport(browser) {
  return browser.execute(() => ({
    userAgent: navigator.userAgent,
    status: document.querySelector(".runtime-status")?.textContent,
    output: document.querySelector(".game-viewport")?.textContent,
    picker: window.__RUSTYERA_COMPAT_PICKER__,
    startupTelemetry: window.__RUSTYERA_TEST__?.snapshot().startupTelemetry,
  }));
}

export function assertColdStartup(telemetry) {
  if (
    telemetry?.scenario !== "cold" ||
    telemetry.cacheHit !== false ||
    telemetry.outcome !== "success"
  ) {
    throw new Error(`startup was not a successful cold load: ${JSON.stringify(telemetry)}`);
  }
}

export function assertPackagedStartup(telemetry) {
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

export function byteSignature(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function waitForCompatibilityRuntime(browser, browserName) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastReportAt = startedAt;
  let lastSignature;
  let lastObservation;

  while (Date.now() - startedAt < 180_000) {
    const observation = await browser.execute(() => ({
      picker: window.__RUSTYERA_COMPAT_PICKER__,
      progress: window.__RUSTYERA_COMPAT_PROGRESS__?.progress,
      state: window.__RUSTYERA_TEST__?.snapshotSummary(),
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

export function compatibilityDiagnostic(observation) {
  return {
    picker: observation?.picker,
    progress: observation?.progress,
    runtime: runtimeProgressDiagnostic(observation?.state),
    status: observation?.status,
    viewport: observation?.viewport,
  };
}
