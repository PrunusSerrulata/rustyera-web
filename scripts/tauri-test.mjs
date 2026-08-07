#!/usr/bin/env node

import { access, cp, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Mocha from "mocha";

import { resolveTauriBinary, startTauriSessionMonitor } from "./tauri-test-support.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const taskDeadline = Date.now() + 60 * 60 * 1_000;
let activeStage = "parsing arguments";
let lastCompleteSnapshot;
const arguments_ = process.argv.slice(2);
const projectIndex = arguments_.indexOf("--project");
const specIndex = arguments_.indexOf("--spec");
const stateIndex = arguments_.indexOf("--state");
const stateTypeIndex = arguments_.indexOf("--state-type");
const release = arguments_.includes("--release");
const configuredProject =
  projectIndex >= 0 ? arguments_[projectIndex + 1] : process.env.ERATW_PROJECT;
let project = path.resolve(repository, configuredProject ?? "../games/eraTW");
const requestedSpec = specIndex >= 0 ? arguments_[specIndex + 1] : undefined;
// Keep game-specific image flows opt-in while they are under investigation.
const configuredSpec = requestedSpec;
const specName = configuredSpec ? path.basename(configuredSpec) : undefined;
const specProfiles = {
  "project-smoke.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_PROJECT_SMOKE" },
  "tooltip.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_TOOLTIP" },
  "preferences.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_PREFERENCES",
    copyProject: true,
  },
  "akuma-maid-images.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_AKUMA_MAID_IMAGES",
  },
  "rorona-images.spec.mjs": { environmentFlag: "VITE_RUSTYERA_TAURI_RORONA_IMAGES" },
  "eratw-character-images.spec.mjs": {
    environmentFlag: "VITE_RUSTYERA_TAURI_ERATW_CHARACTER_IMAGES",
    defaultState: "tests/fixtures/eratw/save18.sav",
    defaultStateType: "traditional_save",
  },
};
const specProfile = specName ? specProfiles[specName] : undefined;
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
  console.log(JSON.stringify({ type: "test-project-copy", source: project, project: projectCopy }));
  project = projectCopy;
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
  VITE_RUSTYERA_TEST_PROJECT_FILE: path.join(
    project,
    ".rustyera",
    "cache",
    "compiled-project.reraproj",
  ),
  VITE_RUSTYERA_TEST_STATE: state ?? "",
  VITE_RUSTYERA_TEST_STATE_TYPE: configuredStateType,
  ...Object.fromEntries(
    Object.values(specProfiles).map(({ environmentFlag }) => [
      environmentFlag,
      environmentFlag === specProfile?.environmentFlag ? "1" : "",
    ]),
  ),
};

activeStage = "building the Tauri webdriver binary";
await run(
  packageCommand,
  [
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
  ],
  environment,
  taskDeadline,
  () => deadlineDiagnostic(),
);
Object.assign(process.env, environment);
const { cleanupWdioSession, createTauriCapabilities, startWdioSession } =
  await import("@wdio/tauri-service");
const binary = resolveTauriBinary(repository, release);
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
  browser = await withinDeadline(
    startWdioSession(capabilities, { maxInstances: 1 }),
    taskDeadline,
    () => deadlineDiagnostic(),
  );
  globalThis.browser = browser;
  globalThis.$ = browser.$.bind(browser);
  globalThis.$$ = browser.$$.bind(browser);
  activeStage = "running Tauri end-to-end specs";
  monitor = startTauriSessionMonitor(browser, {
    deadline: taskDeadline,
    describeDeadline: () => deadlineDiagnostic(),
    output(message) {
      const report = JSON.parse(message);
      lastCompleteSnapshot = { document: report.document, runtime: report.runtime };
      console.log(message);
    },
  });

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
}
if (runError ?? finalizationError) throw runError ?? finalizationError;

function run(command, args, env, deadline, describeDeadline) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const remaining = deadline - Date.now();
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    if (remaining <= 0) {
      terminateProcessTree(child);
      reject(new Error(describeDeadline()));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
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
