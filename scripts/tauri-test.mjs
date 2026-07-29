#!/usr/bin/env node

import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
const projectIndex = arguments_.indexOf("--project");
const specIndex = arguments_.indexOf("--spec");
const configuredProject =
  projectIndex >= 0 ? arguments_[projectIndex + 1] : process.env.ERATW_PROJECT;
const project = path.resolve(repository, configuredProject ?? "../games/eraTW");
const configuredSpec = specIndex >= 0 ? arguments_[specIndex + 1] : undefined;

if (projectIndex >= 0 && !arguments_[projectIndex + 1]) {
  throw new Error("--project requires a path");
}
if (specIndex >= 0 && !configuredSpec) throw new Error("--spec requires a path");
await access(project);

const environment = {
  ...process.env,
  VITE_RUSTYERA_TEST: "1",
  VITE_RUSTYERA_TAURI_TEST: "1",
  VITE_RUSTYERA_TEST_PROJECT: project,
  VITE_RUSTYERA_TAURI_PROJECT_SMOKE:
    configuredSpec && path.basename(configuredSpec) === "project-smoke.spec.mjs" ? "1" : "0",
};

await run(
  "npm",
  [
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
const wdioArguments = ["wdio", "run", "wdio.tauri.conf.mjs"];
if (configuredSpec) wdioArguments.push("--spec", path.resolve(repository, configuredSpec));
await run("npx", wdioArguments, environment);

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
