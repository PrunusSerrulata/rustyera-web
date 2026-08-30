import type {
  DisplayLine,
  InteractionToken,
  PresentationSettings,
  TooltipSettings,
} from "@/core/types";
import {
  escapeHtml,
  htmlColor,
  isDefaultForeground,
  projectedLength,
  rawLength,
} from "./presentation/htmlFormat";
import { applySceneDelta, emptyScene, validateScene, type SceneStateV1 } from "@/core/scene";
import { decodeFixedColorMatrix } from "@/core/colorMatrix";
import { sameServiceInteger, serviceInteger } from "@/core/runtimeServiceProtocol";

export interface PresentationState {
  revision: number;
  historyRevision: number;
  title: string;
  lines: DisplayLine[];
  scene: SceneStateV1;
  audio: any[];
  inputWait: any | null;
  settings: Partial<PresentationSettings>;
  tooltip: TooltipSettings;
  resources: any;
  htmlIsland: any[];
  redraw: any;
  buttonGeneration: number | null;
  nextInteractionSequence: number;
  retiredInteractionSequence: number;
}

export type PresentationInteractionSource =
  | { kind: "run"; run: any }
  | { kind: "html"; node: any; effectiveForeground?: unknown }
  | { kind: "scene"; layer: any };

export interface PresentationInteractionLocation {
  rowKey: string;
  interaction: any;
  source: PresentationInteractionSource;
}

export function emptyPresentation(): PresentationState {
  return {
    revision: 0,
    historyRevision: 0,
    title: "RustyEra",
    lines: [],
    scene: emptyScene(),
    audio: [],
    inputWait: null,
    settings: {},
    tooltip: defaultTooltipSettings(),
    resources: { sprites: [], canvases: [], animation_timer_ms: 0 },
    htmlIsland: [],
    redraw: { enabled: true },
    buttonGeneration: null,
    nextInteractionSequence: 1,
    retiredInteractionSequence: 0,
  };
}

export function applySnapshot(state: PresentationState, snapshot: any): void {
  const candidate = clonePresentation(state);
  applySnapshotCandidate(candidate, cloneProtocol(snapshot));
  validatePresentationCandidate(candidate);
  Object.assign(state, candidate);
}

function applySnapshotCandidate(state: PresentationState, snapshot: any): void {
  const previousSequences = collectInteractionSequences(state.lines, state.htmlIsland, state.scene);
  const nextLines = [...(snapshot.history?.logical_lines ?? [])] as DisplayLine[];
  // A resynchronization snapshot can carry an equal-length dynamic-map tail with new line IDs.
  // Emuera replaces that tail in place, so only actual history growth should request bottom follow.
  if (nextLines.length > state.lines.length) state.historyRevision += 1;
  state.revision = exactFrontendRevision(snapshot.revision, "presentation revision");
  state.title = snapshot.title;
  state.lines = nextLines;
  const sourceScene = (snapshot.scene ?? emptyScene()) as SceneStateV1;
  const scene = { revision: sourceScene.revision, layers: [...sourceScene.layers] };
  validateScene(scene);
  state.scene = scene;
  state.audio = snapshot.audio ?? [];
  state.inputWait = snapshot.input_wait ?? null;
  state.settings = snapshot.settings ?? {};
  state.tooltip = snapshot.tooltip ?? defaultTooltipSettings();
  state.resources = snapshot.resources ?? { sprites: [], canvases: [], animation_timer_ms: 0 };
  state.htmlIsland = snapshot.html_island ?? [];
  state.redraw = snapshot.redraw ?? { enabled: true };
  // The snapshot owns each button's enabled state but does not expose the
  // current BREAKBUTTON generation. Do not filter later partial updates with
  // generation knowledge from before this authoritative resynchronization.
  state.buttonGeneration = null;
  assignPresentationSequences(state, previousSequences);
}

