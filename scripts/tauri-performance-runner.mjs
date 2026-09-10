import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { terminateOwnedChild, withOwnedChildCleanup } from "./owned-child-process.mjs";

import {
  capturePerformanceProcessTree,
  ensurePerformanceProjectCopy,
  performanceWindowArguments,
  performanceWindowMode,
  performanceProfilerMode,
  validatePerformanceAuditProject,
} from "./tauri-performance-audit.mjs";
import {
  readPerformanceTrace,
  summarizeRuns,
  summarizeSamples,
} from "./tauri-performance-trace.mjs";

class EvidenceMeter extends Transform {
  bytes = 0;
  #hash = createHash("sha256");

  constructor(maximumBytes) {
    super();
    this.maximumBytes = maximumBytes;
  }

  _transform(chunk, _encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maximumBytes) {
      callback(new Error("performance evidence stream exceeds its 512 MiB raw limit"));
      return;
    }
    this.#hash.update(chunk);
    callback(null, chunk);
  }

  digest() {
    return this.#hash.digest("hex");
  }
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const auditDeadline = Date.now() + 60 * 60 * 1_000;
const MAXIMUM_RAW_EVIDENCE_STREAM_BYTES = 512 * 1024 * 1024;
const MAXIMUM_SUMMARY_LINE_BYTES = 8 * 1024 * 1024;
const arguments_ = process.argv.slice(2);
const project = option("--project");
const projectCopy = option("--project-copy");
const output = option("--output");
const trace = option("--trace");
const requestedWindowMode = performanceWindowMode(arguments_);
const profilerMode = performanceProfilerMode(arguments_);
rejectUnknown(
  arguments_,
  new Set(["--project", "--project-copy", "--output", "--trace", "--window-mode", "--profilers"]),
);
const identity = await validatePerformanceAuditProject(project);
const preparedCopy = await ensurePerformanceProjectCopy(identity.source, projectCopy);
const outputParent = await realpath(path.dirname(output));
const resolvedOutput = path.join(outputParent, path.basename(output));
const relativeOutput = path.relative(identity.source, resolvedOutput);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)))
  throw new Error("--output must be outside the read-only source project");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0)
  throw new Error("--output must name an empty isolated evidence directory");
identity.manifestSha256 = preparedCopy.projectDigest;
identity.projectCopy = preparedCopy.copy;
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
    baselineRuns.flatMap((entry) => entry.telemetrySamples),
  ),
};
const cpu =
  profilerMode === "native" ? await runAudit("cpu", calibration.selectedMode, ["sample"]) : null;
const allocation =
  profilerMode === "native"
    ? await runAudit("allocation", calibration.selectedMode, [
        "heap",
        "vmmap",
        "leaks",
        "malloc_history",
      ])
    : null;
const baselineMedian = Number(
  Object.values(baseline.summary.byPath).reduce(
    (total, sample) => total + Number(sample.p50 ?? 0),
    0,
  ),
);
for (const profile of [cpu, allocation].filter(Boolean)) {
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
  profiling: { mode: profilerMode, performed: profilerMode === "native" },
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
    RUSTYERA_TAURI_PERF_PROJECT_COPY: preparedCopy.copy,
    RUSTYERA_TAURI_PERF_PROJECT_DIGEST: preparedCopy.projectDigest,
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
  const records = [];
  let stdoutTail = "";
  let stderrTail = "";
  let parseFailure;
  child.stdout.on("data", (chunk) => {
    const lines = `${stdoutTail}${chunk}`.split(/\r?\n/);
    stdoutTail = lines.pop() ?? "";
    if (Buffer.byteLength(stdoutTail) > MAXIMUM_SUMMARY_LINE_BYTES) {
      parseFailure = new Error("performance child emitted a summary line larger than 8 MiB");
      terminateOwnedChild(child);
      return;
    }
    for (const line of lines) retainSummaryRecord(records, line);
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-16_384);
  });
  const stdoutArchive = startEvidenceArchive(
    child.stdout,
    path.join(output, `${round}-${mode}.stdout.txt.gz`),
    () => terminateOwnedChild(child),
  );
  const stderrArchive = startEvidenceArchive(
    child.stderr,
    path.join(output, `${round}-${mode}.stderr.txt.gz`),
    () => terminateOwnedChild(child),
  );
  const profilerTask = profilers.length
    ? attachProfilers(checkpoint, resume, profilers)
    : Promise.resolve([]);
  let stdoutEvidence;
  let stderrEvidence;
  const [exitCode, profiles] = await withOwnedChildCleanup(
    child,
    () =>
      Promise.all([
        deadlinePromise(
          new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
          }),
          () => terminateOwnedChild(child),
          `waiting for ${round}/${mode}`,
        ),
        profilerTask,
      ]),
    [
      async () => {
        stdoutEvidence = await stdoutArchive.finish();
      },
      async () => {
        stderrEvidence = await stderrArchive.finish();
      },
    ],
  );
  retainSummaryRecord(records, stdoutTail);
  if (parseFailure) throw parseFailure;
  if (exitCode !== 0) {
    if (stderrTail) process.stderr.write(stderrTail);
    throw new Error(`${round}/${mode} performance child exited ${exitCode}`);
  }
  buildPrepared = true;
  const audit = {
    round,
    mode,
    calibration: records.findLast((record) => record.type === "tauri-performance-calibration")
      ?.calibration,
    result: records.findLast((record) => record.type === "tauri-snake-runtime-performance"),
    telemetrySegments: summarizeTelemetrySegments(records),
    logs: { stdout: stdoutEvidence, stderr: stderrEvidence },
    profiles,
  };
  Object.defineProperty(audit, "telemetrySamples", {
    value: records.filter((record) => record.type === "tauri-performance-sample"),
    enumerable: false,
  });
  return audit;
}

