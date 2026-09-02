#!/usr/bin/env node
/* global window */

import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Mocha from "mocha";

import {
  focusCurrentTauriWindow,
  resolveTauriBinary,
  startTauriSessionMonitor,
} from "./tauri-test-support.mjs";
import {
  buildContract,
  recordBuiltArtifact,
  reusableArtifact,
  reusableBuildEnvironment,
} from "./tauri-build-cache.mjs";
import {
  nativeWebdriverOption,
  validateNativeWebdriverSource,
} from "./tauri-native-webdriver-support.mjs";
import {
  allowsServiceOracleFault,
  recordServiceOracleWatchdog,
} from "./snake-service-capture-client.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const cargoLocal = path.join(repository, "scripts/cargo-local.mjs");
const taskDeadline =
  process.env.RUSTYERA_TEST_DISABLE_WALL_CLOCK_LIMIT === "1"
    ? undefined
    : Date.now() + 60 * 60 * 1_000;
let activeStage = "parsing arguments";
let lastCompleteSnapshot;
const monitorObservation = { sequence: 0, runtime: undefined };
globalThis.__RUSTYERA_TAURI_MONITOR_OBSERVATION__ = monitorObservation;
const arguments_ = process.argv.slice(2);
const requestedNativeProvider = nativeWebdriverOption(arguments_);
const nativeProviderManifestDirectory = path.join(repository, "tools/tauri-native-webdriver");
const projectIndex = arguments_.indexOf("--project");
const specIndex = arguments_.indexOf("--spec");
const stateIndex = arguments_.indexOf("--state");
const stateTypeIndex = arguments_.indexOf("--state-type");
const releaseRequested = arguments_.includes("--release");
const requireReuseBuild = arguments_.includes("--require-reuse-build");
const reuseBuild = requireReuseBuild || arguments_.includes("--reuse-build");
const buildOnly = arguments_.includes("--build-only");
const configuredProject =
  projectIndex >= 0 ? arguments_[projectIndex + 1] : process.env.ERATW_PROJECT;
let project = path.resolve(repository, configuredProject ?? "../games/eraTW");
const originalProject = project;
const requestedSpec = specIndex >= 0 ? arguments_[specIndex + 1] : undefined;
// Keep game-specific image flows opt-in while they are under investigation.
const configuredSpec = requestedSpec;
const specName = configuredSpec ? path.basename(configuredSpec) : undefined;
const specProfiles = {
  "native-input.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_NATIVE_INPUT",
    copyProject: true,
  },
  "snake-service-oracle.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_SERVICE_ORACLE",
    copyProject: true,
  },
  "snake-service-lifecycle.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_SERVICE_LIFECYCLE",
    copyProject: true,
  },
  "snake-services.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_SERVICES",
    copyProject: true,
  },
  "snake-batch1.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_BATCH1",
    copyProject: true,
  },
  "snake-data.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_DATA",
    copyProject: true,
  },
  "snake-sql.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_SQL",
    copyProject: true,
  },
  "snake-audio.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_AUDIO",
    copyProject: true,
  },
  "snake-ingestion.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_INGESTION",
    copyProject: true,
  },
  "snake-profile.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_SNAKE_PROFILE",
    copyProject: true,
  },
  "project-smoke.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_PROJECT_SMOKE" },
  "erafl-save-load-shapes.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_ERAFL_SAVE_LOAD_SHAPES",
  },
  "tooltip.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_TOOLTIP" },
  "preferences.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_PREFERENCES",
    copyProject: true,
  },
  "cache-settings.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_CACHE_SETTINGS",
    copyProject: true,
    prewarmWithTui: true,
  },
  "hot-reload.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_HOT_RELOAD",
    copyProject: true,
  },
  "reraconfig.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_RERACONFIG",
    copyProject: true,
    normalizeReraconfig: true,
  },
  "project-configuration.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_PROJECT_CONFIGURATION",
    copyProject: true,
  },
  "full-project-export.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_FULL_PROJECT_EXPORT",
    copyProject: true,
  },
  "diagnosis.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_DIAGNOSIS",
    copyProject: true,
  },
  "input-replay-export.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_INPUT_REPLAY_EXPORT",
    copyProject: true,
  },
  "project-fonts.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_PROJECT_FONTS",
    copyProject: true,
  },
  "akuma-maid-images.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_AKUMA_MAID_IMAGES",
  },
  "rorona-images.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_RORONA_IMAGES" },
  "rorona-log-inputs.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_RORONA_LOG_INPUTS",
  },
  "rorona-ability-box-layout.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_RORONA_ABILITY_BOX_LAYOUT",
    defaultState: "../games/erarorona/runtime_20260825-100940.snapshot",
    defaultStateType: "vm_snapshot",
  },
  "rorona-settlement-performance.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_RORONA_SETTLEMENT_PERFORMANCE",
    release: true,
  },
  "eratw-character-images.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_ERATW_CHARACTER_IMAGES",
    defaultState: "tests/fixtures/eratw/save18.sav",
    defaultStateType: "traditional_save",
  },
};
const specProfile = specName ? specProfiles[specName] : undefined;
const release = releaseRequested || specProfile?.release === true;
const configuredState = stateIndex >= 0 ? arguments_[stateIndex + 1] : specProfile?.defaultState;
const configuredStateType =
  stateTypeIndex >= 0
    ? arguments_[stateTypeIndex + 1]
    : (specProfile?.defaultStateType ?? "vm_snapshot");