export function defaultTooltipSettings(): TooltipSettings {
  return {
    foreground: { red: 0, green: 0, blue: 0, alpha: 255 },
    background: { red: 255, green: 255, blue: 225, alpha: 255 },
    delay_ms: 500,
    duration_ms: 5_000,
    font_millipoints: 9_000,
    custom: false,
    format: 0,
    images: false,
    normalized_format: { flags: [], unknown_bits: 0 },
  };
}

export function applyDelta(state: PresentationState, delta: any): void {
  const candidate = clonePresentation(state);
  const clonedDelta = cloneProtocol(delta);
  applyDeltaCandidate(candidate, clonedDelta);
  validatePresentationCandidate(candidate);
  preserveDeltaLineContainer(state, candidate, clonedDelta.operations);
  Object.assign(state, candidate);
}

function preserveDeltaLineContainer(
  state: PresentationState,
  candidate: PresentationState,
  operations: any[],
): void {
  const replacesContainer = operations.some(
    (operation) =>
      operation.type === "clear" ||
      (operation.type === "trim_lines" && Number(operation.count) > 0),
  );
  if (replacesContainer) return;
  const mutatesLines = operations.some((operation) =>
    ["append_line", "delete_lines", "replace_line"].includes(operation.type),
  );
  if (mutatesLines) {
    state.lines.length = candidate.lines.length;
    for (let index = 0; index < candidate.lines.length; index += 1)
      state.lines[index] = candidate.lines[index];
  }
  candidate.lines = state.lines;
}

function applyDeltaCandidate(state: PresentationState, delta: any): void {
  const baseRevision = serviceInteger(delta.base_revision, "presentation delta base revision");
  const newRevision = serviceInteger(delta.new_revision, "presentation delta revision");
  if (!sameServiceInteger(baseRevision, state.revision)) {
    throw new Error(`展示 revision 不连续：${state.revision} → ${delta.base_revision}`);
  }
  if (BigInt(newRevision) <= BigInt(baseRevision))
    throw new Error("presentation revision is not monotonic");
  if (newRevision > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("presentation revision exceeds the frontend exact range");
  if (!Array.isArray(delta.operations))
    throw new Error("presentation delta operations are invalid");
  const previousLineCount = state.lines.length;
  let previousSceneSequences = collectSceneSequences(state.scene);
  let existingLineChanged = false;
  let pendingPrefixTrim = 0;
  const flushPrefixTrim = () => {
    if (pendingPrefixTrim === 0) return;
    // Replacing the container avoids thousands of reactive index writes from Array.splice when
    // MaxLog trims the oldest line after every append. Immutable line payloads remain shared.
    state.lines = state.lines.slice(pendingPrefixTrim);
    pendingPrefixTrim = 0;
  };
  for (const operation of delta.operations ?? []) {
    switch (operation.type) {
      case "append_line":
        assignLineSequences(state, operation.line);
        state.lines.push(operation.line);
        break;
      case "delete_lines":
        flushPrefixTrim();
        serviceInteger(operation.count, "deleted presentation line count");
        state.lines.splice(
          Math.max(0, state.lines.length - Number(operation.count)),
          Number(operation.count),
        );
        break;
      case "clear":
        state.lines = [];
        pendingPrefixTrim = 0;
        break;
      case "set_title":
        state.title = operation.title;
        break;
      case "apply_scene_delta":
        state.scene = applySceneDelta(state.scene, operation.delta);
        assignSceneSequences(state, state.scene, previousSceneSequences);
        previousSceneSequences = collectSceneSequences(state.scene);
        break;
      case "set_audio":
        state.audio = operation.audio;
        break;
      case "set_input_wait":
        state.inputWait = operation.input_wait ?? null;
        break;
      case "replace_line": {
        flushPrefixTrim();
        const index = findLineIndexFromEnd(state.lines, operation.line_id);
        if (index >= 0) {
          const previousSequences = collectLineSequences(state.lines[index]);
          assignLineSequences(state, operation.line, previousSequences);
          existingLineChanged ||= lineContentChanged(state.lines[index], operation.line);
          state.lines[index] = operation.line;
        }
        break;
      }
      case "set_settings":
        state.settings = operation.settings;
        break;
      case "set_tooltip":
        state.tooltip = operation.tooltip;
        break;
      case "set_resources":
        state.resources = operation.resources;
        break;
      case "set_html_island": {
        const previousSequences = collectHtmlIslandSequences(state.htmlIsland);
        state.htmlIsland = operation.html_island;
        assignHtmlIslandSequences(state, state.htmlIsland, previousSequences);
        break;
      }
      case "set_redraw":
        state.redraw = operation.redraw;
        break;
      case "set_button_generation":
        state.buttonGeneration = operation.generation;
        break;
      case "trim_lines":
        serviceInteger(operation.count, "trimmed presentation line count");
        pendingPrefixTrim += Math.min(
          Math.max(0, Number(operation.count)),
          state.lines.length - pendingPrefixTrim,
        );
        break;
      default:
        throw new Error(`unknown presentation operation: ${String(operation.type)}`);
    }
  }
  flushPrefixTrim();
  // Emuera's dynamic-map loop deletes and recreates the same tail rows. Its console keeps the
  // scrollbar unchanged when the final line count is unchanged, so only actual history growth
  // (or an in-place line whose dimensions may change) should request another bottom follow.
  if (state.lines.length > previousLineCount || existingLineChanged) state.historyRevision += 1;
  state.revision = Number(newRevision);
}

function clonePresentation(state: PresentationState): PresentationState {
  return {
    ...state,
    lines: [...state.lines],
    scene: { revision: state.scene.revision, layers: [...state.scene.layers] },
    audio: [...state.audio],
    settings: { ...state.settings },
    tooltip: { ...state.tooltip },
    htmlIsland: [...state.htmlIsland],
  };
}

function cloneProtocol<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneProtocol) as T;
  if (value && typeof value === "object") {
    const rawMarker = Object.getOwnPropertyDescriptor(value, "__v_skip");
    // RuntimePresentationProjection marks immutable payload roots raw before staging. Preserve
    // those identities while cloning only the mutable envelope used for atomic validation.
    if (rawMarker?.value === true && rawMarker.enumerable === false) return value;
    const clone: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(value as object))
      clone[key] = cloneProtocol((value as Record<PropertyKey, unknown>)[key]);
    return clone as T;
  }
  return value;
}

