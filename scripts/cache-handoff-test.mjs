#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
const tuiColdIndex = path.join(temporary, "tui-cold-source-index.json");
const tuiColdProject = path.join(temporary, "tui-cold-project");
const webColdCache = path.join(temporary, "web-cold.reracache");
const webColdIndex = path.join(temporary, "web-cold-source-index.json");
const webColdProject = path.join(temporary, "web-cold-project");
const tuiIncrementalCache = path.join(temporary, "tui-incremental.reracache");
const tuiIncrementalIndex = path.join(temporary, "tui-incremental-source-index.json");
const tuiIncrementalProject = path.join(temporary, "tui-incremental-project");
const webIncrementalCache = path.join(temporary, "web-incremental.reracache");
const webIncrementalIndex = path.join(temporary, "web-incremental-source-index.json");
const webIncrementalProject = path.join(temporary, "web-incremental-project");
const tauriFromTuiIndex = path.join(temporary, "tauri-from-tui-source-index.json");
const tauriFromTuiProject = path.join(temporary, "tauri-from-tui-project");
const tauriFromWebIndex = path.join(temporary, "tauri-from-web-source-index.json");
const tauriFromWebProject = path.join(temporary, "tauri-from-web-project");
const originalSource = "REPLAY_DIAGNOSIS_READY";
const updatedSource = "HANDOFF_INCREMENTAL";

try {
  await cp(path.join(web, "tests", "fixtures", "diagnosis-project"), project, {
    recursive: true,
    preserveTimestamps: true,
  });
  await addImageResource(project);
  await writeTuiScenario(tuiScenario);

  // TUI cold -> Browser/WASM incremental -> TUI cache hit.
  await serveTui(
    project,
    {
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiColdCache,
      RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: tuiColdIndex,
    },
    [{ op: "wait_status", text: "项目缓存已保存。" }, { op: "stop" }],
    tuiColdProject,
  );
  await assertSourceIndexMatchesProject(tuiColdIndex, tuiColdProject, "TUI cold export");
  await writeWebScenario(webScenario, [
    editSource(originalSource, updatedSource),
    reloadSource(),
    { type: "wait_compiled_cache_saved" },
    assertInteractive(),
  ]);
  await runWeb(tuiColdProject, {
    RUSTYERA_TEST_COMPILED_CACHE_INPUT: tuiColdCache,
    RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webIncrementalCache,
    RUSTYERA_TEST_SOURCE_INDEX_INPUT: tuiColdIndex,
    RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: webIncrementalIndex,
    RUSTYERA_TEST_PROJECT_OUTPUT: webIncrementalProject,
  });
  await serveTui(webIncrementalProject, {
    RUSTYERA_TEST_COMPILED_CACHE_INPUT: webIncrementalCache,
    RUSTYERA_TEST_SOURCE_INDEX_INPUT: webIncrementalIndex,
  });

  // Tauri consumes TUI's real v3 index, updates one source, and Browser reuses it.
  await tauriSourceIndexHandoff(
    tuiColdProject,
    tuiColdIndex,
    tauriFromTuiProject,
    tauriFromTuiIndex,
  );
  await writeWebScenario(webScenario, [assertInteractive()]);
  await runWeb(tauriFromTuiProject, {
    RUSTYERA_TEST_SOURCE_INDEX_INPUT: tauriFromTuiIndex,
  });

  // Browser/WASM cold -> TUI incremental -> Browser/WASM cache hit.
  await writeWebScenario(webScenario, [{ type: "wait_compiled_cache_saved" }, assertInteractive()]);
  await runWeb(project, {
    RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: webColdCache,
    RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: webColdIndex,
    RUSTYERA_TEST_PROJECT_OUTPUT: webColdProject,
  });
  await assertSourceIndexMatchesProject(webColdIndex, webColdProject, "Browser cold export");
  await serveTui(
    webColdProject,
    {
      RUSTYERA_TEST_COMPILED_CACHE_INPUT: webColdCache,
      RUSTYERA_TEST_COMPILED_CACHE_OUTPUT: tuiIncrementalCache,
      RUSTYERA_TEST_SOURCE_INDEX_INPUT: webColdIndex,
      RUSTYERA_TEST_SOURCE_INDEX_OUTPUT: tuiIncrementalIndex,
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
    RUSTYERA_TEST_SOURCE_INDEX_INPUT: tuiIncrementalIndex,
  });

  // Tauri consumes Browser's real v3 index, updates one source, and TUI reuses it.
  await tauriSourceIndexHandoff(
    webColdProject,
    webColdIndex,
    tauriFromWebProject,
    tauriFromWebIndex,
  );
  await serveTui(tauriFromWebProject, {
    RUSTYERA_TEST_SOURCE_INDEX_INPUT: tauriFromWebIndex,
  });

  await assertSameFile(tuiColdCache, webColdCache, "cold");
  await assertSameFile(tuiIncrementalCache, webIncrementalCache, "incremental");
  await assertPortableSourceIndex(tuiColdIndex, "TUI cold");
  await assertPortableSourceIndex(webColdIndex, "Browser/WASM cold");
  await assertPortableSourceIndex(tuiIncrementalIndex, "TUI incremental");
  await assertPortableSourceIndex(webIncrementalIndex, "Browser/WASM incremental");
  await assertPortableSourceIndex(tauriFromTuiIndex, "Tauri from TUI");
  await assertPortableSourceIndex(tauriFromWebIndex, "Tauri from Browser/WASM");
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
        "cold_source_index_portable",
        "incremental_source_index_portable",
        "tui_source_index_reused_and_updated_by_tauri_then_browser",
        "web_source_index_reused_and_updated_by_tauri_then_tui",
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
    { VITE_RUSTYERA_TEST_TRUST_METADATA: "1", ...extraEnv },
    [],
  );
}

