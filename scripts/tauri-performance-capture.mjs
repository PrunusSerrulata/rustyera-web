#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  performanceProjectDigest,
  validatePerformanceAuditProject,
} from "./tauri-performance-audit.mjs";
import { freezePerformanceTrace } from "./tauri-performance-trace.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
const command = arguments_.shift();
if (command === "freeze") {
  const candidate = option("--candidate");
  const output = option("--output");
  const coreOutput = option("--core-output");
  rejectUnknown(new Set(["--candidate", "--output", "--core-output"]));
  if (candidate === output) throw new Error("freeze output must not overwrite the reviewed candidate");
  if (new Set([candidate, output]).has(coreOutput))
    throw new Error("Core companion output must be a distinct file");
  await assertMissing(output);
  await assertMissing(coreOutput);
  const { trace, coreTrace } = await freezePerformanceTrace(candidate, output, coreOutput);
  console.log(
    JSON.stringify({
      type: "tauri-performance-trace-frozen",
      output,
      traceDigest: trace.traceDigest,
      coreOutput,
      coreTraceDigest: coreTrace.traceDigest,
    }),
  );
} else if (command === "capture") {
  const project = option("--project");
  const template = option("--template");
  const candidate = option("--candidate");
  const actions = option("--actions");
  const windowMode = optionalValue("--window-mode") ?? "offscreen";
  rejectUnknown(new Set(["--project", "--template", "--candidate", "--actions", "--window-mode"]));
  if (!new Set(["minimized", "offscreen"]).has(windowMode))
    throw new Error("--window-mode must be minimized or offscreen");
  const identity = await validatePerformanceAuditProject(project);
  assertOutsideSource(identity.source, candidate, "--candidate");
  assertOutsideSource(identity.source, actions, "--actions");
  const projectDigest = await performanceProjectDigest(identity.source);
  await assertMissing(candidate);
  await mkdir(path.dirname(candidate), { recursive: true });
  await mkdir(path.dirname(actions), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "scripts/tauri-test.mjs",
      "--perf-audit",
      "--background-dom",
      "--release",
      "--project",
      project,
      "--spec",
      "tests/tauri/snake-runtime-performance.spec.mjs",
      "--window-mode",
      windowMode,
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        RUSTYERA_TAURI_PERF_CAPTURE: "1",
        RUSTYERA_TAURI_PERF_PHASE: "capture",
        RUSTYERA_TAURI_PERF_TRACE: template,
        RUSTYERA_TAURI_PERF_CANDIDATE: candidate,
        RUSTYERA_TAURI_PERF_ACTIONS: actions,
        RUSTYERA_TAURI_PERF_PROJECT_DIGEST: projectDigest,
      },
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error(`background capture exited ${exitCode}`);
} else {
  throw new Error("usage: tauri-performance-capture.mjs capture|freeze [options]");
}

function option(name) {
  const indexes = arguments_.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length !== 1) throw new Error(`${name} must be specified exactly once`);
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return path.resolve(repository, value);
}
function optionalValue(name) {
  const indexes = arguments_.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (!indexes.length) return undefined;
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function rejectUnknown(allowed) {
  for (let index = 0; index < arguments_.length; index += 2) {
    if (!allowed.has(arguments_[index]))
      throw new Error(`unsupported capture option ${arguments_[index]}`);
    if (arguments_[index + 1] == null) throw new Error(`${arguments_[index]} requires a value`);
  }
}
function assertOutsideSource(source, destination, optionName) {
  const relative = path.relative(source, destination);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw new Error(`${optionName} must be outside the read-only source project`);
}
async function assertMissing(file) {
  try {
    await access(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing file ${file}`);
}
