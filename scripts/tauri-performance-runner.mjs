import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  capturePerformanceProcessTree,
  classifyWindowCalibration,
  performanceProjectDigest,
  performanceWindowArguments,
  performanceWindowMode,
  validatePerformanceAuditProject,
} from "./tauri-performance-audit.mjs";
import {
  readPerformanceTrace,
  summarizeRuns,
  summarizeSamples,
} from "./tauri-performance-trace.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const auditDeadline = Date.now() + 60 * 60 * 1_000;
const arguments_ = process.argv.slice(2);
const project = option("--project");
const output = option("--output");
const trace = option("--trace");
const requestedWindowMode = performanceWindowMode(arguments_);
rejectUnknown(arguments_, new Set(["--project", "--output", "--trace", "--window-mode"]));
const identity = await validatePerformanceAuditProject(project);
const outputParent = await realpath(path.dirname(output));
const resolvedOutput = path.join(outputParent, path.basename(output));
const relativeOutput = path.relative(identity.source, resolvedOutput);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)))
  throw new Error("--output must be outside the read-only source project");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0)
  throw new Error("--output must name an empty isolated evidence directory");
identity.manifestSha256 = await performanceProjectDigest(identity.source);
const traceIdentity = await readPerformanceTrace(trace);
const traceSha256 = await sha256(trace);
if (traceIdentity.projectDigest !== identity.manifestSha256)
  throw new Error("frozen trace projectDigest does not match the selected snake TW source");
let buildPrepared = false;

const { calibration, evidence: calibrationEvidence } = await calibrateWindow(requestedWindowMode);
await writeEvidence("calibration.json", { identity, ...calibrationEvidence, calibration });

const warmup = await runAudit("warmup", calibration.selectedMode);
const baselineRuns = [];
for (let index = 0; index < 5; index += 1)
  baselineRuns.push(
    await runAudit(`baseline-${index + 1}`, calibration.selectedMode, [], "baseline"),
  );
const baseline = {
  runs: baselineRuns,
  summary: summarizeRuns(baselineRuns.flatMap((entry) => entry.result?.runs ?? [])),
  telemetrySegments: summarizeTelemetrySamples(
    baselineRuns.flatMap((entry) => performanceSamplesFromResult(entry.result)),
  ),
};
const cpu = await runAudit("cpu", calibration.selectedMode, ["sample"]);
const allocation = await runAudit("allocation", calibration.selectedMode, [
  "heap",
  "vmmap",
  "leaks",
  "malloc_history",
]);
const baselineMedian = Number(
  Object.values(baseline.summary.byPath).reduce(
    (total, sample) => total + Number(sample.p50 ?? 0),
    0,
  ),
);
for (const profile of [cpu, allocation]) {
  const profileMedian = Number(
    Object.values(profile.result?.summary?.byPath ?? {}).reduce(
      (total, sample) => total + Number(sample.p50 ?? 0),
      0,
    ),
  );
  profile.overheadPercent =
    Number.isFinite(baselineMedian) && baselineMedian > 0 && Number.isFinite(profileMedian)
      ? ((profileMedian - baselineMedian) / baselineMedian) * 100
      : null;
  profile.absoluteTimingAllowed = profile.overheadPercent != null && profile.overheadPercent <= 5;
}
await writeEvidence("audit-summary.json", {
  identity,
  traceIdentity: { scenario: traceIdentity.scenario, digest: traceIdentity.traceDigest },
  traceSha256,
  calibration,
  warmup,
  baseline,
  cpu,
  allocation,
});
const evidenceFiles = (await readdir(output))
  .filter((name) => name !== "evidence-manifest.json")
  .sort();
await writeEvidence(
  "evidence-manifest.json",
  Object.fromEntries(
    await Promise.all(
      evidenceFiles.map(async (name) => [name, await sha256(path.join(output, name))]),
    ),
  ),
);

