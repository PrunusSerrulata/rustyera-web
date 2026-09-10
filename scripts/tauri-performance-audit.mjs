/* global document, window */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const PERFORMANCE_AUDIT_SPEC = "snake-runtime-performance.spec.mjs";
export const DEFAULT_PERFORMANCE_WINDOW_MODE = "visible";
export const PERFORMANCE_WINDOW_MODES = new Set(["visible", "minimized"]);
const PERFORMANCE_PROJECT_COPY_MARKER = ".rustyera/performance-project-copy-v1.json";
const MINIMUM_COPY_FREE_BYTES = 10 * 1024 ** 3;

export function performanceCommandTimeoutMs(performanceEnabled) {
  return performanceEnabled === true ? 30_000 : 5_000;
}

export function performanceProfilerMode(arguments_, platform = process.platform) {
  const indexes = arguments_.flatMap((value, index) => (value === "--profilers" ? [index] : []));
  if (indexes.length > 1) throw new Error("--profilers may be specified only once");
  const mode = indexes.length === 0 ? "native" : arguments_[indexes[0] + 1];
  if (!["native", "none"].includes(mode)) throw new Error("--profilers must be native or none");
  if (mode === "native" && platform !== "darwin")
    throw new Error("native audit profilers require macOS; use --profilers none for timing only");
  return mode;
}

export function performanceTelemetryCompleteness(telemetry) {
  const timingSamplesDropped = telemetry.frontend.timingSamplesDropped;
  const longTasksDropped = telemetry.frontend.longTasksDropped;
  const nativeDropped = telemetry.native.dropped;
  return {
    complete: [timingSamplesDropped, longTasksDropped, nativeDropped].every((value) => value === 0),
    timingSamplesDropped,
    longTasksDropped,
    nativeDropped,
  };
}

export function performanceSnapshotMode(performanceEnabled, heavyDiagnostics = false) {
  if (performanceEnabled !== true) return "complete";
  return heavyDiagnostics ? "performance-diagnostic" : "performance-progress";
}

export function performanceWindowMode(arguments_) {
  const indexes = arguments_.flatMap((value, index) => (value === "--window-mode" ? [index] : []));
  if (indexes.length > 1) throw new Error("--window-mode may be specified only once");
  if (indexes.length === 0) return DEFAULT_PERFORMANCE_WINDOW_MODE;
  const mode = arguments_[indexes[0] + 1];
  if (!mode || mode.startsWith("--")) throw new Error("--window-mode requires a value");
  if (!PERFORMANCE_WINDOW_MODES.has(mode))
    throw new Error("--window-mode must be visible or minimized for a Tauri performance audit");
  return mode;
}

export function performanceWindowArguments(mode) {
  if (!PERFORMANCE_WINDOW_MODES.has(mode))
    throw new Error("Tauri performance audit supports visible or minimized window mode");
  return [...(mode === "minimized" ? ["--background-dom"] : []), "--window-mode", mode];
}

export function performanceCaptureChildArguments(project, mode) {
  if (typeof project !== "string" || !project)
    throw new Error("performance capture requires an explicit source project");
  return [
    "scripts/tauri-test.mjs",
    "--perf-audit",
    "--release",
    "--require-reuse-build",
    "--project",
    project,
    "--spec",
    "tests/tauri/snake-runtime-performance.spec.mjs",
    ...performanceWindowArguments(mode),
  ];
}

export async function refreshPerformanceSession(browser, projectCopy, waitForControl) {
  if (
    typeof projectCopy !== "string" ||
    !path.isAbsolute(projectCopy) ||
    projectCopy.includes("\0") ||
    projectCopy === "/__rustyera_test_picker_must_be_configured__"
  )
    throw new Error("performance session requires the validated absolute project copy");
  const previousOrigin = await browser.execute(() => window.performance.timeOrigin);
  await browser.refresh();
  // WebDriver refresh can return while the old document still exposes its control. Wait for
  // a new document and its installed interface together, not two racy readiness reads.
  await browser.waitUntil(
    () =>
      browser.execute(
        (origin) =>
          window.performance.timeOrigin !== origin &&
          typeof window.__RUSTYERA_TEST__?.performanceProgress === "function" &&
          typeof window.__RUSTYERA_TEST__?.snapshotSummary === "function",
        previousOrigin,
      ),
    { timeout: 30_000, interval: 50, timeoutMsg: "fresh performance document was not ready" },
  );
  await waitForControl();
  await browser.execute(
    (projectPath) =>
      window.__RUSTYERA_TEST__.configureServiceLifecycle({ projectPaths: [projectPath] }),
    projectCopy,
  );
}