function validatePresentationCandidate(state: PresentationState): void {
  serviceInteger(state.revision, "presentation revision");
  validateScene(state.scene);
  visitPresentationInteractions(state, ({ interaction }) => validateInteraction(interaction));
  for (const line of state.lines) validateColorMatricesInRuns(line.runs);
  for (const document of state.htmlIsland) validateColorMatricesInNodes(document?.nodes ?? []);
}

function validateInteraction(interaction: any): void {
  const token = interaction?.token ?? interaction;
  serviceInteger(token?.epoch, "interaction epoch");
  serviceInteger(token?.id, "interaction identity");
  const value = interaction?.value;
  // HTML buttons submit an opaque interaction token and keep their display value in semantic
  // markup. Scene interactions validate their mandatory typed value in validateScene().
  if (value == null) return;
  if (typeof value !== "object") throw new Error("interaction value is invalid");
  if (value.type === "integer") serviceInteger(value.value, "interaction integer", true);
  else if (value.type === "string") {
    if (typeof value.value !== "string") throw new Error("interaction string is invalid");
  } else if (value.type === "boolean") {
    if (typeof value.value !== "boolean") throw new Error("interaction boolean is invalid");
  } else if (value.type === "bytes") {
    if (!Array.isArray(value.value)) throw new Error("interaction bytes are invalid");
    for (const byte of value.value) {
      const integer = serviceInteger(byte, "interaction byte");
      if (BigInt(integer) > 255n) throw new Error("interaction byte exceeds u8");
    }
  } else throw new Error("interaction value type is invalid");
}