function retainSummaryRecord(records, line) {
  if (!line) return;
  try {
    const record = JSON.parse(line);
    if (record.type === "tauri-performance-sample")
      records.push({
        type: record.type,
        origin: record.origin,
        segment: record.segment,
        phase: record.phase,
        elapsedMs: record.elapsedMs,
      });
    else if (record.type === "tauri-snake-runtime-performance") {
      const summary = { ...record };
      delete summary.telemetry;
      records.push(summary);
    } else if (record.type === "tauri-performance-calibration") records.push(record);
  } catch {
    // Human-readable child diagnostics remain in the compressed raw stream.
  }
}

async function calibrateWindow(mode) {
  const measured = await runAudit("calibration", mode);
  const sample = measured.calibration;
  const usable =
    sample?.timedOut !== true &&
    Number(sample?.observedFrames ?? 0) === Number(sample?.requestedFrames ?? 100);
  if (!usable) throw new Error(`${mode} calibration did not produce 100 usable frames`);
  return {
    calibration: { requestedMode: mode, selectedMode: mode, usable },
    evidence: { [mode]: measured },
  };
}

function summarizeTelemetrySegments(records) {
  return summarizeTelemetrySamples(
    records.filter((record) => record.type === "tauri-performance-sample"),
  );
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
      const archivedDestination = `${destination}.gz`;
      const captured = command.capture
        ? await spawnCapture(command.executable, command.arguments, archivedDestination)
        : {
            exitCode: await spawnExit(command.executable, command.arguments, destination),
            archive: undefined,
          };
      const exitCode = captured.exitCode;
      if (exitCode !== 0) throw new Error(`${profiler} for PID ${targetPid} exited ${exitCode}`);
      const archive = captured.archive ?? (await gzipFile(destination, archivedDestination));
      profiles.push({
        profiler,
        pid: targetPid,
        destination: archivedDestination,
        rawBytes: archive.rawBytes,
        rawSha256: archive.rawSha256,
        compressedSha256: archive.compressedSha256,
      });
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
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function spawnExit(executable, args, boundedOutput) {
  let child;
  let outputFailure;
  let outputMonitor;
  return deadlinePromise(
    new Promise((resolve, reject) => {
      child = spawn(executable, args, { stdio: "inherit" });
      child.once("error", reject);
      if (boundedOutput)
        outputMonitor = setInterval(async () => {
          try {
            if ((await stat(boundedOutput)).size > MAXIMUM_RAW_EVIDENCE_STREAM_BYTES) {
              outputFailure = new Error(
                `${executable} output exceeds its 512 MiB raw evidence limit`,
              );
              terminateOwnedChild(child);
            }
          } catch (error) {
            if (error.code !== "ENOENT") {
              outputFailure = error;
              terminateOwnedChild(child);
            }
          }
        }, 250);
      child.once("exit", async (code) => {
        if (outputMonitor) clearInterval(outputMonitor);
        try {
          if (
            boundedOutput &&
            !outputFailure &&
            (await stat(boundedOutput)).size > MAXIMUM_RAW_EVIDENCE_STREAM_BYTES
          )
            outputFailure = new Error(
              `${executable} output exceeds its 512 MiB raw evidence limit`,
            );
          if (outputFailure) {
            if (boundedOutput) await rm(boundedOutput, { force: true });
            reject(outputFailure);
          } else resolve(code);
        } catch (error) {
          reject(error);
        }
      });
    }),
    () => terminateOwnedChild(child),
    executable,
  );
}
async function spawnCapture(executable, args, destination) {
  let child;
  return deadlinePromise(
    new Promise((resolve, reject) => {
      child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      const merged = new PassThrough();
      let openStreams = 2;
      const closeInput = () => {
        openStreams -= 1;
        if (openStreams === 0) merged.end();
      };
      child.stdout.pipe(merged, { end: false });
      child.stderr.pipe(merged, { end: false });
      child.stdout.once("end", closeInput);
      child.stderr.once("end", closeInput);
      const archive = startEvidenceArchive(merged, destination, () => terminateOwnedChild(child));
      child.once("error", reject);
      child.once("exit", async (code) => {
        try {
          resolve({ exitCode: code, archive: await archive.finish() });
        } catch (error) {
          reject(error);
        }
      });
    }),
    () => terminateOwnedChild(child),
    executable,
  );
}
async function gzipFile(source, destination) {
  try {
    const archive = startEvidenceArchive(createReadStream(source), destination);
    const result = await archive.finish();
    await rm(source);
    return result;
  } catch (error) {
    await Promise.all([rm(source, { force: true }), rm(destination, { force: true })]);
    throw error;
  }
}
function startEvidenceArchive(source, destination, onLimit = () => undefined) {
  const meter = new EvidenceMeter(MAXIMUM_RAW_EVIDENCE_STREAM_BYTES);
  let failure;
  const completion = pipeline(
    source,
    meter,
    createGzip({ level: 9 }),
    createWriteStream(destination, { flags: "wx" }),
  ).catch((error) => {
    failure = error;
    onLimit();
  });
  return {
    async finish() {
      await completion;
      if (failure) {
        await rm(destination, { force: true });
        throw failure;
      }
      return {
        destination,
        rawBytes: meter.bytes,
        rawSha256: meter.digest(),
        compressedSha256: await sha256(destination),
      };
    },
  };
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
