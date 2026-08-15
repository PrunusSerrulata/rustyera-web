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
const tuiColdCache = path.join(temporary, "tui-cold.reracache");
const tuiColdProject = path.join(temporary, "tui-cold-project");
const webColdCache = path.join(temporary, "web-cold.reracache");
const webColdProject = path.join(temporary, "web-cold-project");
const tuiIncrementalCache = path.join(temporary, "tui-incremental.reracache");
const tuiIncrementalProject = path.join(temporary, "tui-incremental-project");
const webIncrementalCache = path.join(temporary, "web-incremental.reracache");
const webIncrementalProject = path.join(temporary, "web-incremental-project");
const originalSource = "REPLAY_DIAGNOSIS_READY";
const updatedSource = "HANDOFF_INCREMENTAL";

try {
  await cp(path.join(web, "tests", "fixtures", "diagnosis-project"), project, {
    recursive: true,
  });
  await writeTuiScenario(tuiScenario);

  // TUI cold -> Browser/WASM incremental -> TUI cache hit.
  await serveTui(
    project,
    { RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiColdCache },
    [{ op: "wait_status", text: "项目缓存已保存。" }, { op: "stop" }],
    tuiColdProject,
  );
  await writeWebScenario(webScenario, [
    editSource(originalSource, updatedSource),
    reloadSource(),
    { type: "wait_compiled_cache_saved" },
    assertInteractive(),
  ]);
  await runWeb(tuiColdProject, {
    RUSTYERA_TEST_COMPILED_CACHE_INPUT: tuiColdCache,
    RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webIncrementalCache,
    RUSTYERA_TEST_PROJECT_OUTPUT: webIncrementalProject,
  });
  await serveTui(webIncrementalProject, {
    RUSTYERA_TEST_COMPILED_CACHE_INPUT: webIncrementalCache,
  });

  // Browser/WASM cold -> TUI incremental -> Browser/WASM cache hit.
  await writeWebScenario(webScenario, [{ type: "wait_compiled_cache_saved" }, assertInteractive()]);
  await runWeb(project, {
    RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webColdCache,
    RUSTYERA_TEST_PROJECT_OUTPUT: webColdProject,
  });
  await serveTui(
    webColdProject,
    {
      RUSTYERA_TEST_COMPILED_CACHE_INPUT: webColdCache,
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiIncrementalCache,
    },
    [
      {
        op: "edit_source",
        path: "erb/diagnosis.erb",
        expected: originalSource,
        replacement: updatedSource,
      },
      { op: "reload", scope: "file", path: "erb/diagnosis.erb" },
      { op: "stop" },
    ],
    tuiIncrementalProject,
  );
  await writeWebScenario(webScenario, [assertInteractive()]);
  await runWeb(tuiIncrementalProject, {
    RUSTYERA_TEST_COMPILED_CACHE_INPUT: tuiIncrementalCache,
  });

  await assertSameFile(tuiColdCache, webColdCache, "cold");
  await assertSameFile(tuiIncrementalCache, webIncrementalCache, "incremental");
  await assertSameFile(
    path.join(tuiIncrementalProject, "erb", "diagnosis.erb"),
    path.join(webIncrementalProject, "erb", "diagnosis.erb"),
    "incremental project",
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "cache_handoff_result",
      status: "passed",
      checks: [
        "tui_cold_to_web",
        "web_cold_to_tui",
        "tui_incremental_to_web",
        "web_incremental_to_tui",
        "cold_bytes_identical",
        "incremental_bytes_identical",
      ],
    })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function serveTui(projectOverride, extraEnv, requests = [{ op: "stop" }], projectOutput) {
  const args = [
    "run",
    "rustyera-test",
    "serve",
    "--scenario",
    tuiScenario,
    "--project",
    projectOverride,
    "--runtime-library",
    runtime,
  ];
  await child(
    "uv",
    args,
    path.join(root, "rustyera-tui"),
    {
      ...extraEnv,
      ...(projectOutput ? { RUSTYERA_TEST_PROJECT_OUTPUT: projectOutput } : {}),
    },
    requests,
  );
}

async function runWeb(projectOverride, extraEnv) {
  await child(
    process.execPath,
    ["scripts/web-test.mjs", "run", "--scenario", webScenario, "--project", projectOverride],
    web,
    extraEnv,
    [],
  );
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

async function writeTuiScenario(target) {
  await writeFile(
    target,
    JSON.stringify({
      schema_version: 1,
      project,
      mode: "fixed",
      seed: 123456,
      limits: { max_steps: 10, timeout_seconds: 60 },
    }),
  );
}

async function writeWebScenario(target, actions) {
  await writeFile(
    target,
    JSON.stringify({
      schema_version: 1,
      project,
      mode: "fixed",
      seed: 123456,
      actions,
      limits: { max_steps: 10, timeout_seconds: 60 },
    }),
  );
}

function editSource(expected, replacement) {
  return {
    type: "edit_project_source",
    relative_path: "erb/diagnosis.erb",
    expected,
    replacement,
  };
}

function reloadSource() {
  return { type: "reload_project", scope: "script", path: "erb/diagnosis.erb" };
}

function assertInteractive() {
  return { type: "assert_state", expect: { projectOpen: true, canInteract: true } };
}

async function assertSameFile(left, right, generation) {
  if (!(await readFile(left)).equals(await readFile(right)))
    throw new Error(`same-generation ${generation} TUI and Browser/WASM outputs differ`);
}
