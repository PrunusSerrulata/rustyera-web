/* global window */

import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

export const REFERENCE_SCHEMA_VERSION = 2;
const WAIT_KIND = {
  enter_key: "EnterKey",
  any_key: "AnyKey",
  integer: "IntValue",
  integer_value: "IntValue",
  string: "StrValue",
  string_value: "StrValue",
  void: "Void",
  any_value: "AnyValue",
  integer_button: "IntButton",
  string_button: "StrButton",
  primitive_mouse_key: "PrimitiveMouseKey",
};

export async function loadScenario(file, projectOverride, stateOverride) {
  const scenarioPath = path.resolve(file);
  const raw = JSON.parse(await readFile(scenarioPath, "utf8"));
  if (raw.schema_version !== 1)
    throw new Error(`unsupported scenario schema ${raw.schema_version}`);
  if (!["fixed", "autonomous"].includes(raw.mode ?? "fixed"))
    throw new Error("scenario mode must be fixed or autonomous");
  if (raw.inputs && raw.actions) throw new Error("scenario cannot contain both inputs and actions");
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
        : Number(configuredSeed);
  if (seed != null && (!Number.isInteger(seed) || seed < 0 || seed > 0x7fff_ffff))
    throw new Error("seed must be a non-negative 32-bit integer");
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
    start: {
      ...start,
      path: stateOverride
        ? path.resolve(stateOverride)
        : start.path
          ? resolveFromScenario(start.path)
          : undefined,
    },
    seed,
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
  }

  emit(event) {
    this.stream.write(`${JSON.stringify(event)}\n`);
    const compact = structuredClone(event);
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
    await new Promise((resolve) => this.stream.end(resolve));
  }
}

export async function isolatedProject(source) {
  const root = await mkdtemp(path.join(tmpdir(), "rustyera-web-test-"));
  const destination = path.join(root, "project");
  await cp(source, destination, {
    recursive: true,
    filter: (candidate) => path.basename(candidate) !== ".rustyera",
  });
  return { root, project: destination, close: () => rm(root, { recursive: true, force: true }) };
}

export async function installRemoteFileSystem(page, root) {
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
    if (request.op === "read") return [...(await readFile(target))];
    if (request.op === "stat") {
      const stat = await lstat(target);
      return { size: stat.size, lastModified: stat.mtimeMs };
    }
    if (request.op === "mkdir") return mkdir(target, { recursive: true }).then(() => true);
    if (request.op === "write") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(request.data));
      return true;
    }
    if (request.op === "delete")
      return rm(target, { force: true, recursive: true }).then(() => true);
    throw new Error(`unknown filesystem operation ${request.op}`);
  });
  await page.addInitScript(() => {
    class RemoteFileHandle {
      kind = "file";
      constructor(name, relativePath) {
        this.name = name;
        this.relativePath = relativePath;
      }
      async getFile() {
        const [data, stat] = await Promise.all([
          window.__rustyeraFs({ op: "read", path: this.relativePath }),
          window.__rustyeraFs({ op: "stat", path: this.relativePath }),
        ]);
        return new File([new Uint8Array(data)], this.name, { lastModified: stat.lastModified });
      }
      async createWritable() {
        let data = new Uint8Array();
        return {
          write: async (value) => {
            data = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
          },
          close: () =>
            window.__rustyeraFs({ op: "write", path: this.relativePath, data: [...data] }),
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
        for (const entry of await window.__rustyeraFs({ op: "entries", path: this.relativePath }))
          yield [
            entry.name,
            entry.kind === "directory"
              ? new RemoteDirectoryHandle(entry.name, this.child(entry.name))
              : new RemoteFileHandle(entry.name, this.child(entry.name)),
          ];
      }
      async getDirectoryHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await window.__rustyeraFs({ op: "mkdir", path: relative });
        return new RemoteDirectoryHandle(name, relative);
      }
      async getFileHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await window.__rustyeraFs({ op: "write", path: relative, data: [] });
        return new RemoteFileHandle(name, relative);
      }
      removeEntry(name) {
        return window.__rustyeraFs({ op: "delete", path: this.child(name) });
      }
      queryPermission = async () => "granted";
      requestPermission = async () => "granted";
    }
    window.showDirectoryPicker = async () => new RemoteDirectoryHandle("project");
    window.queryLocalFonts = async () => [];
  });
}

export function resolveLocator(page, locator = {}) {
  if (locator.role)
    return page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
  if (locator.label) return page.getByLabel(locator.label, { exact: locator.exact });
  if (locator.text) return page.getByText(locator.text, { exact: locator.exact });
  if (locator.test_id) return page.getByTestId(locator.test_id);
  if (locator.css) return page.locator(locator.css);
  throw new Error("locator requires role, label, text, test_id, or css");
}

export async function runAction(page, action) {
  if (action.type === "input") {
    const input = page.locator(".prompt-bar input");
    await input.fill(String(action.value ?? ""));
    await page.locator(".prompt-bar button[type=submit]").click();
    return { semanticInput: String(action.value ?? "") };
  }
  const locator = action.locator ? resolveLocator(page, action.locator) : undefined;
  if (action.type === "click") await locator.click();
  else if (action.type === "fill") await locator.fill(String(action.value ?? ""));
  else if (action.type === "press") await locator.press(String(action.key));
  else if (["query", "assert_dom"].includes(action.type)) {
    const actual = await queryLocator(locator, action.fields);
    if (action.type === "assert_dom") assertSubset(actual, action.expect ?? {});
    return { query: actual, semanticInput: action.semantic_input };
  } else if (action.type === "assert_state") {
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    assertSubset(state, action.expect ?? {});
    return { state };
  } else throw new Error(`unknown action type ${action.type}`);
  return { semanticInput: action.semantic_input };
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
    if (fields.includes("attributes"))
      result.attributes = await first.evaluate((element) =>
        Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])),
      );
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

