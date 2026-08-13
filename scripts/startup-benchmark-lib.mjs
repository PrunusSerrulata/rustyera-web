export const STARTUP_SCENARIOS = {
  "browser-exact-cold": { host: "browser", trust: false, index: false, cache: false },
  "browser-trusted-cold": { host: "browser", trust: true, index: true, cache: false },
  "browser-exact-warm": { host: "browser", trust: false, index: false, cache: true },
  "browser-trusted-warm": { host: "browser", trust: true, index: true, cache: true },
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
  for (const milestone of [
    "runtimeValidationReportedMs",
    "frontendReadyToStartMs",
    "startSubmittedMs",
    "firstGamePhaseMs",
  ]) {
    requireFinite(telemetry.milestones?.[milestone], `${scenarioName}.${milestone}`);
  }
  for (const field of HOST_DURATIONS) {
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
  }
  return sample;
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
