import { cancelProjectExportDuringTransfer } from "./project-export-cancel.mjs";
/* global document, window, HTMLImageElement */

import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import { blake3 } from "@noble/hashes/blake3.js";
import {
  assertProjectStorage,
  typedValues,
  validateExpectedValues,
} from "./interop-assertions.mjs";

/** Select the native browser's actual automation window and establish document focus. */
export async function focusNativeBrowser(
  browser,
  name,
  { platform = process.platform, execute = promisify(execFile) } = {},
) {
  const application = { safari: "com.apple.Safari", firefox: "org.mozilla.firefox" }[name];
  if (!application) throw new Error("unsupported native browser foreground target");
  if (platform === "darwin" && name !== "safari")
    await execute(
      "/usr/bin/osascript",
      ["-e", `tell application id "${application}" to activate`],
      {
        timeout: 3_000,
      },
    );
  const handle = await browser.getWindowHandle();
  await browser.switchToWindow(handle);
  if (name === "safari") {
    const point = await browser.execute(() => {
      const heading = document.querySelector(".welcome h1");
      if (!heading || heading.getClientRects().length === 0) return null;
      const rectangle = heading.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return null;
      return {
        x: Math.round(rectangle.left + rectangle.width / 2),
        y: Math.round(rectangle.top + rectangle.height / 2),
      };
    });
    if (!point) throw new Error("Safari welcome heading is not visible for foreground focus");
    await browser
      .action("pointer")
      .move({ ...point, origin: "viewport" })
      .down("left")
      .up("left")
      .perform();
  }
  await browser.waitUntil(
    () => browser.execute(() => document.visibilityState === "visible" && document.hasFocus()),
    {
      timeout: 3_000,
      interval: 50,
      timeoutMsg: "native browser window is not visible and focused",
    },
  );
}

export {
  goalStatus,
  observationFromSnapshot,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  snakeAudioRelations,
  snakeAudioStressRelations,
  terminalRuntimeRejection,
} from "./web-test-runtime.mjs";
export {
  compareObservations,
  REFERENCE_SCHEMA_VERSION,
  ReferenceProcess,
} from "./web-test-reference.mjs";

export function browserProjectProgressErrors(progress) {
  const labels = progress.labels ?? [];
  const errors = [];
  const coldStartup = progress.startupTelemetry;
  const runtimeStages = coldStartup?.observedStages ?? {};
  const completedColdStartup =
    coldStartup?.scenario === "cold" &&
    coldStartup.cacheHit === false &&
    coldStartup.outcome === "success" &&
    ["importing", "compiling", "finalizing"].every((stage) => runtimeStages[stage] > 0);
  const portableImportCompleted =
    progress.portableImport?.fallback === true && progress.portableImport.directoryPicker === true;
  const copied =
    portableImportCompleted ||
    labels.some((label) => /^正在复制项目文件：\d+\/\d+（\d+%）$/.test(label));
  const scanned = labels.some(
    (label) => label.startsWith("正在枚举项目文件…") || label.startsWith("正在读取项目文件："),
  );
  const submitted = labels.some((label) => label.startsWith("正在准备项目数据"));
  const runtimePreparation =
    completedColdStartup ||
    labels.some(
      (label) =>
        label.startsWith("正在编译脚本函数") ||
        label.startsWith("正在验证编译结果") ||
        label.startsWith("正在准备 Runtime 资源"),
    );
  const cacheHandoff = labels.includes("项目文件读取完成，正在准备编译与校验…");

  if (!copied) errors.push("copy progress");
  if (!scanned && !submitted && !completedColdStartup) errors.push("project discovery");
  if (progress.gaps !== 0 && !completedColdStartup) errors.push("continuous progress");
  if (progress.active || (!progress.completed && !completedColdStartup)) {
    errors.push("completed progress");
  }
  if (progress.cacheHit ? !cacheHandoff : !runtimePreparation) {
    errors.push(progress.cacheHit ? "cache handoff" : "runtime preparation");
  }
  return errors;
}

export function packagedProjectProgressErrors(progress, requirePreferences = true) {
  const errors = [];
  const labels = progress.labels ?? [];
  if (!progress.cacheHit) errors.push("compiled cache hit");
  if (!labels.some((label) => label.startsWith("正在读取项目文件："))) errors.push("file read");
  if (!labels.some((label) => label.startsWith("项目缓存命中，正在准备脚本热重载…")))
    errors.push("cache handoff");
  if (
    labels.some(
      (label) =>
        label.startsWith("正在准备 Runtime 资源：") &&
        !/^正在准备 Runtime 资源：[01]\/1（(?:0|100)%）/.test(label),
    )
  ) {
    errors.push("source preparation slow path");
  }
  if (progress.active || !progress.completed) {
    errors.push("continuous completed progress");
  }
  if (requirePreferences) {
    if (
      !progress.projectPreferencesDuringLoad?.observedLoading ||
      !progress.projectPreferencesDuringLoad.dialogOpened ||
      !progress.projectPreferencesDuringLoad.projectTabEnabled ||
      !progress.projectPreferencesDuringLoad.projectFieldEditable ||
      !progress.projectPreferencesDuringLoad.saveSubmitted ||
      !progress.projectPreferencesDuringLoad.saveCompleted
    ) {
      errors.push("project preferences during loading");
    }
    if (
      !progress.projectPreferencesAfterLoad?.projectTabEnabled ||
      !progress.projectPreferencesAfterLoad.projectFieldEditable ||
      !progress.projectPreferencesAfterLoad.savedOverrideSelected
    ) {
      errors.push("project preferences after loading");
    }
  }
  return errors;
}

export async function loadScenario(file, projectOverride, stateOverride) {
  const scenarioPath = path.resolve(file);
  const raw = JSON.parse(await readFile(scenarioPath, "utf8"));
  if (raw.schema_version !== 1)
    throw new Error(`unsupported scenario schema ${raw.schema_version}`);
  if (!["fixed", "autonomous"].includes(raw.mode ?? "fixed"))
    throw new Error("scenario mode must be fixed or autonomous");
  if (raw.inputs && raw.actions) throw new Error("scenario cannot contain both inputs and actions");
  if (
    raw.expect_project_load_failure != null &&
    (typeof raw.expect_project_load_failure !== "string" ||
      !raw.expect_project_load_failure.trim() ||
      raw.comparison?.reference ||
      raw.inputs?.length ||
      raw.actions?.length)
  )
    throw new Error(
      "expect_project_load_failure requires a diagnostic code and no gameplay or reference comparison",
    );
  const resolveFromScenario = (value) => path.resolve(path.dirname(scenarioPath), value ?? ".");
  const start = raw.start ?? { type: "new_game" };
  if (!["new_game", "traditional_save", "vm_snapshot"].includes(start.type))
    throw new Error(`unknown start type ${start.type}`);
  if (start.type !== "new_game" && !start.path && !stateOverride)
    throw new Error(`${start.type} requires path or --state`);
  const configuredSeed = raw.seed;
  const seed =
    start.type !== "new_game"
      ? undefined
      : configuredSeed == null
        ? crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fff_ffff
        : typeof configuredSeed === "number"
          ? configuredSeed
          : String(configuredSeed);
  if (seed != null) {
    const text = String(seed);
    if (!/^\d+$/.test(text) || BigInt(text) > 0xffff_ffff_ffff_ffffn)
      throw new Error("seed must be a decimal unsigned 64-bit integer");
    if (typeof seed === "number" && !Number.isSafeInteger(seed))
      throw new Error("numeric seed must be a safe integer; use a decimal string for full u64");
  }
  const viewport = raw.viewport ?? { width: 1280, height: 800 };
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < 320 ||
    viewport.height < 240
  )
    throw new Error("scenario viewport must contain integer width/height of at least 320x240");
  if (raw.has_touch != null && typeof raw.has_touch !== "boolean")
    throw new Error("scenario has_touch must be a boolean");
  if (raw.summary_observations != null && typeof raw.summary_observations !== "boolean")
    throw new Error("scenario summary_observations must be a boolean");
  const actions = raw.actions
    ? raw.actions.map((item) => ({ ...item }))
    : (raw.inputs ?? []).map((item) => ({
        type: "input",
        ...(typeof item === "object" ? item : { value: item }),
      }));
  return {
    ...raw,
    path: scenarioPath,
    mode: raw.mode ?? "fixed",
    project: path.resolve(projectOverride ?? resolveFromScenario(raw.project)),
    project_file: raw.project_file ? resolveFromScenario(raw.project_file) : undefined,
    start: {
      ...start,
      path: stateOverride
        ? path.resolve(stateOverride)
        : start.path
          ? resolveFromScenario(start.path)
          : undefined,
    },
    seed,
    viewport,
    has_touch: raw.has_touch === true,
    actions,
    watches: (raw.watches ?? []).map(String),
    goal: raw.goal ?? {},
    limits: { max_steps: 100, timeout_seconds: 300, ...(raw.limits ?? {}) },
    comparison: raw.comparison ?? {},
  };
}

export class TraceWriter {
  constructor(file) {
    this.path = path.resolve(file);
    this.stream = createWriteStream(this.path, { encoding: "utf8" });
    this.pending = [];
    this.draining = undefined;
  }