export function instrumentedPerformanceWindowMode(options, instrumentPerformance) {
  if (!instrumentPerformance) return undefined;
  return options.enabled ? options.windowMode : "visible";
}

export function performanceAuditOptions(arguments_, specName, paths = {}) {
  const enabled = arguments_.includes("--perf-audit");
  const backgroundDom = arguments_.includes("--background-dom");
  const hasWindowMode = arguments_.includes("--window-mode");
  const windowMode = performanceWindowMode(arguments_);
  if (!enabled) {
    if (hasWindowMode) throw new Error("--window-mode requires --perf-audit");
    return { enabled: false, background: false, windowMode: undefined };
  }
  for (const flag of ["--perf-audit", "--release"]) requireOccurrences(arguments_, flag, 1);
  if (backgroundDom) requireOccurrences(arguments_, "--background-dom", 1);
  for (const option of ["--project", "--spec"]) requireSingleOptionValue(arguments_, option);
  for (const optionalFlag of ["--reuse-build", "--require-reuse-build", "--build-only"])
    if (arguments_.includes(optionalFlag)) requireOccurrences(arguments_, optionalFlag, 1);
  for (const rejected of [
    "--state",
    "--state-type",
    "--native-webdriver-source",
    "--prewarm-with-tui",
  ]) {
    if (arguments_.includes(rejected)) throw new Error(`${rejected} is forbidden by --perf-audit`);
  }
  assertOnlyPerformanceArguments(arguments_);
  if (specName !== PERFORMANCE_AUDIT_SPEC)
    throw new Error(`--perf-audit requires the single ${PERFORMANCE_AUDIT_SPEC} spec`);
  if (
    paths.repository &&
    paths.requestedSpec &&
    typeof paths.resolve === "function" &&
    paths.resolve(paths.repository, paths.requestedSpec) !==
      paths.resolve(paths.repository, "tests/tauri", PERFORMANCE_AUDIT_SPEC)
  )
    throw new Error(`--perf-audit spec must be tests/tauri/${PERFORMANCE_AUDIT_SPEC}`);
  if (!arguments_.includes("--release")) throw new Error("--perf-audit requires --release");
  if (!arguments_.includes("--project"))
    throw new Error("--perf-audit requires an explicit isolated source project");
  if (windowMode === "minimized" && !backgroundDom)
    throw new Error("minimized performance mode requires --background-dom");
  if (windowMode === "visible" && backgroundDom)
    throw new Error("--background-dom requires minimized window mode");
  return { enabled: true, background: backgroundDom, windowMode };
}