const state = configuredState ? path.resolve(repository, configuredState) : undefined;
const npmExecPath = process.env.npm_execpath;
const packageCommand = process.platform === "win32" ? process.execPath : "npm";
const packageArguments = process.platform === "win32" ? [npmExecPath] : [];

if (projectIndex >= 0 && !arguments_[projectIndex + 1]) {
  throw new Error("--project requires a path");
}
if (specIndex >= 0 && !requestedSpec) throw new Error("--spec requires a path");
if (stateIndex >= 0 && !configuredState) throw new Error("--state requires a path");
if (stateTypeIndex >= 0 && !arguments_[stateTypeIndex + 1])
  throw new Error("--state-type requires a value");
if (!["traditional_save", "vm_snapshot"].includes(configuredStateType))
  throw new Error("--state-type must be traditional_save or vm_snapshot");
if (stateTypeIndex >= 0 && !configuredState) throw new Error("--state-type requires --state");
if (process.platform === "win32" && !npmExecPath)
  throw new Error("npm_execpath is required to launch package scripts on Windows");
if (specName === "native-input.spec.mjs" && !requestedNativeProvider)
  throw new Error("native input probe requires explicit --native-webdriver-source");
const nativeProvider = requestedNativeProvider
  ? await validateNativeWebdriverSource(path.resolve(repository, requestedNativeProvider), {
      manifestDirectory: nativeProviderManifestDirectory,
    })
  : undefined;
if (nativeProvider)
  console.log(JSON.stringify({ ...nativeProvider.provenance, stage: "before-build" }));
await access(project);
if (state) await access(state);
if (specProfile?.copyProject) {
  if (!(await stat(project)).isDirectory())
    throw new Error("the preferences test requires a source project directory");
  const testRuns = path.resolve(repository, ".rustyera/test-runs");
  await mkdir(testRuns, { recursive: true });
  const runDirectory = await mkdtemp(path.join(testRuns, "tauri-preferences-"));
  const projectCopy = path.join(runDirectory, path.basename(project));
  await cp(project, projectCopy, { recursive: true });
  if (specName === "preferences.spec.mjs")
    await rm(path.join(projectCopy, ".rustyera", "preferences-v1.json"), { force: true });
  if (specProfile.normalizeReraconfig) {
    const reraconfigPath = path.join(projectCopy, "reraconfig.toml");
    const source = await readFile(reraconfigPath, "utf8");
    const normalized = source
      .replace(/^schema_version\s*=.*$/m, "schema_version = 1")
      .replace(/^\s*volume\s*=.*(?:\r?\n|$)/gm, "")
      .replace(/^\s*replace_full_width_spaces\s*=.*(?:\r?\n|$)/gm, "")
      .replace(/^\s*character_width_mode\s*=.*(?:\r?\n|$)/gm, "");
    await writeFile(reraconfigPath, normalized);
  }
  console.log(JSON.stringify({ type: "test-project-copy", source: project, project: projectCopy }));
  project = projectCopy;
  if (specProfile.prewarmWithTui) project = await prewarmTuiCache(project, runDirectory);
}

