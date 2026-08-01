/* global window, HTMLImageElement */

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

export function terminalRuntimeRejection(snapshot) {
  return snapshot?.logs?.find((entry) =>
    /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
  );
}

export function runtimeProgressSignature(snapshot) {
  return JSON.stringify({
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait
      ? {
          kind: snapshot.wait.kind,
          wait_id: snapshot.wait.wait_id,
          generation: snapshot.wait.generation,
        }
      : null,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-2),
    lastLog: snapshot?.logs?.at(-1),
  });
}

export function runtimeProgressDiagnostic(snapshot) {
  return {
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-12),
    fault: snapshot?.fault,
    logTail: snapshot?.logs?.slice(-8),
  };
}

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
        path.join(".rustyera", "cache", "compiled-project-v8.bin.zst"),
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
    window.queryLocalFonts = async () => [];
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
    const actual = await queryLayout(locator, relative);
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

async function queryLayout(locator, relative) {
  const subject = await layoutBoxes(locator);
  const reference = relative ? await layoutBoxes(relative) : undefined;
  return {
    count: subject.length,
    visible: subject.some((item) => item.width > 0 && item.height > 0),
    boxes: subject,
    reference_count: reference?.length,
    reference_boxes: reference,
  };
}

async function layoutBoxes(locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    }),
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
        `assertion failed at layout.inside: subject exceeds relative_to by more than ${tolerance}px`,
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
