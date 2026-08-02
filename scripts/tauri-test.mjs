#!/usr/bin/env node

import { access, cp, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Mocha from "mocha";
import { cleanupWdioSession, createTauriCapabilities, startWdioSession } from "@wdio/tauri-service";

const repository = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
const projectIndex = arguments_.indexOf("--project");
const specIndex = arguments_.indexOf("--spec");
const stateIndex = arguments_.indexOf("--state");
const stateTypeIndex = arguments_.indexOf("--state-type");
const configuredProject =
  projectIndex >= 0 ? arguments_[projectIndex + 1] : process.env.ERATW_PROJECT;
let project = path.resolve(repository, configuredProject ?? "../games/eraTW");
const configuredSpec = specIndex >= 0 ? arguments_[specIndex + 1] : undefined;
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
if (specIndex >= 0 && !configuredSpec) throw new Error("--spec requires a path");
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
  VITE_RUSTYERA_TEST: "1",
  VITE_RUSTYERA_TAURI_TEST: "1",
  VITE_RUSTYERA_TEST_PROJECT: project,
  VITE_RUSTYERA_TEST_STATE: state ?? "",
  VITE_RUSTYERA_TEST_STATE_TYPE: configuredStateType,
  ...Object.fromEntries(
    Object.values(specProfiles).map(({ environmentFlag }) => [
      environmentFlag,
      environmentFlag === specProfile?.environmentFlag ? "1" : "",
    ]),
  ),
};

await run(
  packageCommand,
  [
    ...packageArguments,
    "run",
    "tauri",
    "--",
    "build",
    "--debug",
    "--no-bundle",
    "--features",
    "webdriver",
    "--config",
    "src-tauri/tauri.webdriver.conf.json",
  ],
  environment,
);
Object.assign(process.env, environment);
const binary = path.resolve(repository, "../target/debug/era-web-tauri");
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
try {
  browser = await startWdioSession(capabilities, { maxInstances: 1 });
  globalThis.browser = browser;
  globalThis.$ = browser.$.bind(browser);
  globalThis.$$ = browser.$$.bind(browser);

  const specs = configuredSpec
    ? [path.resolve(repository, configuredSpec)]
    : (await readdir(path.resolve(repository, "tests/tauri")))
        .filter((name) => name.endsWith(".spec.mjs"))
        .sort()
        .map((name) => path.resolve(repository, "tests/tauri", name));
  const mocha = new Mocha({ reporter: "spec", timeout: 300_000 });
  for (const spec of specs) mocha.addFile(spec);
  await mocha.loadFilesAsync();
  await new Promise((resolve, reject) => {
    const runner = mocha.run((failures) => {
      if (failures === 0) resolve();
      else reject(new Error(`${failures} Tauri end-to-end test(s) failed`));
    });
    runner.once("error", reject);
  });
} finally {
  if (browser) await cleanupWdioSession(browser);
  delete globalThis.browser;
  delete globalThis.$;
  delete globalThis.$$;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repository, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}
