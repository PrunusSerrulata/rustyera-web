export const CONSTRAINED_MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

export const STARTUP_SCENARIOS = {
  "browser-exact-cold": {
    host: "browser",
    trust: false,
    index: false,
    cache: false,
    constrained: true,
  },
  "browser-trusted-cold": {
    host: "browser",
    trust: true,
    index: true,
    cache: false,
    constrained: true,
  },
  "browser-exact-warm": {
    host: "browser",
    trust: false,
    index: false,
    cache: true,
    constrained: false,
  },
  "browser-trusted-warm": {
    host: "browser",
    trust: true,
    index: true,
    cache: true,
    constrained: false,
  },
  "browser-project-file": {
    host: "browser",
    projectFile: true,
    cache: true,
    constrained: true,
  },
  "tauri-cold-no-index": { host: "tauri", index: false, cache: false },
  "tauri-cold-indexed": { host: "tauri", index: true, cache: false },
  "tauri-warm": { host: "tauri", index: true, cache: true },
};

const COLD_CORE_DURATIONS = [
  "normalizeMs",
  "csvMs",
  "parseMs",
  "analyzeMs",
  "compileMs",
  "finalizeMs",
  "validateMs",
  "prepareMs",
];
const WARM_CORE_DURATIONS = ["cacheParseMs", "cacheDecodeMs", "cacheValidateMs", "prepareMs"];
const HOST_DURATIONS = [
  "enumerateMs",
  "indexReadMs",
  "indexWriteMs",
  "statMs",
  "sourceReadDecodeHashMs",
  "cacheReadMs",
  "submissionTransferMs",
];

export function validateStartupSample(sample, scenarioName) {
  const scenario = STARTUP_SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown startup scenario: ${scenarioName}`);
  const telemetry = sample.telemetry;
  if (!telemetry || telemetry.outcome !== "success")
    throw new Error(`${scenarioName} did not complete startup: ${JSON.stringify(telemetry)}`);
  if (telemetry.cacheHit !== scenario.cache)
    throw new Error(`${scenarioName} cache proof mismatch: ${String(telemetry.cacheHit)}`);
  const expectedScenario = scenario.projectFile ? "project_file" : scenario.cache ? "warm" : "cold";
  if (telemetry.scenario !== expectedScenario)
    throw new Error(
      `${scenarioName} startup identity mismatch: expected ${expectedScenario}, got ${String(telemetry.scenario)}`,
    );
  for (const milestone of [
    "runtimeValidationReportedMs",
    "frontendReadyToStartMs",
    "startSubmittedMs",
    "firstGamePhaseMs",
  ]) {
    requireFinite(telemetry.milestones?.[milestone], `${scenarioName}.${milestone}`);
  }
  const hostDurations = scenario.projectFile
    ? ["cacheReadMs", "submissionTransferMs"]
    : HOST_DURATIONS;
  for (const field of hostDurations) {
    requireFinite(telemetry.durations?.[field], `${scenarioName}.durations.${field}`);
  }
  for (const field of scenario.cache ? WARM_CORE_DURATIONS : COLD_CORE_DURATIONS) {
    requireFinite(telemetry.durations?.[field], `${scenarioName}.durations.${field}`);
  }
  requireFinite(sample.peakRssBytes, `${scenarioName}.peakRssBytes`);
  const index = telemetry.sourceIndex;
  if (scenario.index && index?.present !== true)
    throw new Error(`${scenarioName} did not observe its prepared source index`);
  if (scenario.trust === true && !(index?.reusedFiles > 0) && index?.hashedFiles !== 0)
    throw new Error(`${scenarioName} did not reuse the trusted source index`);
  if (scenario.trust === false && index?.reusedFiles !== 0)
    throw new Error(`${scenarioName} unexpectedly reused source metadata`);
  if (scenario.host === "browser") {
    const expectedMode = "single";
    if (telemetry.wasmMode !== expectedMode)
      throw new Error(
        `${scenarioName} expected ${expectedMode} WASM, got ${String(telemetry.wasmMode)}`,
      );
    requireFinite(telemetry.wasmMemory?.peakBytes, `${scenarioName}.wasmMemory.peakBytes`);
    if (scenario.constrained && telemetry.wasmMemory?.constrained !== true)
      throw new Error(`${scenarioName} did not use the constrained-memory browser bridge`);
  }
  return sample;
}

export function browserBenchmarkCommandArgs({
  scenario,
  project,
  projectFile,
  trace,
  constrained = true,
}) {
  const command = [
    "scripts/web-test.mjs",
    "run",
    "--scenario",
    scenario,
    "--project",
    project,
    "--trace",
    trace,
  ];
  if (constrained) command.push("--user-agent", CONSTRAINED_MOBILE_USER_AGENT);
  if (projectFile) command.push("--project-file", projectFile);
  return command;
}

export function compareDirectoryAndProjectFile(directory, projectFile) {
  if (directory.samples.length !== projectFile.samples.length)
    throw new Error("directory and project-file baselines must use the same sample count");
  return {
    sampleCount: directory.samples.length,
    wasmMemoryPeakBytes: compareMetric(
      directory.metrics["telemetry.wasmMemory.peakBytes"],
      projectFile.metrics["telemetry.wasmMemory.peakBytes"],
    ),
    peakRssBytes: compareMetric(directory.metrics.peakRssBytes, projectFile.metrics.peakRssBytes),
  };
}

export function latestSuccessfulStartupTelemetry(events) {
  const telemetry = events
    .map(
      (event) =>
        event.rust?.frontend?.startupTelemetry ??
        event.runtime?.startupTelemetry ??
        event.startupTelemetry,
    )
    .filter((value) => value?.outcome === "success")
    .at(-1);
  if (!telemetry) throw new Error("dynamic runner did not report successful startup telemetry");
  return telemetry;
}

function compareMetric(directory, projectFile) {
  if (!directory || !projectFile) throw new Error("baseline comparison metric is missing");
  const compare = (percentileName) => ({
    directory: directory[percentileName],
    projectFile: projectFile[percentileName],
    delta: directory[percentileName] - projectFile[percentileName],
    ratio:
      projectFile[percentileName] === 0
        ? null
        : directory[percentileName] / projectFile[percentileName],
  });
  return { p50: compare("p50"), p95: compare("p95") };
}

export function summarizeStartupSamples(samples) {
  const numericPaths = new Set();
  for (const sample of samples) collectNumericPaths(sample, "", numericPaths);
  const metrics = {};
  for (const path of [...numericPaths].sort()) {
    const values = samples.map((sample) => valueAt(sample, path)).filter(Number.isFinite);
    if (values.length !== samples.length) continue;
    metrics[path] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
  }
  return { samples, metrics };
}

export function percentile(values, fraction) {
  if (!values.length) throw new Error("cannot calculate a percentile without samples");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function requireFinite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`startup telemetry is incomplete: ${name}`);
}

function collectNumericPaths(value, prefix, output) {
  if (Number.isFinite(value)) {
    output.add(prefix);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectNumericPaths(child, prefix ? `${prefix}.${key}` : key, output);
  }
}

function valueAt(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}