async function tauriSourceIndexHandoff(source, sourceIndex, projectOutput, indexOutput) {
  await cp(source, projectOutput, { recursive: true, preserveTimestamps: true });
  const cache = path.join(projectOutput, ".rustyera", "cache");
  await mkdir(cache, { recursive: true });
  await cp(sourceIndex, path.join(cache, "source-index-v1.json"));
  await child(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "project::tests::cross_frontend_source_index_handoff_driver",
      "--",
      "--ignored",
      "--exact",
    ],
    web,
    {
      RUSTYERA_TEST_TAURI_SOURCE_INDEX_PROJECT: projectOutput,
      RUSTYERA_TEST_TAURI_SOURCE_INDEX_OUTPUT: indexOutput,
      RUSTYERA_TEST_TAURI_EDIT_PATH: "erb/diagnosis.erb",
      RUSTYERA_TEST_TAURI_EDIT_EXPECTED: originalSource,
      RUSTYERA_TEST_TAURI_EDIT_REPLACEMENT: updatedSource,
    },
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

async function assertPortableSourceIndex(target, generation) {
  const index = JSON.parse(await readFile(target, "utf8"));
  if (index.version !== 3 || !index.files || typeof index.files !== "object")
    throw new Error(`${generation} source index is not portable schema v3`);
  for (const entry of Object.values(index.files)) {
    if (
      !Number.isInteger(entry.category) ||
      typeof entry.signature !== "string" ||
      !/^\d+:\d+$/.test(entry.signature)
    )
      throw new Error(`${generation} source index contains a non-portable entry`);
    if ("imageMetadata" in entry)
      throw new Error(`${generation} source index contains a legacy imageMetadata field`);
  }
  const image = index.files["resources/cover.png"];
  if (
    !image ||
    !image.image_metadata ||
    image.image_metadata.width !== 1 ||
    image.image_metadata.height !== 1 ||
    image.image_metadata.format !== "png" ||
    image.image_metadata.animated !== false
  )
    throw new Error(`${generation} source index lost canonical image metadata`);
}

async function assertSourceIndexMatchesProject(indexPath, projectPath, generation) {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const diagnostics = [];
  for (const [relativePath, entry] of Object.entries(index.files ?? {})) {
    const metadata = await stat(path.join(projectPath, ...relativePath.split("/")), {
      bigint: true,
    });
    const signature = `${metadata.size}:${metadata.mtimeNs / 1_000_000n}`;
    diagnostics.push({
      relativePath,
      category: entry.category,
      signature: entry.signature,
      projectSignature: signature,
      indexedSize: entry.size,
      projectSize: Number(metadata.size),
      hashValid: typeof entry.hash === "string" && /^[0-9a-f]{64}$/i.test(entry.hash),
      imageMetadata: entry.image_metadata ?? null,
    });
    if (entry.signature !== signature)
      throw new Error(
        `${generation} source-index signature mismatch for ${relativePath}: ` +
          `index=${entry.signature}, project=${signature}`,
      );
  }
  process.stdout.write(
    `${JSON.stringify({ type: "source_index_diagnostic", generation, diagnostics })}\n`,
  );
}

async function addImageResource(target) {
  const resources = path.join(target, "resources");
  await mkdir(resources, { recursive: true });
  const image = path.join(resources, "cover.png");
  await writeFile(
    image,
    Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      1, 0, 0, 0, 1,
    ]),
  );
  // Node's timestamp-preserving recursive copy can round a freshly written APFS
  // nanosecond timestamp below its millisecond boundary. The portable index is
  // intentionally millisecond-based, so use a stable exactly representable half-second.
  const portableTimestamp = new Date("2020-01-01T00:00:00.500Z");
  await utimes(image, portableTimestamp, portableTimestamp);
}
