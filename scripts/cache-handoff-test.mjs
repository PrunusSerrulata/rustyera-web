#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(web, "..");
const runtime = process.env.ERA_RUNTIME_LIBRARY;
if (!runtime) throw new Error("ERA_RUNTIME_LIBRARY is required");
const temporary = await mkdtemp(path.join(tmpdir(), "rustyera-cache-handoff-"));
const project = path.join(temporary, "initial-project");
const tuiScenario = path.join(temporary, "tui.json");
const webScenario = path.join(temporary, "web.json");
const tuiCache = path.join(temporary, "tui.reracache");
const tuiProject = path.join(temporary, "tui-project");
const webCache = path.join(temporary, "web.reracache");
const webProject = path.join(temporary, "web-project");
const tuiFinalCache = path.join(temporary, "tui-final.reracache");
const tuiFinalProject = path.join(temporary, "tui-final-project");
const webFinalCache = path.join(temporary, "web-final.reracache");
const webFinalProject = path.join(temporary, "web-final-project");
const browserInputProject = path.join(temporary, "browser-input-project");
try {
  await cp(path.join(web, "tests", "fixtures", "diagnosis-project"), project, {
    recursive: true,
  });
  await cp(project, browserInputProject, { recursive: true });
  await writeFile(
    tuiScenario,
    JSON.stringify({
      schema_version: 1,
      project,
      mode: "fixed",
      seed: 123456,
      limits: { max_steps: 10, timeout_seconds: 60 },
    }),
  );
  await writeBrowserScenario(webScenario, "HANDOFF_TUI", "HANDOFF_WEB");

  await serve(
    "uv",
    ["run", "rustyera-test", "serve", "--scenario", tuiScenario, "--runtime-library", runtime],
    path.join(root, "rustyera-tui"),
    { RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiCache, RUSTYERA_TEST_PROJECT_OUTPUT: tuiProject },
    [
      {
        op: "edit_source",
        path: "erb/diagnosis.erb",
        expected: "REPLAY_DIAGNOSIS_READY",
        replacement: "HANDOFF_TUI",
      },
      { op: "reload", scope: "file", path: "erb/diagnosis.erb" },
      { op: "stop" },
    ],
  );
  await run(
    process.execPath,
    ["scripts/web-test.mjs", "run", "--scenario", webScenario, "--project", tuiProject],
    web,
    {
      RUSTYERA_TEST_COMPILED_CACHE_INPUT: tuiCache,
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webCache,
      RUSTYERA_TEST_PROJECT_OUTPUT: webProject,
    },
  );
  await serve(
    "uv",
    [
      "run",
      "rustyera-test",
      "serve",
      "--scenario",
      tuiScenario,
      "--project",
      webProject,
      "--runtime-library",
      runtime,
    ],
    path.join(root, "rustyera-tui"),
    {
      RUSTYERA_TEST_COMPILED_CACHE_INPUT: webCache,
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiFinalCache,
      RUSTYERA_TEST_PROJECT_OUTPUT: tuiFinalProject,
    },
    [
      {
        op: "edit_source",
        path: "erb/diagnosis.erb",
        expected: "HANDOFF_WEB",
        replacement: "HANDOFF_FINAL",
      },
      { op: "reload", scope: "file", path: "erb/diagnosis.erb" },
      { op: "stop" },
    ],
  );
  await writeBrowserScenario(webScenario, "HANDOFF_WEB", "HANDOFF_FINAL");
  await replace(browserInputProject, "REPLAY_DIAGNOSIS_READY", "HANDOFF_WEB");
  await run(
    process.execPath,
    ["scripts/web-test.mjs", "run", "--scenario", webScenario, "--project", browserInputProject],
    web,
    {
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webFinalCache,
      RUSTYERA_TEST_PROJECT_OUTPUT: webFinalProject,
    },
  );
  if (!(await readFile(tuiFinalCache)).equals(await readFile(webFinalCache)))
    throw new Error("same-generation Browser/WASM and TUI caches differ");
  if (
    !(await readFile(path.join(tuiFinalProject, "erb", "diagnosis.erb"))).equals(
      await readFile(path.join(webFinalProject, "erb", "diagnosis.erb")),
    )
  )
    throw new Error("same-generation project outputs differ");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function run(command, args, cwd, extraEnv) {
  await child(command, args, cwd, extraEnv, []);
}

async function serve(command, args, cwd, extraEnv, requests) {
  await child(command, args, cwd, extraEnv, requests);
}

async function child(command, args, cwd, extraEnv, requests) {
  const processChild = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "inherit", "inherit"],
  });
  for (const request of requests) processChild.stdin.write(`${JSON.stringify(request)}\n`);
  processChild.stdin.end();
  const code = await new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

async function writeBrowserScenario(target, expected, replacement) {
  await writeFile(
    target,
    JSON.stringify({
      schema_version: 1,
      project,
      mode: "fixed",
      seed: 123456,
      actions: [
        { type: "edit_project_source", relative_path: "erb/diagnosis.erb", expected, replacement },
        { type: "reload_project", scope: "script", path: "erb/diagnosis.erb" },
        { type: "wait_compiled_cache_saved" },
        { type: "assert_state", expect: { projectOpen: true, canInteract: true } },
      ],
      limits: { max_steps: 10, timeout_seconds: 60 },
    }),
  );
}

async function replace(root, expected, replacement) {
  const target = path.join(root, "erb", "diagnosis.erb");
  const source = await readFile(target, "utf8");
  await writeFile(target, source.replace(expected, replacement), "utf8");
}