function validateColorMatricesInRuns(runs: any[]): void {
  for (const run of runs) {
    if (run.type === "image") decodeFixedColorMatrix(run.placement?.color_matrix);
    if (run.type === "button") validateColorMatricesInRuns(run.runs ?? []);
    if (run.type === "column_cell") validateColorMatricesInRuns(run.content ?? []);
    if (run.type === "html_document") validateColorMatricesInNodes(run.document?.nodes ?? []);
  }
}

function validateColorMatricesInNodes(nodes: any[]): void {
  for (const node of nodes) {
    if (node.semantic?.type === "image") decodeFixedColorMatrix(node.semantic.color_matrix);
    validateColorMatricesInNodes(node.children ?? []);
  }
}

function findLineIndexFromEnd(lines: DisplayLine[], lineId: number | bigint): number {
  for (let index = lines.length - 1; index >= 0; index -= 1)
    if (sameServiceInteger(lines[index]?.line_id, lineId)) return index;
  return -1;
}

function exactFrontendRevision(value: unknown, name: string): number {
  const revision = serviceInteger(value, name);
  if (BigInt(revision) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${name} exceeds the frontend exact range`);
  return Number(revision);
}

function lineContentChanged(
  left: DisplayLine | undefined,
  right: DisplayLine | undefined,
): boolean {
  if (!left || !right) return left !== right;
  return (
    left.runs.length !== right.runs.length ||
    left.runs.some(
      (run, index) => runContentIdentity(run) !== runContentIdentity(right.runs[index]),
    )
  );
}

function runContentIdentity(run: any): string {
  switch (run?.type) {
    case "text":
    case "text_layout":
      return `text:${run.text}:${run.columns ?? "canonical"}`;
    case "button":
      return `button:${(run.runs ?? []).map(runContentIdentity).join("|")}`;
    case "image":
      return `image:${run.placement?.resource_id}:${run.placement?.revision}:${run.alt_text ?? ""}`;
    case "column_cell":
      return `column:${(run.content ?? []).map(runContentIdentity).join("|")}`;
    case "html_document":
      return `html:${stableContent(run.document)}`;
    case "shape":
      return `shape:${stableContent(run.shape)}`;
    default:
      return `${run?.type ?? "unknown"}:${plainRun(run)}`;
  }
}

function stableContent(value: any): string {
  return (
    JSON.stringify(value, (_key, child) =>
      typeof child === "bigint" ? child.toString() : child,
    ) ?? ""
  );
}

function visitRuns(
  runs: any[],
  rowKey: string,
  visitInteraction: (location: PresentationInteractionLocation) => void,
): void {
  for (const run of runs) {
    if (run.type === "button") {
      visitInteraction({ rowKey, interaction: run, source: { kind: "run", run } });
      visitRuns(run.runs ?? [], rowKey, visitInteraction);
    } else if (run.type === "column_cell") {
      visitRuns(run.content ?? [], rowKey, visitInteraction);
    } else if (run.type === "html_document") {
      visitHtmlNodes(run.document?.nodes ?? [], rowKey, visitInteraction);
    }
  }
}

function visitHtmlNodes(
  nodes: any[],
  rowKey: string,
  visitInteraction: (location: PresentationInteractionLocation) => void,
  inheritedForeground?: unknown,
): void {
  for (const node of nodes) {
    const foreground =
      node.semantic?.type === "font" && node.semantic.color != null
        ? node.semantic.color
        : inheritedForeground;
    if (node.interaction)
      visitInteraction({
        rowKey,
        interaction: node.interaction,
        source: { kind: "html", node, effectiveForeground: foreground },
      });
    visitHtmlNodes(node.children ?? [], rowKey, visitInteraction, foreground);
  }
}

export function visitPresentationInteractions(
  state: PresentationState,
  visitInteraction: (location: PresentationInteractionLocation) => void,
): void {
  for (const line of state.lines)
    visitRuns(line.runs, `line:${String(line.line_id)}`, visitInteraction);
  for (const [index, document] of state.htmlIsland.entries())
    visitHtmlNodes(document?.nodes ?? [], `island:${index}`, visitInteraction);
  visitScene(state.scene, visitInteraction);
}

export function retirePresentedButtons(state: PresentationState): number {
  const previous = state.retiredInteractionSequence;
  state.retiredInteractionSequence = state.nextInteractionSequence - 1;
  return previous;
}

export function restoreButtonBoundary(state: PresentationState, boundary: number): void {
  state.retiredInteractionSequence = boundary;
}

export function restoreSubmittedButtonBoundary(
  state: PresentationState,
  boundary: number,
): boolean {
  // A later interaction sequence is the runtime's replacement surface. Keep the submitted
  // surface retired in that case; only a new wait over the unchanged surface can re-arm it.
  if (state.retiredInteractionSequence !== state.nextInteractionSequence - 1) return false;
  restoreButtonBoundary(state, boundary);
  return true;
}

export function presentationInteractionEnabled(
  state: PresentationState,
  interaction: any,
): boolean {
  if (interaction?.enabled !== true) return false;
  if (
    state.buttonGeneration != null &&
    "generation" in interaction &&
    interaction.generation !== state.buttonGeneration
  )
    return false;
  const sequence = interaction[INTERACTION_SEQUENCE];
  return sequence == null || sequence > state.retiredInteractionSequence;
}

export function hasEnabledButton(state: PresentationState, token: InteractionToken): boolean {
  const interaction = findPresentationInteraction(state, token);
  return interaction != null && presentationInteractionEnabled(state, interaction);
}

const INTERACTION_SEQUENCE = Symbol("runtime-interaction-sequence");

function interactionIdentity(interaction: any): string {
  const token = interaction.token ?? interaction;
  return `${String(token.epoch)}:${String(token.id)}`;
}

function collectInteractionSequences(
  lines: DisplayLine[],
  htmlIsland: any[],
  scene: SceneStateV1,
): Map<string, number> {
  const sequences = new Map<string, number>();
  for (const line of lines) collectLineSequences(line, sequences);
  collectHtmlIslandSequences(htmlIsland, sequences);
  collectSceneSequences(scene, sequences);
  return sequences;
}

function collectLineSequences(
  line: DisplayLine,
  sequences = new Map<string, number>(),
): Map<string, number> {
  visitRuns(line.runs, `line:${String(line.line_id)}`, ({ interaction }) => {
    const sequence = interaction[INTERACTION_SEQUENCE];
    if (sequence != null) sequences.set(interactionIdentity(interaction), sequence);
  });
  return sequences;
}

function collectHtmlIslandSequences(
  documents: any[],
  sequences = new Map<string, number>(),
): Map<string, number> {
  for (const [index, document] of documents.entries())
    visitHtmlNodes(document?.nodes ?? [], `island:${index}`, ({ interaction }) => {
      const sequence = interaction[INTERACTION_SEQUENCE];
      if (sequence != null) sequences.set(interactionIdentity(interaction), sequence);
    });
  return sequences;
}

function visitScene(
  scene: SceneStateV1 | undefined,
  visitInteraction: (location: PresentationInteractionLocation) => void,
): void {
  for (const layer of scene?.layers ?? []) {
    if (!layer.interaction) continue;
    visitInteraction({
      rowKey: `scene:${String(layer.layer_id)}`,
      interaction: layer.interaction,
      source: { kind: "scene", layer },
    });
  }
}

function collectSceneSequences(
  scene: SceneStateV1,
  sequences = new Map<string, number>(),
): Map<string, number> {
  visitScene(scene, ({ interaction }) => {
    const sequence = interaction[INTERACTION_SEQUENCE];
    if (sequence != null) sequences.set(interactionIdentity(interaction), sequence);
  });
  return sequences;
}

function assignPresentationSequences(
  state: PresentationState,
  previous: Map<string, number>,
): void {
  for (const line of state.lines) assignLineSequences(state, line, previous);
  assignHtmlIslandSequences(state, state.htmlIsland, previous);
  assignSceneSequences(state, state.scene, previous);
}

function assignLineSequences(
  state: PresentationState,
  line: DisplayLine,
  previous = new Map<string, number>(),
): void {
  visitRuns(line.runs, `line:${String(line.line_id)}`, ({ interaction }) => {
    assignInteractionSequence(state, interaction, previous);
  });
}

function assignHtmlIslandSequences(
  state: PresentationState,
  documents: any[],
  previous = new Map<string, number>(),
): void {
  for (const [index, document] of documents.entries())
    visitHtmlNodes(document?.nodes ?? [], `island:${index}`, ({ interaction }) => {
      assignInteractionSequence(state, interaction, previous);
    });
}

function assignSceneSequences(
  state: PresentationState,
  scene: SceneStateV1,
  previous = new Map<string, number>(),
): void {
  visitScene(scene, ({ interaction }) => assignInteractionSequence(state, interaction, previous));
}

function assignInteractionSequence(
  state: PresentationState,
  interaction: any,
  previous: Map<string, number>,
): void {
  if (interaction[INTERACTION_SEQUENCE] != null) return;
  const restored = previous.get(interactionIdentity(interaction));
  if (restored != null) {
    interaction[INTERACTION_SEQUENCE] = restored;
    return;
  }
  interaction[INTERACTION_SEQUENCE] = state.nextInteractionSequence;
  state.nextInteractionSequence += 1;
}

function findPresentationInteraction(state: PresentationState, token: InteractionToken): any {
  for (let index = state.scene.layers.length - 1; index >= 0; index -= 1) {
    const interaction = state.scene.layers[index].interaction;
    const current = interaction?.token;
    if (
      current &&
      sameInteractionInteger(current.epoch, token.epoch) &&
      sameInteractionInteger(current.id, token.id)
    )
      return interaction;
  }
  for (let index = state.htmlIsland.length - 1; index >= 0; index -= 1) {
    const found = findHtmlInteraction(state.htmlIsland[index]?.nodes ?? [], token);
    if (found) return found;
  }
  for (let index = state.lines.length - 1; index >= 0; index -= 1) {
    const found = findRunInteraction(state.lines[index]?.runs ?? [], token);
    if (found) return found;
  }
  return undefined;
}

function sameInteractionInteger(left: unknown, right: unknown): boolean {
  return (
    (typeof left === "number" || typeof left === "bigint") &&
    (typeof right === "number" || typeof right === "bigint") &&
    BigInt(left) === BigInt(right)
  );
}

function findRunInteraction(runs: any[], token: InteractionToken): any {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.type === "button") {
      const interactionToken = run.token ?? run;
      if (interactionToken.epoch === token.epoch && interactionToken.id === token.id) return run;
      const nested = findRunInteraction(run.runs ?? [], token);
      if (nested) return nested;
    } else if (run.type === "column_cell") {
      const nested = findRunInteraction(run.content ?? [], token);
      if (nested) return nested;
    } else if (run.type === "html_document") {
      const nested = findHtmlInteraction(run.document?.nodes ?? [], token);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findHtmlInteraction(nodes: any[], token: InteractionToken): any {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const interaction = node.interaction;
    if (interaction?.epoch === token.epoch && interaction.id === token.id) return interaction;
    const nested = findHtmlInteraction(node.children ?? [], token);
    if (nested) return nested;
  }
  return undefined;
}

export function plainRun(run: any): string {
  switch (run.type) {
    case "text":
    case "text_layout":
      return run.text;
    case "button":
      return (run.runs ?? []).map(plainRun).join("");
    case "image":
      return run.alt_text ?? "";
    case "column_cell":
      return (run.content ?? []).map(plainRun).join("");
    case "separator":
      return run.pattern ?? "";
    case "space":
      return " ";
    default:
      return "";
  }
}

export function plainLine(line: DisplayLine): string {
  return line.runs.map(plainRun).join("");
}

export function printedHtmlLine(line: DisplayLine, lineHeight = 0): string {
  const content = line.runs.map((run) => printedHtmlRun(run, lineHeight)).join("");
  return `<p align='${line.alignment}'><nobr>${content}</nobr></p>`;
}

function printedHtmlRun(run: any, lineHeight: number): string {
  switch (run.type) {
    case "text":
    case "text_layout": {
      let value = escapeHtml(run.text ?? "");
      if (run.style?.strikeout) value = `<s>${value}</s>`;
      if (run.style?.underline) value = `<u>${value}</u>`;
      if (run.style?.italic) value = `<i>${value}</i>`;
      if (run.style?.bold) value = `<b>${value}</b>`;
      return value;
    }
    case "button": {
      const value = protocolValueText(run.value);
      const title = run.title == null ? "" : ` title='${escapeHtml(run.title)}'`;
      return `<button value='${escapeHtml(value)}'${title}>${(run.runs ?? [])
        .map((child: any) => printedHtmlRun(child, lineHeight))
        .join("")}</button>`;
    }
    case "html_document":
      return serializeHtmlDocument(run.document);
    case "image": {
      const placement = run.placement ?? {};
      let value = `<img src='${escapeHtml(placement.resource_id ?? "")}`;
      if (placement.hover_resource_id != null)
        value += `' srcb='${escapeHtml(placement.hover_resource_id)}`;
      if (placement.mask_resource_id != null)
        value += `' srcm='${escapeHtml(placement.mask_resource_id)}`;
      for (const [name, length] of [
        ["height", placement.requested_height],
        ["width", placement.requested_width],
        ["ypos", placement.requested_y],
      ] as const) {
        if (length != null) value += `' ${name}='${projectedLength(length, lineHeight)}`;
      }
      return `${value}'>`;
    }
    case "shape": {
      const shape = run.shape ?? {};
      let value = `<shape type='${escapeHtml(shape.kind ?? "")}' param='${(shape.parameters ?? [])
        .map(rawLength)
        .join(", ")}'`;
      if (shape.foreground && !isDefaultForeground(shape.foreground))
        value += ` color='${htmlColor(shape.foreground)}'`;
      if (shape.background) value += ` bcolor='${htmlColor(shape.background)}'`;
      return `${value}>`;
    }
    case "column_cell":
      return (run.content ?? []).map((child: any) => printedHtmlRun(child, lineHeight)).join("");
    case "separator":
      return escapeHtml(run.pattern ?? "");
    case "space":
      return `<shape type='space' param='${rawLength(run.width)}'>`;
    default:
      return "";
  }
}

