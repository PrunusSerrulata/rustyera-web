import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";

import { clickTauriTestElement } from "../../scripts/dom-test-input.mjs";
import {
  readPerformanceTrace,
  replayPerformanceTrace,
  runPerformanceTraceCapture,
  summarizeRuns,
} from "../../scripts/tauri-performance-trace.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_SNAKE_RUNTIME_PERFORMANCE === "1" ? describe : describe.skip;
const tracePath = process.env.RUSTYERA_TAURI_PERF_TRACE;

enabled("Tauri snake runtime performance audit", () => {
  it("replays four versioned runtime paths with calibrated presentation", async () => {
    assert.ok(tracePath, "runner must provide an externally captured, frozen performance trace");
    if (process.env.RUSTYERA_TAURI_PERF_CAPTURE === "1") {
      const template = JSON.parse(await readFile(tracePath, "utf8"));
      await startRun(template);
      const candidatePath = process.env.RUSTYERA_TAURI_PERF_CANDIDATE;
      const actionInboxPath = process.env.RUSTYERA_TAURI_PERF_ACTIONS;
      const projectDigest = process.env.RUSTYERA_TAURI_PERF_PROJECT_DIGEST;
      assert.ok(
        candidatePath && actionInboxPath && projectDigest,
        "capture runner omitted its isolated files or digest",
      );
      const candidate = await runPerformanceTraceCapture(browser, {
        templatePath: tracePath,
        candidatePath,
        actionInboxPath,
        projectDigest,
        onObservation: (observation) =>
          emit({ type: "tauri-performance-capture-observation", observation }),
      });
      emit({
        type: "tauri-performance-capture-complete",
        candidatePath,
        steps: candidate.steps.length,
      });
      return;
    }
    const trace = await readPerformanceTrace(tracePath);
    const calibration = await calibrate();
    if (process.env.RUSTYERA_TAURI_PERF_PHASE === "calibration") {
      emit({
        type: "tauri-performance-calibration",
        mode: process.env.RUSTYERA_TAURI_PERF_WINDOW_MODE,
        calibration,
      });
      return;
    }

    await startRun(trace);
    const runs = [];
    await profilerCheckpoint();
    runs.push(
      await replayPerformanceTrace(browser, trace, ({ path: pathId, step }) =>
        emit({ type: "tauri-performance-step", run: 0, path: pathId, step }),
      ),
    );
    const telemetry = await browser.execute(() => window.__RUSTYERA_TEST__.performanceAudit());
    assert.equal(
      telemetry.frontend.epoch,
      telemetry.frontend.timings[0]?.epoch ?? telemetry.frontend.epoch,
    );
    assert.equal(
      telemetry.native.epoch,
      telemetry.native.pumps[0]?.epoch ?? telemetry.native.epoch,
    );
    for (const phase of [
      "loading",
      "transport",
      "invoke",
      "decode",
      "store_batch",
      "presentation",
      "dom_flush",
      "next_paint",
    ])
      assert.ok(
        telemetry.frontend.timings.some((sample) => sample.phase === phase),
        `${phase} telemetry is empty`,
      );
    emitPerformanceSamples(telemetry);
    emit({
      type: "tauri-snake-runtime-performance",
      schemaVersion: 2,
      trace: {
        path: tracePath,
        scenario: trace.scenario,
        digest: trace.traceDigest,
        schemaVersion: trace.schemaVersion,
      },
      round: process.env.RUSTYERA_TAURI_PERF_ROUND ?? "baseline",
      project: process.env.VITE_RUSTYERA_TEST_PROJECT,
      sourceProject: process.env.RUSTYERA_SERVICE_CAPTURE_SOURCE_PROJECT,
      windowMode: process.env.RUSTYERA_TAURI_PERF_WINDOW_MODE,
      calibration,
      runs,
      summary: summarizeRuns(runs),
      telemetry,
      terminal: await snapshot(),
    });
  });
});

async function calibrate() {
  await waitForControl();
  const calibration = await browser.execute(() =>
    window.__RUSTYERA_TEST__.calibratePerformanceFrames(100),
  );
  assert.equal(calibration.requestedFrames, 100);
  assert.ok(calibration.observedFrames >= 0 && calibration.observedFrames <= 100);
  return calibration;
}

async function startRun(trace) {
  await browser.refresh();
  await waitForControl();
  await browser.execute(
    async ({ seed, clock }) => {
      window.__RUSTYERA_TEST__.configure({ start: { type: "new_game", seed }, clock });
      await window.__RUSTYERA_TEST__.resetPerformanceAudit();
    },
    { seed: trace.seed, clock: trace.clock },
  );
  await clickTauriTestElement(browser, await browser.$(".welcome .primary"));
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      if (state?.fault) throw new Error(JSON.stringify(state.fault));
      return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
    },
    { timeout: 300_000, interval: 50, timeoutMsg: "snake TW did not reach its title input" },
  );
}

async function profilerCheckpoint() {
  const checkpoint = process.env.RUSTYERA_TAURI_PERF_CHECKPOINT;
  const resume = process.env.RUSTYERA_TAURI_PERF_RESUME;
  if (!checkpoint || !resume) return;
  await writeFile(
    checkpoint,
    JSON.stringify({
      pid: Number(process.env.RUSTYERA_TAURI_PERF_ROOT_PID),
      round: process.env.RUSTYERA_TAURI_PERF_ROUND,
    }),
    { flag: "wx" },
  );
  emit({ type: "tauri-performance-checkpoint", checkpoint });
  await browser.waitUntil(
    async () => {
      try {
        await access(resume);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 120_000,
      interval: 50,
      timeoutMsg: "performance profiler did not release checkpoint",
    },
  );
}

async function waitForControl() {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshotSummary())),
    { timeout: 20_000, interval: 50, timeoutMsg: "performance test control was not installed" },
  );
  const state = await snapshot();
  assert.equal(state.bridgeKind, "tauri");
  assert.equal(state.fault, null);
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary());
}
function emit(value) {
  console.log(JSON.stringify(value));
}

function emitPerformanceSamples(telemetry) {
  for (const sample of telemetry.frontend.timings) {
    emit({
      type: "tauri-performance-sample",
      schemaVersion: telemetry.frontend.schemaVersion,
      origin: "frontend",
      segment: sample.phase === "loading" ? "loading" : "runtime",
      ...sample,
    });
  }
  for (const sample of telemetry.native.pumps) {
    emit({
      type: "tauri-performance-sample",
      schemaVersion: telemetry.native.schemaVersion,
      origin: "native",
      segment: "runtime",
      phase: "native_pump",
      elapsedMs: sample.requestDecodeMs + sample.nativeDriveMs + sample.jsonSerializeMs,
      ...sample,
    });
  }
}