async function runAudit(round, mode, profilers = [], measuredRound = round) {
  requireRemainingBudget(`starting ${round}/${mode}`);
  const checkpoint = path.join(output, `${round}.checkpoint.json`);
  const resume = path.join(output, `${round}.resume`);
  const environment = {
    ...process.env,
    RUSTYERA_TAURI_PERF_PHASE: round === "calibration" ? "calibration" : "measurement",
    RUSTYERA_TAURI_PERF_ROUND: measuredRound,
    RUSTYERA_TAURI_PERF_TRACE: trace,
    RUSTYERA_TEST_WALL_CLOCK_DEADLINE_MS: String(auditDeadline),
    ...(profilers.includes("malloc_history") ? { MallocStackLogging: "1" } : {}),
    ...(profilers.length
      ? { RUSTYERA_TAURI_PERF_CHECKPOINT: checkpoint, RUSTYERA_TAURI_PERF_RESUME: resume }
      : {}),
  };
  const args = [
    "scripts/tauri-test.mjs",
    "--perf-audit",
    "--release",
    buildPrepared ? "--require-reuse-build" : "--reuse-build",
    "--project",
    project,
    "--spec",
    "tests/tauri/snake-runtime-performance.spec.mjs",
    ...performanceWindowArguments(mode),
  ];
  const child = spawn(process.execPath, args, {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const profilerTask = profilers.length
    ? attachProfilers(checkpoint, resume, profilers)
    : Promise.resolve([]);
  const exitCode = await deadlinePromise(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    () => child.kill("SIGTERM"),
    `waiting for ${round}/${mode}`,
  );
  const profiles = await profilerTask;
  await writeEvidence(`${round}-${mode}.stdout.txt`, stdout);
  await writeEvidence(`${round}-${mode}.stderr.txt`, stderr);
  if (exitCode !== 0) throw new Error(`${round}/${mode} performance child exited ${exitCode}`);
  buildPrepared = true;
  const records = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return {
    round,
    mode,
    calibration: records.findLast((record) => record.type === "tauri-performance-calibration")
      ?.calibration,
    result: records.findLast((record) => record.type === "tauri-snake-runtime-performance"),
    telemetrySegments: summarizeTelemetrySegments(records),
    profiles,
  };
}

async function calibrateWindow(mode) {
  if (mode === "minimized") {
    const minimized = await runAudit("calibration", "minimized");
    const offscreen = await runAudit("calibration", "offscreen");
    const calibration = {
      requestedMode: mode,
      ...classifyWindowCalibration(minimized.calibration, offscreen.calibration),
    };
    if (!calibration.offscreenUsable)
      throw new Error("off-screen no-focus calibration did not produce 100 usable frames");
    return { calibration, evidence: { minimized, offscreen } };
  }
  const selected = await runAudit("calibration", mode);
  const sample = selected.calibration;
  const usable =
    sample?.timedOut !== true &&
    Number(sample?.observedFrames ?? 0) === Number(sample?.requestedFrames ?? 100) &&
    (mode === "visible" || Number(sample?.nonBusinessStallsOver100Ms ?? 0) === 0);
  if (!usable) throw new Error(`${mode} calibration did not produce 100 usable frames`);
  return {
    calibration: { requestedMode: mode, selectedMode: mode, usable },
    evidence: { [mode]: selected },
  };
}

function summarizeTelemetrySegments(records) {
  return summarizeTelemetrySamples(
    records.filter((record) => record.type === "tauri-performance-sample"),
  );
}

function performanceSamplesFromResult(result) {
  if (!result?.telemetry) return [];
  const frontend = (result.telemetry.frontend?.timings ?? []).map((sample) => ({
    ...sample,
    origin: "frontend",
    segment: sample.phase === "loading" ? "loading" : "runtime",
  }));
  const native = (result.telemetry.native?.pumps ?? []).map((sample) => ({
    ...sample,
    origin: "native",
    segment: "runtime",
    phase: "native_pump",
    elapsedMs: sample.requestDecodeMs + sample.nativeDriveMs + sample.jsonSerializeMs,
  }));
  return [...frontend, ...native];
}

function summarizeTelemetrySamples(samples) {
  const measured = samples.filter(
    (record) =>
      ["loading", "runtime"].includes(record.segment) && Number.isFinite(record.elapsedMs),
  );
  return Object.fromEntries(
    ["loading", "runtime"].map((segment) => {
      const segmentSamples = measured.filter((sample) => sample.segment === segment);
      const phases = [...new Set(segmentSamples.map((sample) => sample.phase))].sort();
      return [
        segment,
        {
          count: segmentSamples.length,
          byPhase: Object.fromEntries(
            phases.map((phase) => [
              phase,
              summarizeSamples(
                segmentSamples
                  .filter((sample) => sample.phase === phase)
                  .map((sample) => sample.elapsedMs),
              ),
            ]),
          ),
        },
      ];
    }),
  );
}

async function attachProfilers(checkpoint, resume, profilers) {
  for (;;) {
    try {
      await access(checkpoint);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    requireRemainingBudget(`waiting for profiler checkpoint ${path.basename(checkpoint)}`);
  }
  const { pid } = JSON.parse(await readFile(checkpoint, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("profiler checkpoint omitted exact Tauri PID");
  const profiles = [];
  const processTree = await capturePerformanceProcessTree(pid);
  for (const profiler of profilers) {
    const targets = profiler === "sample" ? processTree.map((process) => process.pid) : [pid];
    for (const targetPid of targets) {
      const destination = path.join(
        output,
        `${path.basename(checkpoint, ".checkpoint.json")}.${profiler}.${targetPid}.txt`,
      );
      const command = profilerCommand(profiler, targetPid, destination);
      const exitCode = command.capture
        ? await spawnCapture(command.executable, command.arguments, destination)
        : await spawnExit(command.executable, command.arguments);
      if (exitCode !== 0) throw new Error(`${profiler} for PID ${targetPid} exited ${exitCode}`);
      profiles.push({ profiler, pid: targetPid, destination, sha256: await sha256(destination) });
    }
  }
  await writeFile(resume, "resume\n", { flag: "wx" });
  return profiles;
}

function profilerCommand(profiler, pid, destination) {
  if (process.platform !== "darwin")
    throw new Error("native audit profilers currently require macOS");
  if (profiler === "sample")
    return {
      executable: "/usr/bin/sample",
      arguments: [String(pid), "10", "1", "-file", destination],
      capture: false,
    };
  if (profiler === "heap")
    return {
      executable: "/usr/bin/heap",
      arguments: ["-addresses", "all", String(pid)],
      capture: true,
    };
  if (profiler === "vmmap")
    return { executable: "/usr/bin/vmmap", arguments: ["-summary", String(pid)], capture: true };
  if (profiler === "leaks")
    return { executable: "/usr/bin/leaks", arguments: [String(pid)], capture: true };
  if (profiler === "malloc_history")
    return {
      executable: "/usr/bin/malloc_history",
      arguments: [String(pid), "-allBySize"],
      capture: true,
    };
  throw new Error(`unknown profiler ${profiler}`);
}

async function writeEvidence(name, value) {
  const destination = path.join(output, name);
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(destination, bytes);
  return { destination, sha256: await sha256(destination) };
}
async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
async function spawnExit(executable, args) {
  let child;
  return deadlinePromise(
    new Promise((resolve, reject) => {
      child = spawn(executable, args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    () => child?.kill("SIGTERM"),
    executable,
  );
}
async function spawnCapture(executable, args, destination) {
  let child;
  return deadlinePromise(
    new Promise((resolve, reject) => {
      child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
      child.once("error", reject);
      child.once("exit", async (code) => {
        try {
          await writeFile(destination, Buffer.concat(chunks));
          resolve(code);
        } catch (error) {
          reject(error);
        }
      });
    }),
    () => child?.kill("SIGTERM"),
    executable,
  );
}
function requireRemainingBudget(stage) {
  if (Date.now() >= auditDeadline)
    throw new Error(`Tauri performance audit exceeded its shared 60-minute budget while ${stage}`);
}
function deadlinePromise(operation, terminate, stage) {
  requireRemainingBudget(stage);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        terminate();
        reject(
          new Error(`Tauri performance audit exceeded its shared 60-minute budget while ${stage}`),
        );
      },
      Math.max(1, auditDeadline - Date.now()),
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function option(name) {
  const indexes = arguments_.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length !== 1) throw new Error(`${name} must be specified exactly once`);
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return path.resolve(repository, value);
}
function rejectUnknown(args, options) {
  for (let index = 0; index < args.length; index += 2) {
    if (!options.has(args[index]))
      throw new Error(`unsupported performance runner option ${args[index]}`);
    if (args[index + 1] == null) throw new Error(`${args[index]} requires a value`);
  }
}
