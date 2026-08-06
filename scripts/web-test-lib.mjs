/* global window, HTMLImageElement */

import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export {
  goalStatus,
  observationFromSnapshot,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  terminalRuntimeRejection,
} from "./web-test-runtime.mjs";
export {
  compareObservations,
  REFERENCE_SCHEMA_VERSION,
  ReferenceProcess,
} from "./web-test-reference.mjs";

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
  const viewport = raw.viewport ?? { width: 1280, height: 800 };
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < 320 ||
    viewport.height < 240
  )
    throw new Error("scenario viewport must contain integer width/height of at least 320x240");
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
    viewport,
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

export async function isolatedProject(source, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rustyera-web-test-"));
  const destination = path.join(root, "project");
  await cp(source, destination, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      if (options.cleanSaves && relative.split(path.sep)[0]?.toLocaleLowerCase() === "sav")
        return false;
      if (!relative.split(path.sep).includes(".rustyera")) return true;
      if (!options.compiledCache) return false;
      return [
        ".rustyera",
        path.join(".rustyera", "cache"),
        path.join(".rustyera", "cache", "compiled-project.reraproj"),
      ].includes(relative);
    },
  });
  return { root, project: destination, close: () => rm(root, { recursive: true, force: true }) };
}

export function injectInGameSaveFlow(source) {
  const marker = "PRINTL ORACLE_READY\n";
  if (!source.includes(marker)) throw new Error("save-flow fixture lacks ORACLE_READY marker");
  if (source.includes("@SAVEINFO")) throw new Error("save-flow fixture already defines SAVEINFO");
  return `${source.replace(marker, `${marker}SAVEGAME\n`)}\n@SAVEINFO\nSAVEDATA_TEXT = "browser game save"\nRETURN\n`;
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
        return new File([await response.blob()], this.name, { lastModified: stat.lastModified });
      }
      async createWritable() {
        let data = new Uint8Array();
        return {
          write: async (value) => {
            data = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
          },
          close: () => callFileSystem({ op: "write", path: this.relativePath, data: [...data] }),
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

export async function runAction(page, action) {
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
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000));
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
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000));
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
      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
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
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000));
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
        const current = window.__RUSTYERA_TEST__.snapshot();
        return current.fault != null || current.wait?.wait_id !== previousWaitId;
      }, waitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000));
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
  if (action.type === "input") {
    const beforeWaitId = await page.evaluate(
      () => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id,
    );
    const input = page.locator(".prompt-bar input");
    await input.fill(String(action.value ?? ""));
    await page.locator(".prompt-bar button[type=submit]").click();
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshot();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
    if (action.message_skip) {
      await page.waitForFunction(() => {
        const snapshot = window.__RUSTYERA_TEST__.snapshot();
        return snapshot.canInteract && snapshot.wait?.kind === "enter_key";
      });
      await page.locator(".game-viewport").click({ button: "right" });
    }
    return { semanticInput: String(action.value ?? "") };
  }
  if (action.type === "sample_queries") return sampleQueries(page, action);
  const locator = action.locator ? resolveLocator(page, action.locator) : undefined;
  if (action.type === "click") {
    const runtimeInput = await locator.evaluate((element) =>
      Boolean(
        element.closest(".game-viewport") &&
        (element.matches("button") || element.closest("button")),
      ),
    );
    const beforeWaitId = runtimeInput
      ? await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id)
      : undefined;
    await locator.click();
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshot();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
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
    return { query: { media_replay: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "assert_state") {
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    assertSubset(state, action.expect ?? {});
    return { state };
  } else throw new Error(`unknown action type ${action.type}`);
  return { semanticInput: action.semantic_input };
}

async function waitForAutomaticWaitChange(page, waitId) {
  await page.waitForFunction((previousWaitId) => {
    const current = window.__RUSTYERA_TEST__.snapshot();
    return current.fault != null || current.wait?.wait_id !== previousWaitId;
  }, waitId);
  await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000));
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
    if (fields.includes("attributes"))
      result.attributes = await first.evaluate((element) =>
        Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])),
      );
    if (fields.includes("scroll_top"))
      result.scroll_top = await first.evaluate((element) => element.scrollTop);
    if (fields.includes("scroll_height"))
      result.scroll_height = await first.evaluate((element) => element.scrollHeight);
    if (fields.includes("client_height"))
      result.client_height = await first.evaluate((element) => element.clientHeight);
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

export function shellWords(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  return (
    String(value)
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  );
}