export async function validatePerformanceAuditProject(sourceProject, copiedProject) {
  const source = await realpath(sourceProject);
  const copy = copiedProject == null ? undefined : await realpath(copiedProject);
  if (copy && copy === source)
    throw new Error("performance audit project copy resolves to its source");
  for (const project of [source, copy].filter(Boolean)) {
    const configuration = decodeProjectText(
      await readFile(`${project}/reraconfig.toml`),
      "configuration",
      "reraconfig.toml",
    );
    if (!/^\s*profile\s*=\s*["']emuera\.skia\.snake["']\s*$/m.test(configuration))
      throw new Error(`${project} requires reraconfig.toml profile emuera.skia.snake`);
  }
  return { source, copy };
}

export async function ensurePerformanceProjectCopy(sourceProject, copiedProject) {
  const source = await realpath(sourceProject);
  const copy = path.resolve(copiedProject);
  const relative = path.relative(source, copy);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    throw new Error("performance project copy must be outside its read-only source");
  if (!(await stat(source)).isDirectory())
    throw new Error("performance project source must be a directory");

  const sourceDigest = await performanceProjectDigest(source);
  let copyExists = true;
  try {
    await stat(copy);
  } catch (error) {
    if (error.code === "ENOENT") copyExists = false;
    else throw error;
  }
  if (copyExists)
    return {
      source,
      copy: await validateExistingPerformanceProjectCopy(source, copy, sourceDigest),
      projectDigest: sourceDigest,
      created: false,
    };

  const parent = path.dirname(copy);
  await mkdir(parent, { recursive: true });
  const free = await statfs(parent);
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < MINIMUM_COPY_FREE_BYTES)
    throw new Error(
      "less than 10 GiB is available; refusing to create the performance project copy",
    );

  const lock = `${copy}.copy-lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `performance project copy creation is already locked at ${lock}; refusing to copy again`,
      );
    throw error;
  }
  const temporary = `${copy}.creating-${process.pid}`;
  // On failure, keep both the lock and this process-owned partial copy. A later invocation must
  // diagnose the failed attempt instead of silently starting a second full game copy.
  await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
  const copiedDigest = await performanceProjectDigest(temporary);
  if (copiedDigest !== sourceDigest)
    throw new Error("performance project copy digest differs from its source");
  const marker = path.join(temporary, PERFORMANCE_PROJECT_COPY_MARKER);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, `${JSON.stringify({ source, projectDigest: sourceDigest }, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, copy);
  await rm(lock, { recursive: true });
  await validatePerformanceAuditProject(source, copy);
  return { source, copy: await realpath(copy), projectDigest: sourceDigest, created: true };
}

export async function validateExistingPerformanceProjectCopy(
  sourceProject,
  copiedProject,
  expectedDigest,
) {
  const { copy, sourceDigest } = await validatePerformanceProjectCopyMarker(
    sourceProject,
    copiedProject,
    expectedDigest,
  );
  const copiedDigest = await performanceProjectDigest(copy);
  if (copiedDigest !== sourceDigest)
    throw new Error("performance project copy inputs changed; refusing to copy the game again");
  return copy;
}

export async function validatePerformanceProjectCopyMarker(
  sourceProject,
  copiedProject,
  expectedDigest,
) {
  const source = await realpath(sourceProject);
  const copy = await realpath(copiedProject);
  const marker = JSON.parse(
    await readFile(path.join(copy, PERFORMANCE_PROJECT_COPY_MARKER), "utf8"),
  );
  const sourceDigest = expectedDigest ?? (await performanceProjectDigest(source));
  if (marker.source !== source || marker.projectDigest !== sourceDigest)
    throw new Error("performance project copy marker does not match the selected source");
  await validatePerformanceAuditProject(source, copy);
  return { source, copy, sourceDigest };
}

export async function performanceProjectDigest(root) {
  const hash = createHash("sha256");
  const project = await realpath(root);
  const paths = [];
  await inventory(project, "", paths);
  const hasCsv = await hasDirectChildDirectory(project, "csv");
  const hasErb = await hasDirectChildDirectory(project, "erb");
  paths.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  for (const relative of paths) {
    const category = classifyProjectInput(relative, hasCsv, hasErb);
    if (category == null) continue;
    const absolute = path.join(project, relative);
    const source = await readFile(absolute);
    const content =
      category === "resource"
        ? source
        : Buffer.from(decodeProjectText(source, category, path.basename(relative)), "utf8");
    updateLengthPrefixed(hash, Buffer.from(relative, "utf8"));
    updateLengthPrefixed(hash, Buffer.from(JSON.stringify(category), "utf8"));
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64LE(BigInt(content.length));
    hash.update(contentLength);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function inventory(directory, relativeDirectory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`performance project inventory rejects symbolic link ${relative}`);
    if (entry.isDirectory()) await inventory(path.join(directory, entry.name), relative, output);
    else if (entry.isFile()) output.push(relative);
  }
}

function updateLengthPrefixed(hash, bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function hasDirectChildDirectory(root, expected) {
  return (await readdir(root, { withFileTypes: true })).some(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === expected,
  );
}

function classifyProjectInput(relative, hasCsv, hasErb) {
  const lower = relative.toLowerCase();
  const parts = lower.split("/");
  const first = parts[0] ?? "";
  const name = parts.at(-1) ?? "";
  const extension = name.split(".").at(-1) ?? "";
  if (["reraconfig.toml", "setting.json"].includes(name)) return "configuration";
  if (["xml", "txt", "db", "sqlite"].includes(extension))
    return [".git", ".rustyera", "sav", "save", "saves", "data", "log", "logs"].includes(first)
      ? null
      : "resource";
  if (first === "resources") {
    if (extension === "csv") return "resource_manifest";
    return [
      "bmp",
      "gif",
      "jpeg",
      "jpg",
      "png",
      "webp",
      "aac",
      "flac",
      "m4a",
      "mp3",
      "ogg",
      "opus",
      "wav",
    ].includes(extension)
      ? "resource"
      : null;
  }
  if (first === "sound")
    return ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"].includes(extension)
      ? "resource"
      : null;
  if (first === "font")
    return ["otf", "ttc", "ttf", "woff", "woff2"].includes(extension) ? "resource" : null;
  if (extension === "csv" && (!hasCsv || first === "csv")) return "csv";
  if (extension === "erb" && (!hasErb || first === "erb")) return "erb";
  if (extension === "erh" && (!hasErb || first === "erb")) return "erh";
  if (extension === "erd" && (!hasErb || first === "erb")) return "erd";
  if (extension === "als" && (!(hasCsv || hasErb) || ["csv", "erb"].includes(first))) return "als";
  if (extension === "config" && (!hasCsv || !lower.includes("/") || first === "csv"))
    return "configuration";
  return null;
}

function decodeProjectText(bytes, category, name) {
  const source = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? bytes.subarray(3)
    : bytes;
  const encodings =
    ["als", "erd"].includes(category) || name.toLowerCase() === "reraconfig.toml"
      ? ["utf-8"]
      : ["utf-8", "shift_jis", "gbk"];
  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(source);
    } catch {
      // Try the next strict frontend-compatible decoder.
    }
  }
  throw new Error(`${name} is not valid UTF-8, Windows-31J, or GBK`);
}

export async function minimizePerformanceWindow(browser) {
  await browser.minimizeWindow();
}

export async function waitForPerformanceWindowSafety(browser, inspectWindow) {
  let state;
  let lastError;
  try {
    await browser.waitUntil(
      async () => {
        try {
          state = await inspectWindow();
          return true;
        } catch (error) {
          lastError = error;
          return false;
        }
      },
      {
        timeout: 5_000,
        interval: 50,
        timeoutMsg:
          "Tauri performance window did not reach a safe minimized state within 5 seconds",
      },
    );
  } catch (error) {
    if (lastError instanceof Error)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; last window safety failure: ${lastError.message}`,
        { cause: lastError },
      );
    throw error;
  }
  if (state === undefined) throw new Error("Tauri performance window safety returned no state");
  return state;
}

export async function readPerformanceWindowState(browser) {
  return browser.execute(async () => {
    const api = window.__TAURI__.window;
    const current = api.getCurrentWindow();
    const [visible, minimized, focused, position, size] = await Promise.all([
      current.isVisible(),
      current.isMinimized(),
      current.isFocused(),
      current.outerPosition(),
      current.outerSize(),
    ]);
    return {
      mode: "minimized",
      visible,
      minimized,
      focused,
      position,
      size,
      documentFocused: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  });
}

export async function capturePerformanceWindowSafety(
  browser,
  foregroundBaseline,
  rootPid,
  dependencies = {},
) {
  const windowState = await readPerformanceWindowState(browser);
  const observeForeground =
    dependencies.observeForegroundApplication ?? observeForegroundApplication;
  const captureProcessTree =
    dependencies.capturePerformanceProcessTree ?? capturePerformanceProcessTree;
  const [foreground, processTree] = await Promise.all([
    observeForeground(),
    captureProcessTree(rootPid),
  ]);
  const ownsForeground = processTree.some((process) => process.pid === foreground?.pid);
  return { ...windowState, foreground, foregroundBaseline, ownsForeground, processTree };
}

export async function observeForegroundApplication(platform = process.platform) {
  if (platform !== "darwin") return null;
  const { stdout } = await promisify(execFile)(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); var app = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name: ObjC.unwrap(app.localizedName), bundleIdentifier: ObjC.unwrap(app.bundleIdentifier), pid: app.processIdentifier});',
    ],
    { timeout: 3_000 },
  );
  return JSON.parse(stdout);
}

export async function capturePerformanceProcessTree(binary, platform = process.platform) {
  if (!Number.isSafeInteger(binary) || binary <= 0)
    throw new Error("performance process tree requires the exact launched Tauri PID");
  if (platform === "win32")
    return selectPerformanceProcessTree(await readWindowsPerformanceProcesses(), binary);
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-axo", "pid=,ppid=,rss=,%cpu=,command="],
    {
      timeout: 3_000,
    },
  );
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      command: match[5],
    }));
  return selectPerformanceProcessTree(rows, binary);
}

export function selectPerformanceProcessTree(rows, rootPid) {
  if (!rows.some((row) => row.pid === rootPid))
    throw new Error(`launched Tauri PID ${rootPid} is absent from the process table`);
  const roots = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (roots.has(row.parentPid) && !roots.has(row.pid)) {
        roots.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => roots.has(row.pid));
}

export async function resolvePerformanceRootPid(binary, platform = process.platform) {
  const resolvedBinary = await realpath(binary);
  if (platform === "win32") {
    // Restrict identity lookup to this runner's descendants, never another user's session.
    const owned = selectPerformanceProcessTree(
      await readWindowsPerformanceProcesses(),
      process.pid,
    );
    return selectWindowsPerformanceRootPid(owned, resolvedBinary);
  }
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,command="], {
    timeout: 3_000,
  });
  const matches = stdout
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .filter((match) => firstCommandArgument(match[2]) === resolvedBinary)
    .map((match) => Number(match[1]));
  if (matches.length !== 1)
    throw new Error(`expected exactly one launched performance binary, found ${matches.length}`);
  return matches[0];
}

async function readWindowsPerformanceProcesses() {
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath,CommandLine)";
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
  );
  return parseWindowsPerformanceProcesses(stdout);
}

export function parseWindowsPerformanceProcesses(stdout) {
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!Array.isArray(rows)) throw new Error("Windows process inventory must be an array");
  const seen = new Set();
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("invalid Windows process inventory row");
    if (!(
      typeof row.WorkingSetSize === "number" ||
      (typeof row.WorkingSetSize === "string" && /^\d+$/.test(row.WorkingSetSize))
    ))
      throw new Error("invalid Windows process inventory RSS");
    const pid = row.ProcessId;
    const parentPid = row.ParentProcessId;
    const rssBytes = Number(row.WorkingSetSize);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      seen.has(pid) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(rssBytes) ||
      rssBytes < 0 ||
      (row.ExecutablePath != null && typeof row.ExecutablePath !== "string") ||
      (row.CommandLine != null && typeof row.CommandLine !== "string")
    )
      throw new Error("invalid Windows process inventory row");
    seen.add(pid);
    return {
      pid,
      parentPid,
      rssBytes,
      cpuPercent: null,
      executable: row.ExecutablePath ?? null,
      command: row.CommandLine ?? "",
    };
  });
}

export function selectWindowsPerformanceRootPid(rows, binary) {
  const normalize = (value) =>
    path.win32
      .normalize(value)
      .replace(/^\\\\\?\\/, "")
      .toLowerCase();
  const expected = normalize(binary);
  const matches = rows.filter((row) => row.executable && normalize(row.executable) === expected);
  if (matches.length !== 1)
    throw new Error(`expected exactly one launched performance binary, found ${matches.length}`);
  return matches[0].pid;
}

function firstCommandArgument(command) {
  const quoted = /^"([^"]+)"/.exec(command);
  return quoted?.[1] ?? command.split(/\s+/, 1)[0];
}

function requireOccurrences(arguments_, option, expected) {
  const actual = arguments_.filter((argument) => argument === option).length;
  if (actual !== expected) throw new Error(`${option} must be specified exactly ${expected} time`);
}

function requireSingleOptionValue(arguments_, option) {
  requireOccurrences(arguments_, option, 1);
  const index = arguments_.indexOf(option);
  const value = arguments_[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--"))
    throw new Error(`${option} requires one non-option value`);
}

function assertOnlyPerformanceArguments(arguments_) {
  const flags = new Set([
    "--perf-audit",
    "--background-dom",
    "--release",
    "--reuse-build",
    "--require-reuse-build",
    "--build-only",
  ]);
  const options = new Set(["--project", "--spec", "--window-mode"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (flags.has(argument)) continue;
    if (options.has(argument)) {
      index += 1;
      continue;
    }
    throw new Error(`unsupported --perf-audit argument ${argument}`);
  }
}