  emit(event) {
    this.pending.push(event);
    this.draining ??= this.drain();
    const compact = compactTraceEvent(event);
    if (compact.type === "observation") {
      for (const key of ["rust", "reference"]) {
        if (compact[key]?.output) delete compact[key].output;
        const added = compact[key]?.output_delta?.added;
        if (added?.length > 30) {
          compact[key].output_delta.added_omitted = added.length - 30;
          compact[key].output_delta.added = added.slice(-30);
        }
      }
    }
    process.stdout.write(`${JSON.stringify(compact)}\n`);
  }

  async close() {
    await this.draining;
    await new Promise((resolve) => this.stream.end(resolve));
  }

  async drain() {
    while (this.pending.length) {
      const event = this.pending.shift();
      if (event.type?.endsWith("-snapshot") && Array.isArray(event.document))
        await this.writeSnapshot(event);
      else await this.write(`${JSON.stringify(event)}\n`);
    }
    this.draining = undefined;
  }

  async writeSnapshot(event) {
    await this.write("{");
    let fields = 0;
    for (const [key, value] of Object.entries(event)) {
      if (key === "document") {
        if (fields > 0) await this.write(",");
        await this.write(`${JSON.stringify(key)}:[`);
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) await this.write(",");
          await this.write(JSON.stringify(value[index]));
          if (index % 64 === 63) await new Promise((resolve) => setImmediate(resolve));
        }
        await this.write("]");
        fields += 1;
        continue;
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) continue;
      if (fields > 0) await this.write(",");
      await this.write(`${JSON.stringify(key)}:${serialized}`);
      fields += 1;
    }
    await this.write("}\n");
  }

  async write(chunk) {
    if (this.stream.write(chunk)) return;
    await new Promise((resolve) => this.stream.once("drain", resolve));
  }
}

export function compactTraceEvent(event) {
  return event.type?.endsWith("-snapshot")
    ? {
        ...event,
        document: { elementCount: Array.isArray(event.document) ? event.document.length : 0 },
      }
    : structuredClone(event);
}

