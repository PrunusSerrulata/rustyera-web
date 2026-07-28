#!/usr/bin/env node

import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
const projectIndex = arguments_.indexOf("--project");
const configuredProject =
  projectIndex >= 0 ? arguments_[projectIndex + 1] : process.env.ERATW_PROJECT;
const project = path.resolve(repository, configuredProject ?? "../games/eraTW");

if (projectIndex >= 0 && !arguments_[projectIndex + 1]) {
  throw new Error("--project requires a path");
}
await access(project);

const environment = {
  ...process.env,
  VITE_RUSTYERA_TEST: "1",
  VITE_RUSTYERA_TAURI_TEST: "1",
  VITE_RUSTYERA_TEST_PROJECT: project,
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
await run("npx", ["wdio", "run", "wdio.tauri.conf.mjs"], environment);

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