export function observationFromSnapshot(snapshot, previous = []) {
  const output = snapshot.output ?? [];
  let common = 0;
  while (common < previous.length && common < output.length && previous[common] === output[common])
    common += 1;
  return {
    termination: snapshot.fault
      ? "faulted"
      : snapshot.phase === "waiting_input"
        ? "waitingInput"
        : snapshot.phase,
    phase: snapshot.phase,
    wait: snapshot.wait,
    output,
    output_delta: {
      reset: common === 0 && previous.length > 0,
      removed: previous.length - common,
      added: output.slice(common),
    },
    output_tail: output.slice(-30),
    statuses: [snapshot.status],
    fault: snapshot.fault,
    frontend: snapshot,
  };
}

export function goalStatus(observation, goal) {
  const checks = {};
  const output = observation.output.join("\n");
  for (const value of goal.output_contains ?? [])
    checks[`output_contains:${value}`] = output.includes(String(value));
  if (goal.wait_kind != null) checks.wait_kind = observation.wait?.kind === goal.wait_kind;
  if (goal.termination != null) checks.termination = observation.termination === goal.termination;
  for (const value of goal.status_contains ?? [])
    checks[`status_contains:${value}`] = observation.statuses.some((item) =>
      item.includes(String(value)),
    );
  for (const [name, value] of Object.entries(goal.watch_equals ?? {}))
    checks[`watch_equals:${name}`] = observation.watches?.[name] === value;
  if (goal.line_count_lte != null)
    checks.line_count_lte = observation.output.length <= goal.line_count_lte;
  return {
    satisfied: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean),
    checks,
  };
}

export class ReferenceProcess {
  constructor(command, pathCommand, timeoutMs = 30_000) {
    this.pathCommand = pathCommand;
    this.timeoutMs = timeoutMs;
    this.child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.nextId = 1;
    this.previous = [];
  }
  convertPath(value) {
    if (!this.pathCommand?.length) return value;
    const result = spawnSync(this.pathCommand[0], [...this.pathCommand.slice(1), value], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`reference path conversion failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  async request(op, fields = {}) {
    const request = { id: this.nextId++, op, ...fields };
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    const response = await Promise.race([
      this.iterator.next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reference process timed out")), this.timeoutMs),
      ),
    ]);
    if (response.done) throw new Error("reference process exited without a response");
    const value = JSON.parse(response.value);
    if (!value.ok) throw new Error(`reference request failed: ${value.error}`);
    if (value.schemaVersion !== REFERENCE_SCHEMA_VERSION || value.id !== request.id)
      throw new Error("reference schema or response id mismatch");
    this.referenceCommit = value.referenceCommit;
    return value.result;
  }
  async start(scenario) {
    const capabilities = await this.request("capabilities");
    const required =
      scenario.start.type === "traditional_save" ? ["load", "loadSave", "run"] : ["load", "run"];
    for (const operation of required)
      if (!capabilities.operations.includes(operation))
        throw new Error(`reference CLI missing ${operation}`);
    let result = await this.request("load", {
      gameDir: this.convertPath(scenario.project),
      seed: scenario.seed,
      watch: scenario.watches,
    });
    if (scenario.start.type === "traditional_save")
      result = await this.request("loadSave", {
        savePath: this.convertPath(scenario.start.path),
        watch: scenario.watches,
      });
    return this.observe(result);
  }
  async step(input, watches) {
    return this.observe(await this.request("run", { inputs: [input], watch: watches }));
  }
  observe(result) {
    const output = (result.output ?? []).map(String);
    const observation = observationFromSnapshot(
      {
        output,
        wait: {
          kind: result.inputRequest?.InputType,
          system_input: result.inputRequest?.IsSystemInput,
        },
        phase: result.termination,
      },
      this.previous,
    );
    this.previous = output;
    return {
      ...observation,
      termination: result.termination,
      watches: result.watches ?? {},
      random_seed: result.randomSeed,
      random_algorithm: result.randomAlgorithm,
      reference_commit: this.referenceCommit,
    };
  }
  close() {
    this.lines.close();
    this.child.kill();
  }
}

export function compareObservations(rust, reference, comparison = {}) {
  const ignored = (comparison.ignore_output ?? []).map((value) => new RegExp(value));
  const normalize = (values) =>
    values
      .map((value) => String(value).replaceAll("\r", "").trimEnd())
      .filter((value) => !ignored.some((pattern) => pattern.test(value)));
  const differences = {};
  const left = normalize(rust.output_delta.added),
    right = normalize(reference.output_delta.added);
  if (JSON.stringify(left) !== JSON.stringify(right))
    differences.output_delta = { rust: left, reference: right };
  const expected = { ...WAIT_KIND, ...(comparison.wait_kind_map ?? {}) }[rust.wait?.kind];
  if (expected && expected !== reference.wait?.kind)
    differences.wait_kind = { rust: rust.wait?.kind, reference: reference.wait?.kind };
  if (JSON.stringify(rust.watches ?? {}) !== JSON.stringify(reference.watches ?? {}))
    differences.watches = { rust: rust.watches ?? {}, reference: reference.watches ?? {} };
  return { equal: Object.keys(differences).length === 0, differences };
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