export async function isolatedProject(source, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rustyera-web-test-"));
  const destination = path.join(root, "project");
  const sourceRuntimeRoot = await projectRuntimeStorageRoot(source);
  const compiledCacheRelative = path.relative(
    source,
    path.join(sourceRuntimeRoot, ".rustyera", "cache", "compiled-project.reracache"),
  );
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      if (options.cleanSaves && relative.split(path.sep)[0]?.toLocaleLowerCase() === "sav")
        return false;
      if (!relative.split(path.sep).includes(".rustyera")) return true;
      if (!options.compiledCache && !options.sourceIndexInput) return false;
      const retained = new Set([".rustyera", path.join(".rustyera", "cache")]);
      if (options.compiledCache) {
        let retainedPath = compiledCacheRelative;
        for (;;) {
          retained.add(retainedPath);
          const parent = path.dirname(retainedPath);
          if (parent === retainedPath || parent === ".") break;
          retainedPath = parent;
        }
      }
      if (options.sourceIndexInput)
        retained.add(path.join(".rustyera", "cache", "source-index-v1.json"));
      return retained.has(relative);
    },
  });
  if (options.compiledCacheInput) {
    const cacheDirectory = path.join(
      await projectRuntimeStorageRoot(destination),
      ".rustyera",
      "cache",
    );
    await mkdir(cacheDirectory, { recursive: true });
    await cp(
      path.resolve(options.compiledCacheInput),
      path.join(cacheDirectory, "compiled-project.reracache"),
    );
  }
  if (options.sourceIndexInput) {
    const cacheDirectory = path.join(destination, ".rustyera", "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await cp(
      path.resolve(options.sourceIndexInput),
      path.join(cacheDirectory, "source-index-v1.json"),
    );
    await alignProjectTimestampsWithSourceIndex(destination, options.sourceIndexInput);
  }
  if (options.runtimeStorageInput) {
    const runtimeRoot = await projectRuntimeStorageRoot(destination);
    await mkdir(runtimeRoot, { recursive: true });
    await cp(path.resolve(options.runtimeStorageInput), runtimeRoot, {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  return { root, project: destination, close: () => rm(root, { recursive: true, force: true }) };
}

export async function projectRuntimeStorageRoot(project) {
  const configuration = await readFile(path.join(project, "reraconfig.toml"), "utf8").catch(
    (error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    },
  );
  let section = "";
  let profile = "emuera.em";
  for (const sourceLine of configuration.split(/\r?\n/)) {
    const line = sourceLine.replace(/\s+#.*$/, "").trim();
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "compatibility") continue;
    const entry = /^profile\s*=\s*["']([^"']+)["']\s*$/.exec(line);
    if (entry) profile = entry[1];
  }
  if (profile === "emuera.em") return project;
  if (profile === "emuera.skia.snake") return path.join(project, ".rustyera", "profiles", profile);
  throw new Error(`unsupported compatibility profile for test storage: ${profile}`);
}

async function alignProjectTimestampsWithSourceIndex(project, sourceIndex) {
  const document = JSON.parse(await readFile(path.resolve(sourceIndex), "utf8"));
  for (const [relativePath, entry] of Object.entries(document.files ?? {})) {
    const target = path.resolve(project, ...relativePath.split("/"));
    if (target === project || !target.startsWith(`${project}${path.sep}`))
      throw new Error("source-index path must stay inside the isolated project");
    const match = /^(\d+):(\d+)$/.exec(typeof entry.signature === "string" ? entry.signature : "");
    const metadata = await stat(target, { bigint: true });
    if (!match || metadata.size !== BigInt(match[1]))
      throw new Error("source-index signature does not match the isolated project");
    const modified = Number(match[2]);
    if (!Number.isSafeInteger(modified)) throw new Error("source-index mtime is out of range");
    await utimes(target, Number(metadata.atimeNs) / 1_000_000_000, (modified + 0.5) / 1_000);
  }
}

export function crossHostArtifactPaths({
  source,
  isolated,
  cacheInput,
  cacheOutput,
  sourceIndexInput,
  sourceIndexOutput,
  projectOutput,
  runtimeStorageInput,
  runtimeStorageOutput,
}) {
  const resolvedSource = path.resolve(source);
  const resolvedIsolated = path.resolve(isolated);
  const input = cacheInput ? path.resolve(cacheInput) : undefined;
  const cache = cacheOutput ? path.resolve(cacheOutput) : undefined;
  const sourceIndexInputPath = sourceIndexInput ? path.resolve(sourceIndexInput) : undefined;
  const sourceIndex = sourceIndexOutput ? path.resolve(sourceIndexOutput) : undefined;
  const project = projectOutput ? path.resolve(projectOutput) : undefined;
  const runtimeStorageInputPath = runtimeStorageInput
    ? path.resolve(runtimeStorageInput)
    : undefined;
  const runtimeStorage = runtimeStorageOutput ? path.resolve(runtimeStorageOutput) : undefined;
  if (input && cache && input === cache) throw new Error("cache input and output must differ");
  if (sourceIndexInputPath && sourceIndex && sourceIndexInputPath === sourceIndex)
    throw new Error("source-index input and output must differ");
  if (runtimeStorageInputPath && runtimeStorageInputPath === runtimeStorage)
    throw new Error("runtime storage input and output must differ");
  const outputs = [cache, sourceIndex, project, runtimeStorage].filter(Boolean);
  if (new Set(outputs).size !== outputs.length)
    throw new Error("cross-host artifact outputs must differ");
  for (const target of outputs) {
    if (pathsOverlap(target, resolvedSource) || pathsOverlap(target, resolvedIsolated))
      throw new Error(`cross-host artifact target overlaps project state: ${target}`);
  }
  return {
    input,
    cache,
    sourceIndexInput: sourceIndexInputPath,
    sourceIndex,
    project,
    runtimeStorageInput: runtimeStorageInputPath,
    runtimeStorage,
  };
}

export async function publishCrossHostArtifacts({
  source,
  isolated,
  cacheInput,
  cacheOutput,
  sourceIndexInput,
  sourceIndexOutput,
  projectOutput,
  runtimeStorageInput,
  runtimeStorageOutput,
  succeeded,
  cacheSaved,
}) {
  // A failed producer must preserve its original failure. In particular, do not
  // let output-path validation or cleanup replace the scenario error.
  if (!succeeded) return;
  const targets = crossHostArtifactPaths({
    source,
    isolated,
    cacheInput,
    cacheOutput,
    sourceIndexInput,
    sourceIndexOutput,
    projectOutput,
    runtimeStorageInput,
    runtimeStorageOutput,
  });
  if (!targets.cache && !targets.sourceIndex && !targets.project && !targets.runtimeStorage) return;
  if (targets.cache && !cacheSaved)
    throw new Error("compiled cache output requires an observed successful cache save");
  if (targets.cache && (await pathExists(targets.cache)))
    throw new Error(`cache output target must not exist: ${targets.cache}`);
  if (targets.sourceIndex && (await pathExists(targets.sourceIndex)))
    throw new Error(`source-index output target must not exist: ${targets.sourceIndex}`);
  if (targets.project && (await directoryNonempty(targets.project)))
    throw new Error(`project output target must be absent or empty: ${targets.project}`);
  if (targets.runtimeStorage && (await directoryNonempty(targets.runtimeStorage)))
    throw new Error(
      `runtime storage output target must be absent or empty: ${targets.runtimeStorage}`,
    );
  const targetParents = [
    ...new Set(
      [targets.cache, targets.sourceIndex, targets.project, targets.runtimeStorage]
        .filter(Boolean)
        .map(path.dirname),
    ),
  ];
  if (targetParents.length > 1)
    throw new Error("cross-host cache and project outputs must share a parent directory");
  await mkdir(targetParents[0], { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(targetParents[0], ".handoff-"));
  try {
    if (targets.cache) {
      const cache = path.join(
        await projectRuntimeStorageRoot(isolated),
        ".rustyera",
        "cache",
        "compiled-project.reracache",
      );
      const temporary = path.join(temporaryRoot, "compiled-project.reracache");
      await copyFile(cache, temporary);
      await mkdir(path.dirname(targets.cache), { recursive: true });
    }
    if (targets.sourceIndex) {
      const sourceIndex = path.join(isolated, ".rustyera", "cache", "source-index-v1.json");
      await copyFile(sourceIndex, path.join(temporaryRoot, "source-index-v1.json"));
    }
    if (targets.project) {
      const temporary = path.join(temporaryRoot, "project");
      await copyProjectSources(isolated, temporary);
    }
    if (targets.runtimeStorage) {
      const temporary = path.join(temporaryRoot, "runtime-storage");
      await cp(await projectRuntimeStorageRoot(isolated), temporary, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    if (targets.cache)
      await rename(path.join(temporaryRoot, "compiled-project.reracache"), targets.cache);
    if (targets.sourceIndex)
      await rename(path.join(temporaryRoot, "source-index-v1.json"), targets.sourceIndex);
    if (targets.project) {
      await rm(targets.project, { recursive: true, force: true });
      await rename(path.join(temporaryRoot, "project"), targets.project);
    }
    if (targets.runtimeStorage) {
      await rm(targets.runtimeStorage, { recursive: true, force: true });
      await rename(path.join(temporaryRoot, "runtime-storage"), targets.runtimeStorage);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function directoryNonempty(directory) {
  try {
    return (await stat(directory)).isDirectory() && (await readdir(directory)).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyProjectSources(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".rustyera") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await cp(from, to, { recursive: true, preserveTimestamps: true });
    else if (entry.isFile()) await cp(from, to, { preserveTimestamps: true });
  }
}

export function injectInGameSaveFlow(source) {
  const marker = /PRINTL ORACLE_READY(\r\n|\n)/.exec(source);
  if (!marker) throw new Error("save-flow fixture lacks ORACLE_READY marker");
  if (source.includes("@SAVEINFO")) throw new Error("save-flow fixture already defines SAVEINFO");
  const newline = marker[1];
  return `${source.replace(marker[0], `${marker[0]}SAVEGAME${newline}`)}${newline}@SAVEINFO${newline}SAVEDATA_TEXT = "browser game save"${newline}RETURN${newline}`;
}

export function injectInteractionAssistFlow(source) {
  const marker = /PRINTL ORACLE_READY(\r\n|\n)/.exec(source);
  if (!marker) throw new Error("interaction-assist fixture lacks ORACLE_READY marker");
  if (source.includes('PRINTBUTTON "ASSISTED_ACTION", 0'))
    throw new Error("interaction-assist fixture already exposes its action");
  const newline = marker[1];
  const saveAnchor = `${marker[0]}SAVEGAME${newline}`;
  const anchor = source.includes(saveAnchor) ? saveAnchor : marker[0];
  const interactionLoop = [
    "$RUSTYERA_INTERACTION_ASSIST_WAIT",
    'PRINTBUTTON "ASSISTED_ACTION", 0',
    "INPUT",
    "GOTO RUSTYERA_INTERACTION_ASSIST_WAIT",
    "",
  ].join(newline);
  return source.replace(anchor, `${anchor}${interactionLoop}`);
}

export function nativeFirefoxCapabilities(platform = process.platform, { headless = true } = {}) {
  const options = { args: headless ? ["-headless"] : [] };
  const geckoDriverVersion = "0.37.1";
  if (platform === "darwin") {
    options.binary = "/Applications/Firefox.app/Contents/MacOS/firefox";
  }
  return {
    browserName: "firefox",
    // Returning before the load event keeps classic Marionette commands available while the
    // compatibility client performs long-running WASM startup work. BiDi session negotiation has
    // proven less reliable than Firefox's stable WebDriver HTTP endpoint on release builds.
    pageLoadStrategy: "none",
    "wdio:enforceWebDriverClassic": true,
    "wdio:geckodriverOptions": {
      binary: path.resolve(".rustyera", "webdriver", `geckodriver-${geckoDriverVersion}`),
      geckoDriverVersion,
    },
    "moz:firefoxOptions": options,
  };
}

export async function waitForWebDriverDocument(
  browser,
  expectedUrl,
  { timeoutMs = 5_000, stage = "waiting for target document" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = { url: null, readyState: null };
  let lastError;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      last = await deadlineRace(
        browser.execute(() => ({
          url: window.location.href,
          readyState: document.readyState,
        })),
        remaining,
        "document readiness probe",
      );
      if (last.url?.startsWith(expectedUrl) && last.readyState !== "loading") return last;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  throw new Error(
    `WebDriver target document did not become ready during ${stage}: ${JSON.stringify({
      expectedUrl,
      ...last,
      error: lastError?.message ?? null,
    })}`,
  );
}

async function deadlineRace(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function installRemoteFileSystem(page, root) {
  const writers = new Map();
  let nextWriter = 0;
  const safe = (relative) => {
    const resolved = path.resolve(root, relative || ".");
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      throw new Error(`project path escapes root: ${relative}`);
    return resolved;
  };
  await page.exposeBinding("__rustyeraFs", async (_source, request) => {
    const target = safe(request.path);
    if (request.op === "entries") {
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      }));
    }
    if (request.op === "stat") {
      const stat = await lstat(target, { bigint: true });
      return {
        size: Number(stat.size),
        kind: stat.isDirectory() ? "directory" : "file",
        lastModified: Number(stat.mtimeNs / 1_000_000n),
      };
    }
    if (request.op === "mkdir") return mkdir(target, { recursive: true }).then(() => true);
    if (request.op === "open_writer") {
      await mkdir(path.dirname(target), { recursive: true });
      const id = String(++nextWriter);
      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.rustyera-test-${id}.tmp`,
      );
      const handle = await open(temporary, "w");
      writers.set(id, { handle, target, temporary });
      return id;
    }
    if (request.op === "write_chunk") {
      const writer = writers.get(String(request.writer));
      if (!writer) throw new Error(`unknown filesystem writer ${request.writer}`);
      await writer.handle.write(Buffer.from(String(request.data), "base64"));
      return true;
    }
    if (request.op === "close_writer") {
      const id = String(request.writer);
      const writer = writers.get(id);
      if (!writer) throw new Error(`unknown filesystem writer ${request.writer}`);
      writers.delete(id);
      await writer.handle.close();
      await rename(writer.temporary, writer.target);
      return true;
    }
    if (request.op === "abort_writer") {
      const id = String(request.writer);
      const writer = writers.get(id);
      if (!writer) return true;
      writers.delete(id);
      await writer.handle.close();
      await rm(writer.temporary, { force: true });
      return true;
    }
    if (request.op === "write") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(request.data));
      return true;
    }
    if (request.op === "delete")
      return rm(target, { force: true, recursive: true }).then(() => true);
    throw new Error(`unknown filesystem operation ${request.op}`);
  });
  await page.exposeBinding("__rustyeraReplaceProjectSource", async (_source, request) => {
    const target = safe(request.relativePath);
    const source = await readFile(target, "utf8");
    if (source.split(request.expected).length !== 2)
      throw new Error(`source edit expected text must occur exactly once: ${request.relativePath}`);
    await writeFile(target, source.replace(request.expected, request.replacement), "utf8");
  });
  await page.addInitScript(() => {
    const FILE_WRITE_CHUNK_BYTES = 1024 * 1024;
    const base64 = (bytes) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    };
    const callFileSystem = async (request) => {
      try {
        return await window.__rustyeraFs(request);
      } catch (error) {
        const message = String(error);
        if (message.includes("ENOENT")) throw new DOMException(message, "NotFoundError");
        if (message.includes("EACCES") || message.includes("EPERM"))
          throw new DOMException(message, "NotAllowedError");
        throw error;
      }
    };
    class RemoteFileHandle {
      kind = "file";
      constructor(name, relativePath) {
        this.name = name;
        this.relativePath = relativePath;
      }
      async getFile() {
        const stat = await callFileSystem({ op: "stat", path: this.relativePath });
        const response = await fetch(
          `/__rustyera_test_file?path=${encodeURIComponent(this.relativePath)}`,
        );
        if (response.status === 404)
          throw new DOMException(`File not found: ${this.relativePath}`, "NotFoundError");
        if (!response.ok) throw new Error(`cannot read test file: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== stat.size)
          throw new Error(`test file changed while reading: ${this.relativePath}`);
        return new File([bytes], this.name, { lastModified: stat.lastModified });
      }
      async createWritable() {
        const writer = await callFileSystem({ op: "open_writer", path: this.relativePath });
        let active = true;
        return {
          write: async (value) => {
            if (!active) throw new DOMException("Writer is closed", "InvalidStateError");
            const data =
              value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
            for (let offset = 0; offset < data.length; offset += FILE_WRITE_CHUNK_BYTES) {
              await callFileSystem({
                op: "write_chunk",
                writer,
                data: base64(data.subarray(offset, offset + FILE_WRITE_CHUNK_BYTES)),
              });
            }
          },
          close: async () => {
            if (!active) return;
            active = false;
            await callFileSystem({ op: "close_writer", path: this.relativePath, writer });
          },
          abort: async () => {
            if (!active) return;
            active = false;
            await callFileSystem({ op: "abort_writer", path: this.relativePath, writer });
          },
        };
      }
      queryPermission = async () => "granted";
      requestPermission = async () => "granted";
    }
    class RemoteDirectoryHandle {
      kind = "directory";
      constructor(name, relativePath = "") {
        this.name = name;
        this.relativePath = relativePath;
      }
      child(name) {
        return this.relativePath ? `${this.relativePath}/${name}` : name;
      }
      async *entries() {
        for (const entry of await callFileSystem({ op: "entries", path: this.relativePath }))
          yield [
            entry.name,
            entry.kind === "directory"
              ? new RemoteDirectoryHandle(entry.name, this.child(entry.name))
              : new RemoteFileHandle(entry.name, this.child(entry.name)),
          ];
      }
      async getDirectoryHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await callFileSystem({ op: "mkdir", path: relative });
        // Native handles reject missing directories before returning a usable handle. Returning a
        // phantom handle turns an ordinary Data miss into a later traversal-conflict error.
        const metadata = await callFileSystem({ op: "stat", path: relative });
        if (metadata.kind !== "directory")
          throw new DOMException(`Not a directory: ${relative}`, "TypeMismatchError");
        return new RemoteDirectoryHandle(name, relative);
      }
      async getFileHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await callFileSystem({ op: "write", path: relative, data: [] });
        else await callFileSystem({ op: "stat", path: relative });
        return new RemoteFileHandle(name, relative);
      }
      removeEntry(name) {
        return callFileSystem({ op: "delete", path: this.child(name) });
      }
      queryPermission = async () => "granted";
      requestPermission = async () => "granted";
    }
    window.showDirectoryPicker = async () => new RemoteDirectoryHandle("project");
    window.__RUSTYERA_TEST_FS_REPLACE__ = (request) =>
      window.__rustyeraReplaceProjectSource(request);
  });
}

export function resolveLocator(page, locator = {}) {
  let resolved;
  if (locator.role)
    resolved = page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
  else if (locator.label) resolved = page.getByLabel(locator.label, { exact: locator.exact });
  else if (locator.text) resolved = page.getByText(locator.text, { exact: locator.exact });
  else if (locator.test_id) resolved = page.getByTestId(locator.test_id);
  else if (locator.css) resolved = page.locator(locator.css);
  else throw new Error("locator requires role, label, text, test_id, or css");
  return locator.nth == null ? resolved : resolved.nth(Number(locator.nth));
}

export function assertAtomicPresentationTransition(samples, completedRevision) {
  if (!Array.isArray(samples) || samples.length < 2)
    throw new Error("atomic presentation probe did not capture a painted transition");
  const startRevision = String(samples[0].revision);
  const endRevision = String(completedRevision);
  if (startRevision === endRevision)
    throw new Error(`atomic presentation transition did not advance from ${startRevision}`);
  const intermediate = samples.filter((sample) => {
    const revision = String(sample.revision);
    return revision !== startRevision && revision !== endRevision;
  });
  if (intermediate.length > 0) {
    throw new Error(
      `presentation transition painted intermediate revisions: ${JSON.stringify({ startRevision, endRevision, intermediate })}`,
    );
  }
  if (!samples.some((sample) => String(sample.revision) === endRevision)) {
    throw new Error(`atomic presentation probe did not paint completed revision ${endRevision}`);
  }
  return {
    startRevision,
    endRevision,
    paintedRevisions: [...new Set(samples.map((sample) => String(sample.revision)))],
    samples,
  };
}

async function startAtomicPresentationProbe(page) {
  await page.evaluate(() => {
    window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__?.stop?.();
    const samples = [];
    let frame;
    let stopped = false;
    const capture = () => {
      const snapshot = window.__RUSTYERA_TEST__.snapshot();
      const sample = {
        revision: String(snapshot.presentationRevision),
        waitId: snapshot.wait?.wait_id == null ? null : String(snapshot.wait.wait_id),
        canInteract: snapshot.canInteract,
        outputCount: snapshot.output.length,
        outputTail: snapshot.output.slice(-6),
      };
      const previous = samples.at(-1);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(sample)) samples.push(sample);
    };
    const sampleFrame = () => {
      if (stopped) return;
      capture();
      frame = window.requestAnimationFrame(sampleFrame);
    };
    capture();
    frame = window.requestAnimationFrame(sampleFrame);
    window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__ = {
      stop() {
        if (!stopped) {
          stopped = true;
          if (frame != null) window.cancelAnimationFrame(frame);
          capture();
        }
        delete window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__;
        return samples;
      },
    };
  });
}

async function stopAtomicPresentationProbe(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  return page.evaluate(() => window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__?.stop?.() ?? []);
}

export async function runAction(page, action) {
  if (action.type === "cancel_project_export")
    return cancelProjectExportDuringTransfer(page, action);
  if (action.type === "save_download") {
    assert.ok(typeof action.path === "string" && path.isAbsolute(action.path));
    assert.ok(typeof action.name_suffix === "string" && action.name_suffix.length > 0);
    assert.ok(typeof action.selector === "string" && action.selector.length > 0);
    await lstat(action.path).then(
      () => {
        throw new Error("download destination already exists");
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    // Full-project exports stream through a real Blob download, not the small test download
    // queue. Arm the native framework event before clicking so fast exports cannot be missed.
    // The scenario deadline and complete-state watchdog close the browser on failure;
    // a separate default 30-second event timeout must not cut off an advancing export.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 0 }),
      page.locator(action.selector).click(),
    ]);
    const name = download.suggestedFilename();
    assert.ok(name.endsWith(action.name_suffix), "unexpected downloaded artifact");
    assert.equal(await download.failure(), null, "native download failed");
    const source = await download.path();
    assert.ok(source, "native download path missing");
    const bytes = (await stat(source)).size;
    assert.ok(bytes > 0, "native download is empty");
    await mkdir(path.dirname(action.path), { recursive: true });
    await copyFile(source, action.path, fsConstants.COPYFILE_EXCL);
    return {
      query: { download: { name, path: action.path, bytes } },
    };
  }
  if (action.type === "assert_interop") {
    const expected = validateExpectedValues(action.expect);
    assert.ok(
      typeof action.evidence_path === "string" && path.isAbsolute(action.evidence_path),
      "assert_interop requires an absolute evidence_path",
    );
    const watches = Object.keys(expected);
    const typed = await page.evaluate(
      (names) => window.__RUSTYERA_TEST__.inspectTyped(names),
      watches,
    );
    const state = await page.evaluate(() => {
      const state = window.__RUSTYERA_TEST__.snapshotSummary();
      return {
        bridgeKind: state.bridgeKind,
        buildIdentity: state.buildIdentity,
        fault: state.fault,
        storage: window.__RUSTYERA_TEST__.protocolEvidence(["storage_request", "storage_response"]),
      };
    });
    const observation = {
      ...state,
      typed,
      restorePath: "see scenario actions and correlated storage records",
    };
    // Retain raw protocol values even when comparison or storage validation fails.
    await mkdir(path.dirname(action.evidence_path), { recursive: true });
    await writeFile(action.evidence_path, JSON.stringify(observation, null, 2) + "\n", {
      flag: "wx",
    });
    assert.equal(state.bridgeKind, "browser");
    assert.equal(state.fault, null);
    assert.deepEqual(typedValues(typed, watches), expected);
    assertProjectStorage(state.storage);
    return { query: { interop: observation } };
  }
  if (action.type === "edit_project_source") {
    await page.evaluate(
      (request) =>
        window.__RUSTYERA_TEST__.replaceProjectSource(
          request.relative_path,
          request.expected,
          request.replacement,
        ),
      action,
    );
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "reload_project") {
    const previousEpoch = await page.evaluate(
      () => window.__RUSTYERA_TEST__.snapshot().runtimeEpoch,
    );
    const expectSuccess = action.expect_success !== false;
    await page.evaluate(
      ({ scope, path }) => window.__RUSTYERA_TEST__.reloadProject(scope, path),
      action,
    );
    await page.waitForFunction(
      ({ epoch, expectSuccess }) => {
        const state = window.__RUSTYERA_TEST__.snapshot();
        if (state.projectLoading !== false || state.canInteract !== true) return false;
        return expectSuccess
          ? Number(state.runtimeEpoch) > Number(epoch)
          : Number(state.runtimeEpoch) === Number(epoch) && state.status.includes("失败");
      },
      { epoch: previousEpoch, expectSuccess },
    );
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "export_diagnosis") {
    const previousDownloads = await page.evaluate(
      () => window.__RUSTYERA_TEST_DOWNLOADS__?.length ?? 0,
    );
    await page.evaluate(() => window.__RUSTYERA_TEST__.exportDiagnosis());
    await page.waitForFunction((downloads) => {
      const state = window.__RUSTYERA_TEST__.snapshot();
      return (
        state.diagnosis?.exporting === false &&
        (window.__RUSTYERA_TEST_DOWNLOADS__?.length ?? 0) > downloads
      );
    }, previousDownloads);
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "wait_compiled_cache_saved") {
    await page.waitForFunction(
      () => {
        const state = window.__RUSTYERA_TEST__.snapshot();
        return (
          state.status === "项目缓存已保存。" ||
          state.logs?.some((entry) =>
            String(entry.message).includes("runtime.compiled_cache_failed"),
          )
        );
      },
      undefined,
      { timeout: 0 },
    );
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    const failure = state.logs?.find((entry) =>
      String(entry.message).includes("runtime.compiled_cache_failed"),
    );
    if (failure) throw new Error(`compiled cache export failed: ${String(failure.message)}`);
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "assert_diagnosis_project_manifest") {
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    const actual = state.lastDownload?.projectHashes ?? {};
    for (const [relativePath, source] of Object.entries(action.sources ?? {})) {
      const expected = hex(blake3(new TextEncoder().encode(String(source))));
      if (actual[relativePath] !== expected) {
        throw new Error(
          `diagnosis project source mismatch for ${relativePath}: expected ${expected}, got ${actual[relativePath]}`,
        );
      }
    }
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "advance_intermediate_waits_until") {
    const maximum = Number(action.maximum ?? 100);
    const mediaSourcesAtLeast = Number(action.until?.media_sources_at_least ?? 0);
    if (!Number.isInteger(mediaSourcesAtLeast) || mediaSourcesAtLeast <= 0)
      throw new Error(
        "advance_intermediate_waits_until requires a positive until.media_sources_at_least",
      );
    let numericInputs = 0;
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const sourceCount = await page.evaluate(() => {
        const media = window.__RUSTYERA_TEST__.mediaPlacements();
        return new Set(
          (media.images ?? []).map((item) => item?.source).filter((source) => Boolean(source)),
        ).size;
      });
      if (sourceCount >= mediaSourcesAtLeast)
        return { semanticInput: "", attempts: attempt, numericInputs, mediaSources: sourceCount };
      if (attempt === maximum)
        throw new Error(
          `intermediate wait budget exhausted before ${mediaSourcesAtLeast} media sources appeared`,
        );

      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
      if (!snapshot.wait) {
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
        continue;
      }
      if (snapshot.wait.deadline_ns != null) {
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      const waitId = snapshot.wait.wait_id;
      if (snapshot.wait.kind === "integer_value") {
        const input = page.locator(".prompt-bar input");
        await input.fill(String(action.integer_value ?? 0));
        await page.locator(".prompt-bar button[type=submit]").click();
        numericInputs += 1;
      } else if (
        ["enter_key", "any_key", "void"].includes(snapshot.wait.kind) ||
        (snapshot.wait.one_input && snapshot.wait.kind === "string_value")
      ) {
        if (snapshot.wait.kind === "string_value")
          await page.locator(".game-viewport .game-button").first().click();
        else await page.locator(".prompt-bar button[type=submit]").click();
      } else {
        throw new Error(
          `advance_intermediate_waits_until reached unexpected ${snapshot.wait.kind} prompt`,
        );
      }
      await page.waitForFunction((previousWaitId) => {
        const current = window.__RUSTYERA_TEST__.snapshot();
        return current.fault != null || current.wait?.wait_id !== previousWaitId;
      }, waitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "advance_enter_waits_until") {
    const maximum = Number(action.maximum ?? 100);
    const tailLines = Math.max(1, Number(action.until?.tail_lines ?? 30));
    const expectedText = String(action.until?.output_tail_contains ?? "");
    const expectedLocator = action.until?.locator
      ? resolveLocator(page, action.until.locator)
      : undefined;
    if (!expectedText && !expectedLocator)
      throw new Error(
        "advance_enter_waits_until requires until.output_tail_contains or until.locator",
      );
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshotSummary());
      const textReached =
        !expectedText || snapshot.output.slice(-tailLines).join("\n").includes(expectedText);
      const locatorReached =
        !expectedLocator ||
        ((await expectedLocator.count()) > 0 && (await expectedLocator.first().isVisible()));
      if (textReached && locatorReached) return { semanticInput: "", attempts: attempt };
      if (attempt === maximum)
        throw new Error(
          `Enter wait budget exhausted before target screen ${JSON.stringify(action.until)}`,
        );
      if (!snapshot.wait) {
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
        continue;
      }
      if (snapshot.wait?.deadline_ns != null) {
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      if (
        !["enter_key", "any_key", "void"].includes(snapshot.wait?.kind) &&
        !(snapshot.wait?.one_input && snapshot.wait?.kind === "string_value")
      )
        throw new Error(
          `advance_enter_waits_until reached unexpected ${snapshot.wait?.kind ?? "missing"} prompt`,
        );
      const waitId = snapshot.wait.wait_id;
      if (action.auto_enter === false) {
        await waitForAutomaticWaitChange(page, waitId);
        continue;
      }
      if (snapshot.wait.kind === "string_value")
        await page.locator(".game-viewport .game-button").first().click();
      else await page.locator(".prompt-bar button[type=submit]").click();
      await page.waitForFunction((previousWaitId) => {
        const current = window.__RUSTYERA_TEST__.snapshotSummary();
        return current.fault != null || current.wait?.wait_id !== previousWaitId;
      }, waitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "drain_void_waits") {
    const maximum = Number(action.maximum ?? 100);
    let automaticTimedWaits = 0;
    for (let attempt = 0; attempt < maximum; attempt += 1) {
      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
      if (snapshot.wait?.kind !== "void")
        return { semanticInput: "", attempts: attempt, automaticTimedWaits };
      if (snapshot.wait.deadline_ns != null) {
        automaticTimedWaits += 1;
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      await page.locator(".prompt-bar button[type=submit]").click();
      await page.waitForTimeout(20);
    }
    throw new Error(`void wait budget exhausted after ${maximum} attempts`);
  }
  if (action.type === "wait_timed_input_change") {
    const before = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    if (before.wait?.deadline_ns == null)
      throw new Error("wait_timed_input_change requires an active timed input wait");
    await waitForAutomaticWaitChange(page, before.wait.wait_id);
    const after = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    return {
      query: {
        timed_input: {
          previous_wait_id: before.wait.wait_id,
          next_wait_id: after.wait?.wait_id ?? null,
          previous_kind: before.wait.kind,
          next_kind: after.wait?.kind ?? null,
          viewport_policy: before.wait.viewport_policy,
        },
      },
    };
  }
  if (action.type === "input") {
    const beforeWaitId = await page.evaluate(
      () => window.__RUSTYERA_TEST__.snapshotSummary().wait?.wait_id,
    );
    const input = page.locator(".prompt-bar input");
    const value = String(action.value ?? "");
    await input.fill("");
    if (value) await input.pressSequentially(value);
    if (action.keyboard_submit === true) await input.press("Enter");
    else await page.locator(".prompt-bar button[type=submit]").click();
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
    if (action.message_skip) {
      await page.waitForFunction(() => {
        const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
        return snapshot.canInteract && snapshot.wait?.kind === "enter_key";
      });
      await page.locator(".game-viewport").click({ button: "right" });
    }
    return { semanticInput: value };
  }
  if (action.type === "click_until_text") {
    const maximum = Math.max(0, Number(action.maximum ?? 10));
    const required = (action.until_text ?? []).map(String);
    const forbidden = (action.until_not_text ?? []).map(String);
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const target = resolveLocator(page, action.locator);
      const value = (await target.textContent()) ?? "";
      if (
        required.every((text) => value.includes(text)) &&
        forbidden.every((text) => !value.includes(text))
      )
        return { semanticInput: action.semantic_input, attempts: attempt, text: value };
      if (attempt === maximum)
        throw new Error(`click_until_text did not reach ${JSON.stringify(action)}`);
      const beforeWaitId = await page.evaluate(
        () => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id,
      );
      await target.click();
      if (beforeWaitId != null)
        await page.waitForFunction((waitId) => {
          const snapshot = window.__RUSTYERA_TEST__.snapshot();
          return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
        }, beforeWaitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "sample_queries") return sampleQueries(page, action);
  if (action.type === "set_viewport") {
    const width = Number(action.width);
    const height = Number(action.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
      throw new Error("set_viewport requires positive integer width and height");
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    );
    return { query: { viewport: { width, height } } };
  }
  if (action.type === "set_game_text_style") {
    const family = String(action.font_family ?? "").trim();
    const size = Number(action.font_size);
    if (!family || !Number.isFinite(size) || size <= 0)
      throw new Error("set_game_text_style requires a font family and positive font size");
    await page.evaluate(
      ({ family, size }) => {
        const application = document.querySelector(".app-shell");
        if (!(application instanceof globalThis.HTMLElement))
          throw new Error("app shell is not available");
        let sheet = document.querySelector("#rustyera-test-game-text-style");
        if (!(sheet instanceof globalThis.HTMLStyleElement)) {
          sheet = document.createElement("style");
          sheet.id = "rustyera-test-game-text-style";
          document.head.append(sheet);
        }
        sheet.textContent = "[data-rustyera-test-game-text-style] {}";
        const rule = sheet.sheet?.cssRules[0];
        if (!(rule instanceof globalThis.CSSStyleRule))
          throw new Error("test style rule is not available");
        rule.style.setProperty("--game-font", family, "important");
        rule.style.setProperty("--game-size", `${size}px`, "important");
        rule.style.setProperty("--game-line-height", `${size + 1}px`, "important");
        application.dataset.rustyeraTestGameTextStyle = "";
      },
      { family, size },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    );
    return { query: { game_text_style: { font_family: family, font_size: `${size}px` } } };
  }
  if (action.type === "reveal_text") {
    const expected = String(action.text ?? "");
    if (!expected) throw new Error("reveal_text requires text");
    const revealed = await page.evaluate(async (text) => {
      const viewport = document.querySelector(".game-viewport");
      if (!(viewport instanceof globalThis.HTMLElement)) return false;
      const settle = () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        );
      const step = Math.max(1, Math.floor(viewport.clientHeight / 2));
      viewport.scrollTop = 0;
      for (let position = 0; position <= viewport.scrollHeight + step; position += step) {
        await settle();
        const target = [...document.querySelectorAll(".game-line")].find((line) =>
          line.textContent?.includes(text),
        );
        if (target instanceof globalThis.HTMLElement) {
          target.scrollIntoView({ block: "center" });
          await settle();
          return true;
        }
        viewport.scrollTop = position + step;
      }
      return false;
    }, expected);
    if (!revealed) throw new Error(`reveal_text could not find ${JSON.stringify(expected)}`);
    return { query: { revealed_text: expected } };
  }
  const locator = action.locator ? resolveLocator(page, action.locator) : undefined;
  if (action.type === "touch_gesture") {
    const gesture = String(action.gesture ?? "");
    if (!["two_finger_tap", "long_press"].includes(gesture))
      throw new Error("touch_gesture requires two_finger_tap or long_press");
    const box = await locator.boundingBox();
    if (!box) throw new Error("touch_gesture target is not visible");
    const beforeWaitId = action.advances_game
      ? await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id)
      : undefined;
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    const session = await page.context().newCDPSession(page);
    let failure;
    let touchStarted = false;
    try {
      const touchPoints =
        gesture === "two_finger_tap"
          ? [
              { x: centerX - 18, y: centerY, id: 1, radiusX: 8, radiusY: 8, force: 1 },
              { x: centerX + 18, y: centerY, id: 2, radiusX: 8, radiusY: 8, force: 1 },
            ]
          : [{ x: centerX, y: centerY, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
      touchStarted = true;
      await page.waitForTimeout(gesture === "long_press" ? 650 : 80);
    } catch (error) {
      failure = error;
    }
    if (touchStarted) {
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await session.detach();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshot();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
  } else if (action.type === "click") {
    const runtimeInput = await locator.evaluate((element) =>
      Boolean(
        (element.closest(".game-viewport") &&
          (element.matches("button") || element.closest("button"))) ||
        element.matches(".interaction-assist-action") ||
        element.closest(".interaction-assist-action"),
      ),
    );
    const beforeWaitId = runtimeInput
      ? await page.evaluate(() => window.__RUSTYERA_TEST__.snapshotSummary().wait?.wait_id)
      : undefined;
    let transitionSamples;
    let completedRevision;
    if (action.expect_atomic_presentation === true) {
      if (!runtimeInput)
        throw new Error("expect_atomic_presentation requires a runtime input button");
      await startAtomicPresentationProbe(page);
    }
    try {
      if (action.dom_click === true) await locator.evaluate((element) => element.click());
      else await locator.click({ button: action.button ?? "left", force: action.force === true });
      if (beforeWaitId != null)
        await page.waitForFunction((waitId) => {
          const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
          return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
        }, beforeWaitId);
      if (action.expect_atomic_presentation === true)
        completedRevision = await page.evaluate(async () => {
          await window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true);
          return String(window.__RUSTYERA_TEST__.snapshot().presentationRevision);
        });
    } finally {
      if (action.expect_atomic_presentation === true)
        transitionSamples = await stopAtomicPresentationProbe(page);
    }
    if (action.settle_ms != null) await page.waitForTimeout(Number(action.settle_ms));
    if (transitionSamples)
      return {
        query: {
          presentation_transition: assertAtomicPresentationTransition(
            transitionSamples,
            completedRevision,
          ),
        },
        semanticInput: action.semantic_input,
      };
  } else if (action.type === "scroll_key") {
    await locator.focus();
    await page.keyboard.press(String(action.key ?? "PageUp"));
    await page.waitForTimeout(Number(action.settle_ms ?? 50));
  } else if (action.type === "dblclick") await locator.dblclick();
  else if (action.type === "hover") await locator.hover();
  else if (action.type === "fill") await locator.fill(String(action.value ?? ""));
  else if (action.type === "press") await locator.press(String(action.key));
  else if (["query", "assert_dom"].includes(action.type)) {
    const actual = await queryLocator(locator, action.fields);
    if (action.type === "assert_dom") assertSubset(actual, action.expect ?? {});
    return { query: actual, semanticInput: action.semantic_input };
  } else if (action.type === "assert_layout") {
    const relative = action.relative_to ? resolveLocator(page, action.relative_to) : undefined;
    const actual = await queryLayout(locator, relative, action.box, action.relative_box);
    assertLayout(actual, action.expect ?? {});
    return { query: { layout: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "assert_canvas_pixels") {
    const actual = await queryCanvasPixels(locator);
    const expected = { ...(action.expect ?? {}) };
    if (expected.nontransparent_at_least != null) {
      const minimum = Number(expected.nontransparent_at_least);
      if (actual.nontransparent < minimum)
        throw new Error(
          `assertion failed at canvas_pixels.nontransparent: expected at least ${minimum}, got ${actual.nontransparent}`,
        );
      delete expected.nontransparent_at_least;
    }
    assertSubset(actual, expected);
    return { query: { canvas_pixels: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "query_media_replay") {
    const actual = await page.evaluate(
      (resourceName) => window.__RUSTYERA_TEST__.mediaReplay(resourceName),
      String(action.resource_name),
    );
    if (action.expect) assertSubset(actual, action.expect);
    return { query: { media_replay: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "assert_state") {
    // Ordinary state checks must not clone the entire startup wire ledger. Explicit
    // evidence assertions still receive the full records and lifecycle observations.
    const needsEvidence = [action.expect, action.expect_prefix].some(
      (expected) =>
        expected != null &&
        (Object.hasOwn(expected, "serviceEvidence") || Object.hasOwn(expected, "serviceLifecycle")),
    );
    const state = await page.evaluate(
      (fullEvidence) =>
        fullEvidence
          ? window.__RUSTYERA_TEST__.snapshot()
          : window.__RUSTYERA_TEST__.snapshotSummary(),
      needsEvidence,
    );
    assertSubset(state, action.expect ?? {});
    assertStringPrefixes(state, action.expect_prefix ?? {});
    return { state };
  } else throw new Error(`unknown action type ${action.type}`);
  return { semanticInput: action.semantic_input };
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function waitForAutomaticWaitChange(page, waitId) {
  await page.waitForFunction((previousWaitId) => {
    const current = window.__RUSTYERA_TEST__.snapshotSummary();
    return current.fault != null || current.wait?.wait_id !== previousWaitId;
  }, waitId);
  await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
}

export async function waitForRuntimeObservation(page, timeout, summary = false) {
  return page.evaluate(
    async ({ timeoutMs, summary }) => {
      let observing = true;
      const timedInput = new Promise((resolve) => {
        const poll = () => {
          if (!observing) return;
          const current = window.__RUSTYERA_TEST__.snapshotSummary();
          if (current.canInteract && current.wait?.deadline_ns != null) {
            resolve(summary ? current : window.__RUSTYERA_TEST__.snapshot());
            return;
          }
          window.requestAnimationFrame(poll);
        };
        poll();
      });
      try {
        return await Promise.race([
          summary
            ? window.__RUSTYERA_TEST__.waitForStableObservation(timeoutMs, true)
            : window.__RUSTYERA_TEST__.waitForStableObservation(timeoutMs),
          timedInput,
        ]);
      } finally {
        observing = false;
      }
    },
    { timeoutMs: timeout, summary },
  );
}

async function sampleQueries(page, action) {
  const count = Number(action.count ?? 3);
  const interval = Number(action.interval_ms ?? 1_000);
  const queries = action.queries ?? [];
  if (!Number.isInteger(count) || count < 2)
    throw new Error("sample_queries count must be an integer of at least 2");
  if (!Number.isFinite(interval) || interval < 0)
    throw new Error("sample_queries interval_ms must be a non-negative number");
  if (!queries.length) throw new Error("sample_queries requires at least one query");
  const names = queries.map((query) => String(query.name ?? ""));
  if (names.some((name) => !name) || new Set(names).size !== names.length)
    throw new Error("sample_queries query names must be non-empty and unique");

  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const runtime = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    if (runtime.fault && !action.allow_fault)
      throw new Error(`runtime fault while sampling queries: ${JSON.stringify(runtime.fault)}`);
    const sample = {
      runtime: {
        presentation_revision: runtime.presentationRevision,
        history_revision: runtime.historyRevision,
        output_count: runtime.output?.length,
      },
    };
    for (const query of queries)
      sample[query.name] = await queryLocator(resolveLocator(page, query.locator), query.fields);
    samples.push(sample);
    if (index + 1 < count) await page.waitForTimeout(interval);
  }
  assertSampleExpectations(samples, action.expect ?? {});
  return { query: { samples }, semanticInput: action.semantic_input };
}

function assertSampleExpectations(samples, expected) {
  for (const path of expected.stable ?? []) {
    const values = samples.map((sample, index) => valueAtPath(sample, path, index));
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0])))
      throw new Error(
        `assertion failed at sample_queries.stable.${path}: got ${JSON.stringify(values)}`,
      );
  }
  for (const path of expected.changes ?? []) {
    const values = samples.map((sample, index) => valueAtPath(sample, path, index));
    if (new Set(values.map((value) => JSON.stringify(value))).size < 2)
      throw new Error(
        `assertion failed at sample_queries.changes.${path}: got ${JSON.stringify(values)}`,
      );
  }
}

function valueAtPath(value, path, sampleIndex) {
  let current = value;
  for (const key of String(path).split(".")) {
    if (current == null || !Object.hasOwn(current, key))
      throw new Error(`sample_queries path ${path} is missing from sample ${sampleIndex}`);
    current = current[key];
  }
  return current;
}

async function queryCanvasPixels(locator) {
  const count = await locator.count();
  if (!count) return { count, nontransparent: 0 };
  return locator.first().evaluate((element, elementCount) => {
    if (element?.tagName !== "CANVAS") throw new Error("locator is not a canvas");
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas has no 2D context");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let nontransparent = 0;
    for (let index = 3; index < pixels.length; index += 4)
      if (pixels[index] !== 0) nontransparent += 1;
    return {
      count: elementCount,
      width: element.width,
      height: element.height,
      nontransparent,
    };
  }, count);
}

async function queryLayout(locator, relative, boxMode, relativeBoxMode) {
  const subject = await layoutBoxes(locator, boxMode);
  const reference = relative ? await layoutBoxes(relative, relativeBoxMode) : undefined;
  return {
    count: subject.length,
    visible: subject.some((item) => item.width > 0 && item.height > 0),
    boxes: subject,
    reference_count: reference?.length,
    reference_boxes: reference,
  };
}

async function layoutBoxes(locator, mode) {
  if (mode != null && mode !== "game_line") throw new Error(`unsupported layout box mode: ${mode}`);
  return locator.evaluateAll(
    (elements, boxMode) =>
      elements.map((element) => {
        const measured = boxMode === "game_line" ? element.closest(".game-line") : element;
        if (!measured) throw new Error("layout element is not inside a game line");
        const box = measured.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      }),
    mode,
  );
}

function assertLayout(actual, expected) {
  if (expected.count != null && actual.count !== expected.count)
    throw new Error(
      `assertion failed at layout.count: expected ${expected.count}, got ${actual.count}`,
    );
  if (expected.visible != null && actual.visible !== expected.visible)
    throw new Error(
      `assertion failed at layout.visible: expected ${expected.visible}, got ${actual.visible}`,
    );
  if (!actual.boxes.length) return;

  const first = actual.boxes[0];
  if (expected.same_left_within != null)
    assertSpread(
      "left",
      actual.boxes.map((item) => item.left),
      expected.same_left_within,
    );
  if (expected.same_top_within != null)
    assertSpread(
      "top",
      actual.boxes.map((item) => item.top),
      expected.same_top_within,
    );

  const reference = actual.reference_boxes?.[0];
  if (!reference) {
    if (
      expected.above ||
      expected.below ||
      expected.no_overlap ||
      expected.inside ||
      expected.horizontal_centered_within != null ||
      expected.vertical_centered_within != null ||
      expected.left_aligned_within != null ||
      expected.right_aligned_within != null ||
      expected.top_aligned_within != null ||
      expected.bottom_aligned_within != null
    )
      throw new Error(
        "assertion failed at layout.relative_to: relationship requires a matching element",
      );
    return;
  }

  if (expected.above) assertGap("above", reference.top - first.bottom, expected.above);
  if (expected.below) assertGap("below", first.top - reference.bottom, expected.below);
  if (expected.no_overlap) {
    const overlaps =
      first.left < reference.right &&
      first.right > reference.left &&
      first.top < reference.bottom &&
      first.bottom > reference.top;
    if (overlaps)
      throw new Error("assertion failed at layout.no_overlap: subject intersects relative_to");
  }
  if (expected.inside) {
    const tolerance = Number(expected.inside.tolerance ?? 0);
    if (
      first.left < reference.left - tolerance ||
      first.top < reference.top - tolerance ||
      first.right > reference.right + tolerance ||
      first.bottom > reference.bottom + tolerance
    )
      throw new Error(
        `assertion failed at layout.inside: subject ${JSON.stringify(first)} exceeds ` +
          `relative_to ${JSON.stringify(reference)} by more than ${tolerance}px`,
      );
  }
  if (expected.horizontal_centered_within != null)
    assertDistance(
      "horizontal_center",
      (first.left + first.right) / 2,
      (reference.left + reference.right) / 2,
      expected.horizontal_centered_within,
    );
  if (expected.vertical_centered_within != null)
    assertDistance(
      "vertical_center",
      (first.top + first.bottom) / 2,
      (reference.top + reference.bottom) / 2,
      expected.vertical_centered_within,
    );
  if (expected.left_aligned_within != null)
    assertDistance("left_aligned", first.left, reference.left, expected.left_aligned_within);
  if (expected.right_aligned_within != null)
    assertDistance("right_aligned", first.right, reference.right, expected.right_aligned_within);
  if (expected.top_aligned_within != null)
    assertDistance("top_aligned", first.top, reference.top, expected.top_aligned_within);
  if (expected.bottom_aligned_within != null)
    assertDistance(
      "bottom_aligned",
      first.bottom,
      reference.bottom,
      expected.bottom_aligned_within,
    );
}

function assertSpread(label, values, tolerance) {
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > Number(tolerance))
    throw new Error(
      `assertion failed at layout.same_${label}: spread ${spread}px exceeds ${tolerance}px`,
    );
}

function assertGap(label, gap, expected) {
  const minimum = Number(expected.min ?? 0);
  const maximum = expected.max == null ? Number.POSITIVE_INFINITY : Number(expected.max);
  if (gap < minimum || gap > maximum)
    throw new Error(
      `assertion failed at layout.${label}: gap ${gap}px is outside [${minimum}, ${maximum}]`,
    );
}

function assertDistance(label, actual, expected, tolerance) {
  const distance = Math.abs(actual - expected);
  if (distance > Number(tolerance))
    throw new Error(
      `assertion failed at layout.${label}: distance ${distance}px exceeds ${tolerance}px`,
    );
}

async function queryLocator(locator, fields = ["count", "text", "visible", "enabled"]) {
  const count = await locator.count();
  const first = locator.first();
  const result = { count };
  if (count) {
    if (fields.includes("text")) result.text = await first.textContent();
    if (fields.includes("html")) result.html = await first.innerHTML();
    if (fields.includes("value")) result.value = await first.inputValue();
    if (fields.includes("visible")) result.visible = await first.isVisible();
    if (fields.includes("enabled")) result.enabled = await first.isEnabled();
    if (fields.includes("checked")) result.checked = await first.isChecked();
    if (fields.includes("attributes"))
      result.attributes = await first.evaluate((element) =>
        Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])),
      );
    if (fields.includes("computed_style"))
      result.computed_style = await first.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return { color: style.color, font_family: style.fontFamily, font_size: style.fontSize };
      });
    if (fields.includes("scroll_top"))
      result.scroll_top = await first.evaluate((element) => element.scrollTop);
    if (fields.includes("scroll_height"))
      result.scroll_height = await first.evaluate((element) => element.scrollHeight);
    if (fields.includes("client_height"))
      result.client_height = await first.evaluate((element) => element.clientHeight);
    if (fields.includes("scrollable_y"))
      result.scrollable_y = await first.evaluate((element) => {
        const overflowY = window.getComputedStyle(element).overflowY;
        return (
          ["auto", "scroll"].includes(overflowY) && element.scrollHeight > element.clientHeight
        );
      });
    if (fields.includes("at_scroll_bottom"))
      result.at_scroll_bottom = await first.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
      );
    if (fields.includes("box"))
      result.box = await first.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      });
    if (fields.includes("square_grid"))
      result.square_grid = await locator.evaluateAll((elements) => {
        const SHRINE_LABEL = "■博麗神社";
        const BORDER_CHARACTER = "■";
        const MAP_ROW_COUNT = 25;
        const SHRINE_EDGE_ROW_COUNT = 10;
        const SHRINE_INTERIOR_START_ROW = 11;
        const SHRINE_INTERIOR_ROW_COUNT = 5;
        const SHRINE_INTERIOR_EDGE = "║";
        const characterBoxes = (element, selectedCharacter) => {
          const boxes = [];
          const ownerDocument = element.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            element,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const character = text[index];
              if (character !== selectedCharacter) continue;
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height) boxes.push(rect.left);
            }
          }
          return boxes;
        };
        const tolerance = 1;
        const rows = elements.map((element) => ({
          element,
          text: element.textContent?.trim() ?? "",
          top: element.getBoundingClientRect().top,
          squares: characterBoxes(element, BORDER_CHARACTER),
        }));
        const labelIndex = rows.findLastIndex((row) => row.text === SHRINE_LABEL);
        let mapEnd = labelIndex - 1;
        while (mapEnd >= 0 && rows[mapEnd].squares.length < 2) mapEnd -= 1;
        const mapStart = mapEnd - MAP_ROW_COUNT + 1;
        if (labelIndex < 0 || mapStart < 0)
          return { aligned: false, reason: "latest shrine map was not found" };
        const map = rows.slice(mapStart, mapEnd + 1);
        const top = map[0];
        const bottom = map.at(-1);
        if (top.squares.length < 8 || bottom.squares.length < 8)
          return { aligned: false, reason: "shrine border rows were incomplete" };
        const left = top.squares[0];
        const right = top.squares.at(-1);
        const alignedBottom =
          Math.abs(bottom.squares[0] - left) <= tolerance &&
          Math.abs(bottom.squares.at(-1) - right) <= tolerance;
        // The shrine's upper outer wall is a ten-row vertical edge. Lower rows
        // intentionally open into paths and adjacent areas, so their last square
        // is not the outer wall and must not be treated as a rectangular edge.
        const borderedRows = map
          .slice(0, SHRINE_EDGE_ROW_COUNT)
          .filter((row) => row.squares.length >= 2);
        const leftEdges = borderedRows.map((row) => row.squares[0]);
        const rightEdges = borderedRows.map((row) => row.squares.at(-1));
        const edgeRows = borderedRows.filter(
          (row) =>
            Math.abs(row.squares[0] - left) <= tolerance &&
            Math.abs(row.squares.at(-1) - right) <= tolerance,
        );
        const interiorRows = map.slice(
          SHRINE_INTERIOR_START_ROW,
          SHRINE_INTERIOR_START_ROW + SHRINE_INTERIOR_ROW_COUNT,
        );
        const interiorEdges = interiorRows.map((row) =>
          characterBoxes(row.element, SHRINE_INTERIOR_EDGE),
        );
        const interiorCounts = interiorEdges.map((edges) => edges.length);
        const completeInterior = interiorCounts.every((count) => count === 1);
        const interiorPositions = completeInterior ? interiorEdges.map((edges) => edges[0]) : [];
        const interiorSpread = completeInterior
          ? Math.max(...interiorPositions) - Math.min(...interiorPositions)
          : null;
        return {
          aligned:
            alignedBottom &&
            edgeRows.length === SHRINE_EDGE_ROW_COUNT &&
            interiorRows.length === SHRINE_INTERIOR_ROW_COUNT &&
            completeInterior &&
            interiorSpread != null &&
            interiorSpread <= tolerance,
          left: Math.round(left * 100) / 100,
          right: Math.round(right * 100) / 100,
          left_spread: Math.round((Math.max(...leftEdges) - Math.min(...leftEdges)) * 100) / 100,
          right_spread: Math.round((Math.max(...rightEdges) - Math.min(...rightEdges)) * 100) / 100,
          top: Math.round(top.top * 100) / 100,
          bottom: Math.round(bottom.top * 100) / 100,
          rows: map.length,
          edge_rows: edgeRows.length,
          interior_left:
            interiorPositions.length > 0 ? Math.round(interiorPositions[0] * 100) / 100 : null,
          interior_spread: interiorSpread == null ? null : Math.round(interiorSpread * 100) / 100,
          interior_rows: interiorRows.length,
          interior_counts: interiorCounts,
        };
      });
    if (fields.includes("dialog_border"))
      result.dialog_border = await first.evaluate((element) => {
        const characterBoxes = (subject) => {
          const boxes = [];
          const ownerDocument = subject.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            subject,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height)
                boxes.push({ character: text[index], left: rect.left });
            }
          }
          return boxes;
        };
        const target = element.closest(".game-line") ?? element;
        const parent = target.parentElement;
        const lines = parent ? [...parent.querySelectorAll(":scope > .game-line")] : [target];
        const index = Math.max(0, lines.indexOf(target));
        const lineText = (line) => line.textContent?.trim() ?? "";
        const isTopBorder = (line) =>
          /^[┌┏╔]/u.test(lineText(line)) && /[┐┓╗]$/u.test(lineText(line));
        const isBottomBorder = (line) =>
          /^[└┗╚]/u.test(lineText(line)) && /[┘┛╝]$/u.test(lineText(line));
        let tableStart = index;
        while (tableStart > 0 && !isTopBorder(lines[tableStart])) {
          tableStart -= 1;
          if (isBottomBorder(lines[tableStart])) break;
        }
        let tableEnd = index;
        while (tableEnd + 1 < lines.length && !isBottomBorder(lines[tableEnd])) {
          tableEnd += 1;
          if (isTopBorder(lines[tableEnd])) break;
        }
        const boundedTable = isTopBorder(lines[tableStart]) && isBottomBorder(lines[tableEnd]);
        const nearby = boundedTable
          ? lines.slice(tableStart, tableEnd + 1)
          : lines.slice(Math.max(0, index - 5), index + 6);
        const borderCharacters = new Set(["│", "┃", "┐", "┘", "┤", "┓", "┛"]);
        const rightEdges = nearby
          .map((line) =>
            characterBoxes(line)
              .filter((box) => borderCharacters.has(box.character))
              .map((box) => box.left)
              .at(-1),
          )
          .filter((value) => value != null);
        const targetEdge = characterBoxes(target)
          .filter((box) => borderCharacters.has(box.character))
          .map((box) => box.left)
          .at(-1);
        if (targetEdge == null || rightEdges.length < 2)
          return { aligned: false, count: rightEdges.length };
        const spread = Math.max(...rightEdges) - Math.min(...rightEdges);
        return {
          aligned: spread <= 1,
          count: rightEdges.length,
          rows: nearby.length,
          right: Math.round(targetEdge * 100) / 100,
          spread: Math.round(spread * 100) / 100,
        };
      });
    if (fields.includes("footer_corner"))
      result.footer_corner = await first.evaluate((element) => {
        const characterBoxes = (subject) => {
          const boxes = [];
          const ownerDocument = subject.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            subject,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height)
                boxes.push({ character: text[index], left: rect.left });
            }
          }
          return boxes;
        };
        const target = element.closest(".game-line") ?? element;
        const elementRight = element.getBoundingClientRect().right;
        const corner = characterBoxes(target)
          .filter((box) => ["┘", "┛", "╝"].includes(box.character) && box.left >= elementRight - 1)
          .sort((left, right) => left.left - right.left)[0];
        const parent = target.parentElement;
        const lines = parent ? [...parent.querySelectorAll(":scope > .game-line")] : [target];
        const targetIndex = Math.max(0, lines.indexOf(target));
        const edgeCharacters = new Set(["│", "┃", "║", "┐", "┓", "╗", "┤", "┫", "╣"]);
        const edges = lines.slice(Math.max(0, targetIndex - 24), targetIndex).flatMap((line) =>
          characterBoxes(line)
            .filter((box) => edgeCharacters.has(box.character))
            .map((box) => box.left),
        );
        if (!corner || edges.length === 0) return { aligned: false, count: edges.length };
        const edge = edges.reduce((closest, value) =>
          Math.abs(value - corner.left) < Math.abs(closest - corner.left) ? value : closest,
        );
        const offset = corner.left - edge;
        return {
          aligned: Math.abs(offset) <= 1,
          corner: Math.round(corner.left * 100) / 100,
          edge: Math.round(edge * 100) / 100,
          offset: Math.round(offset * 100) / 100,
        };
      });
    if (fields.includes("content_signature"))
      result.content_signature = await locator.evaluateAll((elements) => {
        const content = elements.map((element) => element.outerHTML).join("\u0000");
        let hash = 0x811c9dc5;
        for (let index = 0; index < content.length; index += 1) {
          hash ^= content.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        return `${content.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
      });
    if (fields.includes("image_loaded"))
      result.image_loaded = await first.evaluate((element) => {
        const image = element instanceof HTMLImageElement ? element : element.querySelector("img");
        return Boolean(
          image?.complete && Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0,
        );
      });
  }
  return result;
}

function assertSubset(actual, expected, prefix = "") {
  for (const [key, value] of Object.entries(expected)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value))
      assertSubset(actual?.[key], value, label);
    else if (JSON.stringify(actual?.[key]) !== JSON.stringify(value))
      throw new Error(
        `assertion failed at ${label}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`,
      );
  }
}

function assertStringPrefixes(actual, expected, prefix = "") {
  for (const [key, value] of Object.entries(expected)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertStringPrefixes(actual?.[key], value, label);
    } else if (typeof actual?.[key] !== "string" || !actual[key].startsWith(String(value))) {
      throw new Error(
        `assertion failed at ${label}: expected prefix ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`,
      );
    }
  }
}

export function shellWords(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  return (
    String(value)
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  );
}