let replacementProject;
if (["snake-service-lifecycle.spec.mjs", "snake-sql.spec.mjs"].includes(specName)) {
  const index = arguments_.indexOf("--replacement-project");
  if (specName === "snake-service-lifecycle.spec.mjs" && (index < 0 || !arguments_[index + 1]))
    throw new Error("lifecycle requires --replacement-project independent fixture");
  const source = path.resolve(repository, index >= 0 ? arguments_[index + 1] : originalProject);
  if (
    specName === "snake-service-lifecycle.spec.mjs" &&
    (await realpath(source)) === (await realpath(originalProject))
  )
    throw new Error("lifecycle successor must be a different project");
  replacementProject = path.join(
    path.dirname(project),
    specName === "snake-sql.spec.mjs"
      ? "sql-independent-successor"
      : "lifecycle-independent-successor",
  );
  await cp(source, replacementProject, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  console.log(
    JSON.stringify({
      type: "lifecycle-successor-copy",
      source,
      project: replacementProject,
    }),
  );
}

const environment = {
  ...process.env,
  // WebdriverIO's bundled Undici dispatcher is incompatible with Node 26 when
  // it creates the local Tauri WebDriver session. Select Node's native fetch
  // before importing the service so the choice is cross-platform and stable.
  WDIO_USE_NATIVE_FETCH: "1",
  VITE_RUSTYERA_TEST: "1",
  VITE_RUSTYERA_TAURI_TEST: "1",
  VITE_RUSTYERA_TEST_PROJECT: project,
  RUSTYERA_LIFECYCLE_REPLACEMENT_PROJECT: replacementProject ?? "",
  RUSTYERA_SQL_REPLACEMENT_PROJECT:
    specName === "snake-sql.spec.mjs" ? (replacementProject ?? "") : "",
  RUSTYERA_NATIVE_WEBDRIVER_SOURCE: nativeProvider?.provenance.source ?? "",
  RUSTYERA_SERVICE_CAPTURE_SOURCE_PROJECT: originalProject,
  VITE_RUSTYERA_TEST_PROJECT_FILE:
    specName === "diagnosis.spec.mjs"
      ? path.join(project, ".rustyera", "diagnosis-project.reraproj")
      : path.join(project, ".rustyera", "cache", "compiled-project.reracache"),
  VITE_RUSTYERA_TAURI_EXPORT_PATH:
    specName === "full-project-export.spec.mjs"
      ? path.join(project, ".rustyera", "full-export.reraproj")
      : specName === "diagnosis.spec.mjs"
        ? path.join(path.dirname(project), "diagnosis.tar.zst")
        : specName === "input-replay-export.spec.mjs"
          ? path.join(project, ".rustyera", "input-replay.jsonl")
          : "",
  VITE_RUSTYERA_TEST_STATE: state ?? "",
  VITE_RUSTYERA_TEST_STATE_TYPE: configuredStateType,
  RUSTYERA_TAURI_STATE_EXPORT_PATH: path.join(path.dirname(project), "state-export.sav"),
  ...Object.fromEntries(
    Object.values(specProfiles).map(({ environmentFlag }) => [
      environmentFlag,
      environmentFlag === specProfile?.environmentFlag ? "1" : "",
    ]),
  ),
};
const buildEnvironment = reusableBuildEnvironment(environment, specName, state, reuseBuild);

const snapshotLogDirectory = path.resolve(repository, ".rustyera/test-runs/tauri-snapshots");
await mkdir(snapshotLogDirectory, { recursive: true });
const snapshotLogPath = path.join(
  snapshotLogDirectory,
  `${new Date().toISOString().replaceAll(":", "-")}-${specName ?? "all"}.jsonl`,
);
const snapshotLog = createWriteStream(snapshotLogPath, { flags: "wx" });
console.log(JSON.stringify({ type: "tauri-snapshot-log", path: snapshotLogPath }));

activeStage = "resolving the Cargo target directory";
const metadata = await promisify(execFile)(
  process.execPath,
  [cargoLocal, "metadata", "--no-deps", "--format-version", "1", "--offline"],
  { cwd: repository, env: environment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
);
const binary = resolveTauriBinary(JSON.parse(metadata.stdout).target_directory, release);
const buildArguments = [
  cargoLocal,
  ...packageArguments,
  "run",
  "tauri",
  "--",
  "build",
  ...(release ? [] : ["--debug"]),
  "--no-bundle",
  "--features",
  "webdriver",
  "--config",
  "src-tauri/tauri.webdriver.conf.json",
  ...(nativeProvider?.cargoArguments ?? []),
];
const contractOptions = {
  repository,
  binary,
  args: buildArguments,
  environment: buildEnvironment,
  provider: nativeProvider?.provenance,
};
const manifestPath = `${binary}.webdriver-build.json`;
const contract = reuseBuild ? await buildContract(contractOptions) : undefined;
let artifact = contract
  ? await reusableArtifact(manifestPath, contract, binary, { required: requireReuseBuild })
  : undefined;
if (artifact) {
  console.log(
    JSON.stringify({ type: "tauri-build-reused", manifestPath, binary: artifact.binary }),
  );
} else {
  activeStage = "building the Tauri webdriver binary (no GUI session yet)";
  console.log(JSON.stringify({ type: "tauri-build-start", stage: activeStage, binary }));
  await run(
    process.execPath,
    buildArguments,
    { ...buildEnvironment, RUSTYERA_CARGO: packageCommand },
    taskDeadline,
    () => deadlineDiagnostic(),
  );
  if (contract) {
    if ((await buildContract(contractOptions)).sha256 !== contract.sha256)
      throw new Error("Tauri build inputs changed during compilation; artifact is not reusable");
    artifact = await recordBuiltArtifact(manifestPath, contract, binary);
  }
  console.log(JSON.stringify({ type: "tauri-build-complete", binary, identity: artifact?.binary }));
}
if (nativeProvider) {
  const current = await validateNativeWebdriverSource(nativeProvider.provenance.source, {
    manifestDirectory: nativeProviderManifestDirectory,
  });
  if (JSON.stringify(current.provenance) !== JSON.stringify(nativeProvider.provenance))
    throw new Error("native WebDriver source or trusted manifests changed during the build");
  console.log(JSON.stringify({ ...current.provenance, stage: "after-build" }));
}
await access(binary);
console.log(JSON.stringify({ type: "tauri-test-binary", path: binary }));
if (buildOnly) {
  await new Promise((resolve, reject) => {
    snapshotLog.once("error", reject);
    snapshotLog.end(resolve);
  });
  console.log(JSON.stringify({ type: "tauri-build-only-complete", guiStarted: false }));
  process.exit(0);
}
environment.RUSTYERA_SERVICE_CAPTURE_NATIVE_BINARY = binary;
Object.assign(process.env, environment);
const { cleanupWdioSession, createTauriCapabilities, startWdioSession } =
  await import("@wdio/tauri-service");
const capabilities = createTauriCapabilities(binary, {
  driverProvider: "embedded",
  logLevel: "info",
  startTimeout: 60_000,
});
capabilities.browserName = "tauri";
Object.assign(capabilities["wdio:tauriServiceOptions"], {
  captureBackendLogs: true,
  captureFrontendLogs: true,
  logDir: path.resolve(repository, ".rustyera/test-runs/tauri-logs"),
});

let browser;
let monitor;
let runError;
let finalizationError;
try {
  activeStage = "starting the embedded WebDriver session";
  console.log(JSON.stringify({ type: "tauri-gui-start", binary }));
  browser = await withinDeadline(
    startWdioSession(capabilities, { maxInstances: 1 }),
    taskDeadline,
    () => deadlineDiagnostic(),
  );
  // The standalone service hard-codes ten HTTP retries. Once connected, retrying a
  // rejected native action hides its real error and defeats the five-second watchdog.
  browser.options.connectionRetryCount = 0;
  browser.options.connectionRetryTimeout = 5_000;
  globalThis.browser = browser;
  globalThis.$ = browser.$.bind(browser);
  globalThis.$$ = browser.$$.bind(browser);
  activeStage = "running Tauri end-to-end specs";
  monitor = startTauriSessionMonitor(browser, {
    deadline: taskDeadline,
    describeDeadline: () => deadlineDiagnostic(),
    allowFault: () => specName === "snake-service-oracle.spec.mjs" && allowsServiceOracleFault(),
    onSnapshot: (snapshot) =>
      specName === "snake-service-oracle.spec.mjs"
        ? recordServiceOracleWatchdog(snapshot)
        : undefined,
    output(message) {
      snapshotLog.write(`${message}\n`);
      const report = JSON.parse(message);
      lastCompleteSnapshot = { document: report.document, runtime: report.runtime };
      monitorObservation.sequence += 1;
      monitorObservation.runtime = report.runtime;
      console.log(message);
    },
  });

  if (nativeProvider) {
    activeStage = "establishing the current native WebDriver window foreground";
    const handle = await focusCurrentTauriWindow(browser);
    console.log(JSON.stringify({ type: "tauri-native-window-focused", handle }));
  }

  if (reuseBuild) {
    await browser.waitUntil(() => browser.execute(() => Boolean(window.__RUSTYERA_TEST__)), {
      timeout: 20_000,
      interval: 50,
    });
    // The fresh run directory owns this one-use archive; no case path enters the build.
    await browser.execute(
      (projectPath, diagnosisExportPath, stateExportPath) => {
        window.__RUSTYERA_TEST__.configureServiceLifecycle({
          projectPaths: [projectPath],
          diagnosisExportPath,
          stateExportPath,
        });
      },
      project,
      path.join(path.dirname(project), "service-oracle-diagnosis.tar.zst"),
      environment.RUSTYERA_TAURI_STATE_EXPORT_PATH,
    );
  }

  const specs = configuredSpec
    ? [path.resolve(repository, configuredSpec)]
    : (await readdir(path.resolve(repository, "tests/tauri")))
        .filter((name) => name.endsWith(".spec.mjs"))
        .sort()
        .map((name) => path.resolve(repository, "tests/tauri", name));
  activeStage = `running Tauri specs: ${specs.map((spec) => path.basename(spec)).join(", ")}`;
  const mocha = new Mocha({ reporter: "spec", timeout: 300_000, bail: true });
  for (const spec of specs) mocha.addFile(spec);
  await mocha.loadFilesAsync();
  let runner;
  const testRun = new Promise((resolve, reject) => {
    runner = mocha.run((failures) => {
      if (failures === 0) resolve();
      else reject(new Error(`${failures} Tauri end-to-end test(s) failed`));
    });
    runner.once("error", reject);
  });
  try {
    await Promise.race([testRun, monitor.failure]);
  } catch (error) {
    runner?.abort();
    throw error;
  }
} catch (error) {
  runError = error;
  if (nativeProvider && process.platform === "darwin") {
    // Read the OS foreground owner before cleanup destroys the failed test window. This does
    // not activate anything; DOM focus alone cannot identify an external focus interruption.
    try {
      const { stdout } = await promisify(execFile)(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          'ObjC.import("AppKit"); var app = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name: ObjC.unwrap(app.localizedName), bundle: ObjC.unwrap(app.bundleIdentifier), pid: app.processIdentifier});',
        ],
        { timeout: 3_000 },
      );
      console.error(
        JSON.stringify({
          type: "tauri-failure-foreground",
          stage: activeStage,
          application: JSON.parse(stdout),
        }),
      );
    } catch (diagnosticError) {
      console.error(
        JSON.stringify({
          type: "tauri-failure-foreground-unavailable",
          error: String(diagnosticError),
        }),
      );
    }
  }
} finally {
  try {
    await monitor?.stop();
  } catch (error) {
    finalizationError = error;
  }
  try {
    if (browser) {
      activeStage = "cleaning up the embedded WebDriver session";
      await withinDeadline(cleanupWdioSession(browser), taskDeadline, () => deadlineDiagnostic());
    }
  } catch (error) {
    finalizationError ??= error;
  }
  delete globalThis.browser;
  delete globalThis.$;
  delete globalThis.$$;
  await new Promise((resolve, reject) => {
    snapshotLog.once("error", reject);
    snapshotLog.end(resolve);
  });
}
if (runError ?? finalizationError) throw runError ?? finalizationError;

async function prewarmTuiCache(sourceProject, runDirectory) {
  const scenario = path.join(runDirectory, "tui-cache-prewarm.json");
  const cacheOutput = path.join(runDirectory, "tui-cache-prewarm.reracache");
  const sourceIndexOutput = path.join(runDirectory, "tui-source-index-prewarm.json");
  const projectOutput = path.join(runDirectory, "tui-prewarmed-project");
  const runtimeLibrary =
    process.env.ERA_RUNTIME_LIBRARY ??
    path.resolve(
      repository,
      "../target/release",
      process.platform === "win32"
        ? "era_runtime_capi.dll"
        : process.platform === "darwin"
          ? "libera_runtime_capi.dylib"
          : "libera_runtime_capi.so",
    );
  await access(runtimeLibrary);
  await writeFile(
    scenario,
    JSON.stringify({
      schema_version: 1,
      project: sourceProject,
      mode: "fixed",
      seed: 123_456,
      limits: { max_steps: 10, timeout_seconds: 300 },
    }),
  );
  activeStage = "prewarming a TUI cache for the Tauri cache-hit spec";
  await run(
    "uv",
    [
      "run",
      "rustyera-test",
      "serve",
      "--scenario",
      scenario,
      "--project",
      sourceProject,
      "--runtime-library",
      runtimeLibrary,
    ],
    {
      ...process.env,
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: cacheOutput,
      RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: sourceIndexOutput,
      RUSTYERA_TEST_PROJECT_OUTPUT: projectOutput,
    },
    taskDeadline,
    () => deadlineDiagnostic(),
    {
      cwd: path.resolve(repository, "../rustyera-tui"),
      input: `${JSON.stringify({ op: "wait_status", text: "项目缓存已保存。" })}\n${JSON.stringify({ op: "stop" })}\n`,
    },
  );
  const sourceIndexDirectory = path.join(projectOutput, ".rustyera", "cache");
  const runtimeCacheDirectory = path.join(
    await prewarmRuntimeStorageRoot(projectOutput),
    ".rustyera",
    "cache",
  );
  await mkdir(sourceIndexDirectory, { recursive: true });
  await mkdir(runtimeCacheDirectory, { recursive: true });
  await cp(cacheOutput, path.join(runtimeCacheDirectory, "compiled-project.reracache"));
  await cp(sourceIndexOutput, path.join(sourceIndexDirectory, "source-index-v1.json"));
  console.log(
    JSON.stringify({
      type: "tauri-cache-prewarm",
      source: sourceProject,
      project: projectOutput,
      runtimeLibrary,
    }),
  );
  return projectOutput;
}

async function prewarmRuntimeStorageRoot(project) {
  const configuration = await readFile(path.join(project, "reraconfig.toml"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  let section = "";
  let profile = "emuera.em";
  for (const sourceLine of configuration.split(/\r?\n/)) {
    const line = sourceLine.replace(/\s+#.*$/, "").trim();
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "compatibility") continue;
    const entry = /^profile\s*=\s*["']([^"']+)["']\s*$/.exec(line);
    if (entry) profile = entry[1];
  }
  if (profile === "emuera.em") return project;
  if (profile === "emuera.skia.snake") return path.join(project, ".rustyera", "profiles", profile);
  throw new Error(`unsupported prewarm compatibility profile: ${profile}`);
}

function run(command, args, env, deadline, describeDeadline, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repository,
      env,
      stdio: options.input == null ? "inherit" : ["pipe", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    if (options.input != null) child.stdin.end(options.input);
    const remaining = deadline == null ? undefined : deadline - Date.now();
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    if (remaining != null && remaining <= 0) {
      terminateProcessTree(child);
      reject(new Error(describeDeadline()));
      return;
    }
    let timedOut = false;
    const timer =
      remaining == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              terminateProcessTree(child, "SIGTERM");
              const forceTimer = setTimeout(() => {
                try {
                  terminateProcessTree(child, "SIGKILL");
                } catch (error) {
                  console.error(`failed to force-stop timed-out Tauri build: ${error}`);
                }
              }, 1_000);
              forceTimer.unref?.();
              settle(() => reject(new Error(describeDeadline())));
            } catch (error) {
              settle(() => reject(error));
            }
          }, remaining);
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (timedOut) {
        settle(() => reject(new Error(describeDeadline())));
        return;
      }
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`${command} exited with ${signal ?? code}`)));
    });
  });
}

function withinDeadline(promise, deadline, describeDeadline) {
  if (deadline == null) return promise;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(describeDeadline()));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(describeDeadline())), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function terminateProcessTree(child, signal = "SIGTERM") {
  if (child.pid == null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function deadlineDiagnostic() {
  return `Tauri end-to-end task exceeded the shared 60-minute wall-clock limit: ${JSON.stringify({ activeStage, lastCompleteSnapshot })}`;
}
