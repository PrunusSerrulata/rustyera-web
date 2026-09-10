import assert from "node:assert/strict";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";

import { clickTauriTestElement } from "../../scripts/dom-test-input.mjs";
import { startCpuSample, finishCpuSample } from "../../scripts/tauri-performance-diagnostics.mjs";
import { readPerformanceAuditTelemetry } from "../../scripts/tauri-performance-timing-evidence.mjs";
import {
  assertVmProfileMode,
  assertVmProfileAction,
  createVmProfileCapture,
  finishProfileCapture,
} from "../../scripts/tauri-performance-vm-profile.mjs";
import {
  refreshPerformanceSession,
  performanceTelemetryCompleteness,
} from "../../scripts/tauri-performance-audit.mjs";
import {
  assertCpuWindowCapture,
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
    assertCpuWindowCapture(process.env);
    assertVmProfileMode(process.env);
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
      const samplePath = process.env.RUSTYERA_TAURI_PERF_CPU_SAMPLE;
      const cpuWindowPath = process.env.RUSTYERA_TAURI_PERF_CPU_WINDOW_LOG;
      const cpuPid = Number(process.env.RUSTYERA_TAURI_PERF_ROOT_PID);
      if (cpuWindowPath) {
        assert.ok(Number.isSafeInteger(cpuPid) && cpuPid > 0, "CPU window requires owned root PID");
        await writeFile(cpuWindowPath, "", { flag: "wx" });
      }
      const recordCpuWindow = async (kind, command) => {
        if (!cpuWindowPath) return;
        // Correlate external CPU samples with the existing action hooks. These UTC
        // markers are outside the action clock and never replace its elapsed time.
        await appendFile(
          cpuWindowPath,
          JSON.stringify({ kind, command, pid: cpuPid, utc: new Date().toISOString() }) + "\n",
        );
      };
      const sampleCommand = Number(process.env.RUSTYERA_TAURI_PERF_CPU_SAMPLE_COMMAND ?? "6");
      assert.ok(
        Number.isSafeInteger(sampleCommand) && sampleCommand > 0,
        "invalid CPU sample command",
      );
      let sample;
      const vmProfile =
        process.env.RUSTYERA_TAURI_PERF_VM_SAMPLE === "1"
          ? await createVmProfileCapture(browser, `${candidatePath}.vm-profile.jsonl`)
          : undefined;
      let candidate;
      let captureError;
      try {
        candidate = await runPerformanceTraceCapture(browser, {
          acceptanceTiming: !samplePath && !vmProfile && !cpuWindowPath,
          templatePath: tracePath,
          candidatePath,
          actionInboxPath,
          projectDigest,
          beforeTimedAction: async ({ command, settle }) => {
            if (vmProfile) assertVmProfileAction(settle);
            const profile = await vmProfile?.capture({ kind: "before", command });
            if (profile && command === 7) await assertReadOnlyVmProfile(profile);
            if (samplePath && command === sampleCommand) {
              sample = await startCpuSample(
                Number(process.env.RUSTYERA_TAURI_PERF_ROOT_PID),
                samplePath,
              );
              emit({
                type: "tauri-performance-diagnostic-only",
                acceptanceTiming: false,
                samplePath,
              });
            }
            await recordCpuWindow("before", command);
          },
          afterTimedAction: async ({ command }) => {
            await recordCpuWindow("after", command);
            const profile = await vmProfile?.capture({ kind: "after", command });
            if (profile && command === 7) await assertReadOnlyVmProfile(profile);
          },
          onObservation: async (observation) => {
            emit({ type: "tauri-performance-capture-observation", observation });
            if (samplePath && [3, 6, 7, 8, 10].includes(observation.command)) {
              const inventory = await browser.execute(() =>
                window.__RUSTYERA_TEST__.performancePresentationInventory(),
              );
              emit({
                type: "tauri-performance-presentation-inventory",
                command: observation.command,
                inventory,
              });
            }
          },
          onTimingEvidence: (evidence) =>
            emit({ type: "tauri-performance-timing-evidence", evidence }),
        });
      } catch (error) {
        captureError = { error };
        try {
          sample?.stop("capture failed");
        } catch {
          /* Preserve the capture failure. */
        }
        throw error;
      } finally {
        await finishProfileCapture(
          [
            () => vmProfile?.close(),
            () =>
              finishCpuSample(sample, (result) =>
                emit({ type: "tauri-performance-cpu-sample", result }),
              ),
          ],
          captureError,
        );
      }
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
    const telemetry = await readPerformanceAuditTelemetry(browser);
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
      telemetry: {
        ...performanceTelemetryCompleteness(telemetry),
        frontend: {
          schemaVersion: telemetry.frontend.schemaVersion,
          epoch: telemetry.frontend.epoch,
          timingSamples: telemetry.frontend.timings.length,
          dropped: telemetry.frontend.timingSamplesDropped,
          longTasksDropped: telemetry.frontend.longTasksDropped,
        },
        native: {
          schemaVersion: telemetry.native.schemaVersion,
          epoch: telemetry.native.epoch,
          pumpSamples: telemetry.native.pumps.length,
          dropped: telemetry.native.dropped,
        },
      },
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

async function assertReadOnlyVmProfile(expected) {
  const json = await browser.execute(async () =>
    JSON.stringify(
      await window.__TAURI_INTERNALS__.invoke("performance_audit_instruction_profile"),
    ),
  );
  assert.deepEqual(
    JSON.parse(json),
    expected,
    "omitting begin must not reset or close the live VM window",
  );
}

async function startRun(trace) {
  const projectCopy = process.env.RUSTYERA_TAURI_PERF_PROJECT_COPY;
  assert.ok(projectCopy, "runner must supply the validated performance project copy");
  await refreshPerformanceSession(browser, projectCopy, waitForControl);
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
      const state = await browser.execute(() => window.__RUSTYERA_TEST__.performanceProgress());
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
    () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.performanceProgress)),
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