function serializeHtmlDocument(document: any): string {
  return (document?.nodes ?? []).map(serializeHtmlRootNode).join("");
}

function serializeHtmlRootNode(node: any): string {
  if (node.type === "element" && ["paragraph", "no_break"].includes(node.kind))
    return (node.children ?? []).map(serializeHtmlRootNode).join("");
  return serializeHtmlNode(node);
}

function serializeHtmlNode(node: any): string {
  if (node.type === "text") return escapeHtml(node.text ?? "");
  if (node.type !== "element") return "";
  const tag = htmlTag(node.kind);
  const attributes = (node.attributes ?? [])
    .map((attribute: any) => ` ${attribute.name}='${escapeHtml(attribute.value ?? "")}'`)
    .join("");
  const opening = `<${tag}${attributes}>`;
  if (["br", "img", "shape"].includes(tag)) return opening;
  return `${opening}${(node.children ?? []).map(serializeHtmlNode).join("")}</${tag}>`;
}

function htmlTag(kind: string): string {
  return (
    (
      {
        bold: "b",
        italic: "i",
        underline: "u",
        strike: "s",
        font: "font",
        paragraph: "p",
        no_break: "nobr",
        button: "button",
        non_button: "nonbutton",
        clear_button: "clearbutton",
        image: "img",
        shape: "shape",
        division: "div",
        break: "br",
      } as Record<string, string>
    )[kind] ?? kind
  );
}

function protocolValueText(value: any): string {
  if (value?.type === "boolean") return value.value ? "1" : "0";
  if (value?.type === "bytes") return "";
  if (value && typeof value === "object" && "value" in value) return String(value.value);
  return value == null ? "" : String(value);
}
