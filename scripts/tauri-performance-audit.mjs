/* global document, window */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const PERFORMANCE_AUDIT_SPEC = "snake-runtime-performance.spec.mjs";
export const DEFAULT_PERFORMANCE_WINDOW_MODE = "visible";
export const PERFORMANCE_WINDOW_MODES = new Set(["visible", "minimized", "offscreen"]);

export function performanceWindowMode(arguments_) {
  const indexes = arguments_.flatMap((value, index) => (value === "--window-mode" ? [index] : []));
  if (indexes.length > 1) throw new Error("--window-mode may be specified only once");
  if (indexes.length === 0) return DEFAULT_PERFORMANCE_WINDOW_MODE;
  const mode = arguments_[indexes[0] + 1];
  if (!mode || mode.startsWith("--")) throw new Error("--window-mode requires a value");
  if (!PERFORMANCE_WINDOW_MODES.has(mode))
    throw new Error("--window-mode must be visible, minimized, or offscreen");
  return mode;
}

export function performanceWindowArguments(mode) {
  if (!PERFORMANCE_WINDOW_MODES.has(mode))
    throw new Error("performance window mode must be visible, minimized, or offscreen");
  return [...(mode === "visible" ? [] : ["--background-dom"]), "--window-mode", mode];
}

export function instrumentedPerformanceWindowMode(options, instrumentPerformance) {
  if (!instrumentPerformance) return undefined;
  return options.windowMode ?? DEFAULT_PERFORMANCE_WINDOW_MODE;
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
  for (const optionalFlag of ["--reuse-build", "--require-reuse-build"])
    if (arguments_.includes(optionalFlag)) requireOccurrences(arguments_, optionalFlag, 1);
  for (const rejected of [
    "--state",
    "--state-type",
    "--build-only",
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
  const background = windowMode !== "visible";
  if (background !== backgroundDom)
    throw new Error(
      background
        ? "minimized or offscreen performance mode requires --background-dom"
        : "--background-dom requires minimized or offscreen performance mode",
    );
  return { enabled: true, background, windowMode };
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

export function classifyWindowCalibration(minimized, offscreen) {
  const minimizedMedian = Number(minimized?.medianIntervalMs);
  const offscreenMedian = Number(offscreen?.medianIntervalMs);
  const ratio =
    Number.isFinite(minimizedMedian) && Number.isFinite(offscreenMedian) && offscreenMedian > 0
      ? minimizedMedian / offscreenMedian
      : Number.POSITIVE_INFINITY;
  const minimizedPaint = Number(minimized?.medianPaintCheckpointMs);
  const offscreenPaint = Number(offscreen?.medianPaintCheckpointMs);
  const paintRatio =
    Number.isFinite(minimizedPaint) && Number.isFinite(offscreenPaint) && offscreenPaint > 0
      ? minimizedPaint / offscreenPaint
      : Number.POSITIVE_INFINITY;
  const throttled =
    minimized?.timedOut === true ||
    Number(minimized?.nonBusinessStallsOver100Ms ?? 0) > 0 ||
    ratio > 1.2 ||
    paintRatio > 1.2;
  const offscreenUsable =
    offscreen?.timedOut !== true &&
    Number(offscreen?.observedFrames ?? 0) === Number(offscreen?.requestedFrames ?? 100) &&
    Number(offscreen?.nonBusinessStallsOver100Ms ?? 0) === 0;
  return {
    selectedMode: throttled ? "offscreen" : "minimized",
    minimizedToOffscreenMedianRatio: Number.isFinite(ratio) ? ratio : null,
    minimizedToOffscreenPaintRatio: Number.isFinite(paintRatio) ? paintRatio : null,
    minimizedThrottled: throttled,
    offscreenUsable,
  };
}

export async function capturePerformanceWindowSafety(
  browser,
  windowMode,
  foregroundBaseline,
  rootPid,
) {
  const windowState = await browser.execute(async (mode) => {
    const api = window.__TAURI__.window;
    const current = api.getCurrentWindow();
    const [visible, minimized, focused, position, size, monitors] = await Promise.all([
      current.isVisible(),
      current.isMinimized(),
      current.isFocused(),
      current.outerPosition(),
      current.outerSize(),
      api.availableMonitors(),
    ]);
    const right = Math.max(...monitors.map((monitor) => monitor.position.x + monitor.size.width));
    const bottom = Math.max(...monitors.map((monitor) => monitor.position.y + monitor.size.height));
    const offscreen =
      position.x >= right ||
      position.y >= bottom ||
      position.x + size.width <= Math.min(...monitors.map((monitor) => monitor.position.x)) ||
      position.y + size.height <= Math.min(...monitors.map((monitor) => monitor.position.y));
    return {
      mode,
      visible,
      minimized,
      focused,
      position,
      size,
      offscreen,
      documentFocused: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  }, windowMode);
  const foreground = windowMode === "visible" ? null : await observeForegroundApplication();
  const processTree = await capturePerformanceProcessTree(rootPid);
  const ownsForeground = processTree.some((process) => process.pid === foreground?.pid);
  const validPlacement =
    windowMode === "visible"
      ? windowState.visible && !windowState.minimized && !windowState.offscreen
      : windowMode === "minimized"
        ? windowState.visible && windowState.minimized
        : windowState.visible && !windowState.minimized && windowState.offscreen;
  const backgroundViolation =
    windowMode !== "visible" &&
    (windowState.focused || windowState.documentFocused || ownsForeground);
  if (!validPlacement || backgroundViolation) {
    throw new Error(
      `Tauri performance audit violated window policy: ${JSON.stringify({ windowState, foreground, foregroundBaseline })}`,
    );
  }
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
  const command = platform === "win32" ? "wmic" : "/bin/ps";
  const args =
    platform === "win32"
      ? ["process", "get", "ProcessId,ParentProcessId,WorkingSetSize,Name", "/format:csv"]
      : ["-axo", "pid=,ppid=,rss=,%cpu=,command="];
  const { stdout } = await promisify(execFile)(command, args, { timeout: 3_000 });
  if (platform === "win32") return [];
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
  if (!rows.some((row) => row.pid === binary))
    throw new Error(`launched Tauri PID ${binary} is absent from the process table`);
  const roots = new Set([binary]);
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
  if (platform === "win32")
    throw new Error("performance PID resolution is not implemented on Windows");
  const resolvedBinary = await realpath(binary);
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
