/* global document */

import { createWriteStream } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
