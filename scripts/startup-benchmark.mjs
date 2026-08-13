#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STARTUP_SCENARIOS,
  summarizeStartupSamples,
  validateStartupSample,
} from "./startup-benchmark-lib.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const project = path.resolve(args.project ?? path.join(repository, "../games/eraTW"));
const samples = Number.parseInt(args.samples ?? "5", 10);
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be positive");
const selected = args.scenario
  ? args.scenario.split(",")
  : Object.keys(STARTUP_SCENARIOS).filter(
      (name) => !args.host || STARTUP_SCENARIOS[name].host === args.host,
    );
for (const name of selected) if (!STARTUP_SCENARIOS[name]) throw new Error(`unknown ${name}`);

const sourceIndex = path.resolve(
  args.source_index ?? path.join(project, ".rustyera/cache/source-index-v1.json"),
);
const compiledCache = path.resolve(
  args.compiled_cache ?? path.join(project, ".rustyera/cache/compiled-project.reracache"),
);
for (const name of selected) {
  const scenario = STARTUP_SCENARIOS[name];
  if (scenario.index) await requireFile(sourceIndex, `${name} source index`);
  if (scenario.cache) await requireFile(compiledCache, `${name} compiled cache`);
}

const report = { project, samples, scenarios: {}, generatedAt: new Date().toISOString() };
for (const name of selected) {
  const scenarioSamples = [];
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const sample =
      STARTUP_SCENARIOS[name].host === "browser"
        ? await runBrowserSample(name, sampleIndex)
        : await runTauriSample(name, sampleIndex);
    scenarioSamples.push(validateStartupSample(sample, name));
  }
  report.scenarios[name] = summarizeStartupSamples(scenarioSamples);
}
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) await writeFile(path.resolve(args.output), encoded);
process.stdout.write(encoded);

async function runBrowserSample(name, sampleIndex) {
  const scenario = STARTUP_SCENARIOS[name];
  const temporary = await mkdtemp(path.join(tmpdir(), `rustyera-${name}-`));
  const trace = path.join(temporary, `sample-${sampleIndex}.ndjson`);
  try {
    const environment = {
      ...process.env,
      VITE_RUSTYERA_TEST_TRUST_METADATA: scenario.trust ? "1" : "0",
      RUSTYERA_TEST_SOURCE_INDEX_INPUT: scenario.index ? sourceIndex : "",
      RUSTYERA_TEST_COMPILED_CACHE_INPUT: scenario.cache ? compiledCache : "",
    };
    const execution = await runObserved(
      process.execPath,
      [
        "scripts/web-test.mjs",
        "run",
        "--scenario",
        args.browser_scenario ?? "tools/runtime-tester/scenarios/project-smoke.json",
        "--project",
        project,
        "--trace",
        trace,
      ],
      environment,
    );
    const telemetry = await telemetryFromTrace(trace);
    return { sample: sampleIndex + 1, peakRssBytes: execution.peakRssBytes, telemetry };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runTauriSample(name, sampleIndex) {
  const scenario = STARTUP_SCENARIOS[name];
  const temporary = await mkdtemp(path.join(tmpdir(), `rustyera-${name}-`));
  const projectCopy = path.join(temporary, path.basename(project));
  try {
    await cp(project, projectCopy, { recursive: true });
    const cacheDirectory = path.join(projectCopy, ".rustyera", "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await prepareArtifact(cacheDirectory, "source-index-v1.json", scenario.index && sourceIndex);
    await prepareArtifact(
      cacheDirectory,
      "compiled-project.reracache",
      scenario.cache && compiledCache,
    );
    const execution = await runObserved(
      process.execPath,
      [
        "scripts/tauri-test.mjs",
        "--project",
        projectCopy,
        "--spec",
        "tests/tauri/project-smoke.spec.mjs",
      ],
      process.env,
    );
    const telemetry = latestTelemetry(execution.jsonLines);
    return { sample: sampleIndex + 1, peakRssBytes: execution.peakRssBytes, telemetry };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runObserved(command, commandArgs, environment) {
  const child = spawn(command, commandArgs, {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let peakRssBytes = 0;
  const jsonLines = [];
  const consume = (stream) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      process.stderr.write(chunk);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          jsonLines.push(JSON.parse(line));
        } catch {
          // Build logs and test-runner output are intentionally retained on stderr.
        }
      }
    });
  };
  consume(child.stdout);
  consume(child.stderr);
  const monitor = setInterval(async () => {
    peakRssBytes = Math.max(peakRssBytes, await descendantRssBytes(child.pid));
  }, 100);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  clearInterval(monitor);
  peakRssBytes = Math.max(peakRssBytes, await descendantRssBytes(child.pid));
  if (exitCode !== 0) throw new Error(`${commandArgs[0]} exited with ${exitCode}`);
  return { peakRssBytes, jsonLines };
}

async function descendantRssBytes(rootPid) {
  if (!rootPid) return 0;
  try {
    const output = await execFilePromise("ps", ["-axo", "pid=,ppid=,rss="]);
    const rows = output
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every(Number.isFinite));
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    return rows
      .filter(([pid]) => descendants.has(pid))
      .reduce((total, [, , rssKiB]) => total + rssKiB * 1024, 0);
  } catch {
    return 0;
  }
}

function execFilePromise(command, commandArgs) {
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, { encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

async function telemetryFromTrace(trace) {
  const lines = (await readFile(trace, "utf8")).trim().split("\n");
  return latestTelemetry(lines.map((line) => JSON.parse(line)));
}

function latestTelemetry(events) {
  const telemetry = events
    .map((event) => event.runtime?.startupTelemetry ?? event.startupTelemetry)
    .filter((value) => value?.outcome === "success")
    .at(-1);
  if (!telemetry) throw new Error("dynamic runner did not report successful startup telemetry");
  return telemetry;
}

async function prepareArtifact(directory, name, source) {
  const destination = path.join(directory, name);
  await rm(destination, { force: true });
  if (source) await cp(source, destination);
}

async function requireFile(file, label) {
  if (!(await stat(file)).isFile()) throw new Error(`${label} is not a file: ${file}`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    parsed[key.slice(2).replaceAll("-", "_")] = values[++index];
  }
  return parsed;
}
