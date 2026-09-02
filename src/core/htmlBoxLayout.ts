import type { DisplayLine } from "@/core/types";
import { projectPositionedMediaVerticalSpan } from "@/core/mediaProjection";

export interface HtmlBoxRowLayout {
  columns: number;
  trailingRunIndex: number;
  trailingFill?: { character: string; columns: number };
}

export interface HtmlTextSegment {
  text: string;
  kind: "text" | "space" | "box" | "edge" | "fill";
  width?: string;
  continuation?: string;
}

export interface PositionedMediaLayoutOptions {
  fontSizePx: number;
  lineHeightPx: number;
  imageScale: number;
}

const TOP_LEFT = new Set(["┌", "┏", "╔"]);
const TOP_RIGHT = new Set(["┐", "┓", "╗"]);
const BOTTOM_LEFT = new Set(["└", "┗", "╚"]);
const BOTTOM_RIGHT = new Set(["┘", "┛", "╝"]);
const VERTICAL = new Set(["│", "┃", "║"]);
const TRAILING_EDGE = new Set([...TOP_RIGHT, ...BOTTOM_RIGHT, ...VERTICAL]);
const HORIZONTAL_CONTINUATION = new Map([
  ...Array.from("─┌└├┬┴┼", (character) => [character, "─"] as const),
  ...Array.from("━┏┗┣┳┻╋", (character) => [character, "━"] as const),
  ...Array.from("═╔╚╠╦╩╬", (character) => [character, "═"] as const),
]);
const LEFT_HORIZONTAL_CONNECTION = new Set([
  ...Array.from("─┐┘┤┬┴┼"),
  ...Array.from("━┓┛┫┳┻╋"),
  ...Array.from("═╗╝╣╦╩╬"),
]);

interface HtmlLineInfo {
  text: string;
  columns: number;
  first: string;
  last: string;
  trailingRunIndex: number;
}

/** Project box rows intersecting one virtual-history range. */
export function htmlBoxRowLayoutsForRange(
  lines: readonly DisplayLine[],
  start: number,
  end: number,
): Map<number, HtmlBoxRowLayout> {
  const layouts = new Map<number, HtmlBoxRowLayout>();
  if (lines.length === 0 || end < start) return layouts;
  const firstVisible = Math.max(0, Math.min(start, lines.length - 1));
  const lastVisible = Math.max(firstVisible, Math.min(end, lines.length - 1));
  let scanStart = firstVisible;
  while (scanStart > 0) {
    const previous = htmlLineInfo(lines[scanStart - 1]);
    if (previous == null) break;
    scanStart -= 1;
    if (isTop(previous) || isBottom(previous)) break;
    if (!isInterior(previous)) {
      scanStart += 1;
      break;
    }
  }

  let activeColumns: number | undefined;
  for (let index = scanStart; index <= lastVisible; index += 1) {
    const info = htmlLineInfo(lines[index]);
    if (info == null) {
      activeColumns = undefined;
      continue;
    }
    if (isTop(info)) {
      activeColumns = info.columns;
      if (index >= firstVisible)
        layouts.set(index, {
          columns: activeColumns,
          trailingRunIndex: info.trailingRunIndex,
        });
      continue;
    }
    const interior = isInterior(info);
    const bottom = isBottom(info);
    if (activeColumns == null || (!interior && !bottom)) {
      activeColumns = undefined;
      continue;
    }
    if (info.columns <= activeColumns && index >= firstVisible) {
      const missingColumns = activeColumns - info.columns;
      layouts.set(index, {
        columns: activeColumns,
        trailingRunIndex: info.trailingRunIndex,
        trailingFill:
          bottom && missingColumns > 0
            ? {
                character: boxContinuation(info.first) ?? "─",
                columns: missingColumns,
              }
            : undefined,
      });
    }
    if (bottom) activeColumns = undefined;
  }
  return layouts;
}

/** Find the inner right edge of box rows crossed by upward-overflowing positioned media. */
export function positionedMediaRightBoundariesForRange(
  lines: readonly DisplayLine[],
  start: number,
  end: number,
  options: PositionedMediaLayoutOptions,
): Map<number, number> {
  const boundaries = new Map<number, number>();
  if (lines.length === 0 || end < start || options.lineHeightPx <= 0) return boundaries;
  const first = Math.max(0, Math.min(start, lines.length - 1));
  const last = Math.max(first, Math.min(end, lines.length - 1));
  for (let index = first; index <= last; index += 1) {
    const candidates = positionedMediaCandidates(lines[index], options);
    if (candidates.length !== 1 || candidates[0].span.top >= 0) continue;
    const candidate = candidates[0];
    const span = candidate.span;
    const overlapStart = Math.max(0, index + Math.floor(span.top / options.lineHeightPx));
    const overlapEnd = Math.min(
      index - 1,
      index + Math.ceil(span.bottom / options.lineHeightPx) - 1,
    );
    if (overlapEnd < overlapStart) continue;
    const crossedBoxes = htmlBoxRowLayoutsForRange(lines, overlapStart, overlapEnd);
    let rightEdge: number | undefined;
    for (const layout of crossedBoxes.values()) {
      // The final two-column cell contains the visible right border; media stays to its left.
      rightEdge = Math.min(rightEdge ?? Number.POSITIVE_INFINITY, layout.columns - 2);
    }
    for (const edge of trailingBoxRightEdgesForRange(lines, overlapStart, overlapEnd))
      rightEdge = Math.min(rightEdge ?? Number.POSITIVE_INFINITY, edge);
    if (rightEdge != null && rightEdge > 0 && candidate.requestedLeftColumns < rightEdge)
      boundaries.set(index, rightEdge);
  }
  return boundaries;
}

export function htmlTextSegments(
  value: unknown,
  replaceFullWidthSpaces: boolean,
  alignTrailingEdge: boolean,
  trailingFill?: { character: string; columns: number },
  followingCharacter?: string,
): HtmlTextSegment[] {
  let text = String(value ?? "");
  if (replaceFullWidthSpaces) text = text.replaceAll("　", "  ");
  let trailingEdge = "";
  const last = Array.from(text).at(-1);
  if (alignTrailingEdge && last != null && TRAILING_EDGE.has(last)) {
    trailingEdge = last;
    text = text.slice(0, -last.length);
  }
  const segments: HtmlTextSegment[] = [];
  const parts = text.split(/( +|[\u2500-\u257f])/u).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part[0] === " ") {
      segments.push({ text: part, kind: "space", width: `${part.length}ch` });
    } else if (/^[\u2500-\u257f]$/u.test(part)) {
      const nextCharacter = Array.from(parts[index + 1] ?? followingCharacter ?? "")[0];
      segments.push({
        text: part,
        kind: "box",
        width: "2ch",
        // The second half-cell is a stroke only when the following glyph continues the border.
        // Labeled corners deliberately leave it empty so the stroke cannot cover the title.
        continuation: LEFT_HORIZONTAL_CONNECTION.has(nextCharacter)
          ? boxContinuation(part)
          : undefined,
      });
    } else {
      segments.push({ text: part, kind: "text" });
    }
  }
  if (trailingFill && trailingFill.columns > 0) {
    segments.push({
      text: trailingFill.character.repeat(trailingFill.columns),
      kind: "fill",
      width: `${trailingFill.columns}ch`,
    });
  }
  if (trailingEdge) segments.push({ text: trailingEdge, kind: "edge", width: "2ch" });
  return segments;
}

export function lastRenderableTextNodeIndex(nodes: readonly any[]): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (htmlNodeText(nodes[index])) return index;
  }
  return -1;
}

export function nextRenderableTextCharacter(
  nodes: readonly any[],
  index: number | string,
  fallback?: string,
): string | undefined {
  for (let candidate = Number(index) + 1; candidate < nodes.length; candidate += 1) {
    const text = htmlNodeText(nodes[candidate]);
    if (text == null) return undefined;
    const first = Array.from(text)[0];
    if (first) return first;
  }
  return fallback;
}

export function boxContinuation(character: string): string | undefined {
  return HORIZONTAL_CONTINUATION.get(character);
}

function htmlLineInfo(line: DisplayLine): HtmlLineInfo | undefined {
  let text = "";
  let trailingRunIndex = -1;
  for (let runIndex = 0; runIndex < line.runs.length; runIndex += 1) {
    const run = line.runs[runIndex];
    const runText = displayRunText(run);
    if (runText == null) return undefined;
    if (runText) trailingRunIndex = runIndex;
    text += runText;
  }
  const characters = Array.from(text);
  const first = characters[0];
  const last = characters.at(-1);
  if (!first || !last || trailingRunIndex < 0) return undefined;
  return {
    text,
    columns: characters.reduce((columns, character) => columns + eraCharacterColumns(character), 0),
    first,
    last,
    trailingRunIndex,
  };
}

function displayRunText(run: any): string | undefined {
  switch (run?.type) {
    case "text":
    case "text_layout":
      return String(run.text ?? "");
    case "button":
      return displayRunsText(run.runs ?? []);
    case "html_document": {
      let text = "";
      for (const node of run.document?.nodes ?? []) {
        const value = htmlNodeText(node);
        if (value == null) return undefined;
        text += value;
      }
      return text;
    }
    case "column_cell":
      return displayRunsText(run.content ?? []);
    case "separator":
      return String(run.pattern ?? "");
    case "space":
      return " ";
    default:
      return undefined;
  }
}

function displayRunsText(runs: readonly any[]): string | undefined {
  let text = "";
  for (const run of runs) {
    const value = displayRunText(run);
    if (value == null) return undefined;
    text += value;
  }
  return text;
}

function trailingBoxRightEdgesForRange(
  lines: readonly DisplayLine[],
  start: number,
  end: number,
): number[] {
  const edges: number[] = [];
  let active: { leftColumn: number; rightColumn: number } | undefined;
  for (let index = 0; index <= end; index += 1) {
    const info = htmlLineInfo(lines[index]);
    if (info == null) {
      active = undefined;
      continue;
    }
    const positions = characterColumnPositions(info.text);
    const last = positions.at(-1);
    const topLeft = TOP_RIGHT.has(last?.character ?? "")
      ? positions.findLast((item) => TOP_LEFT.has(item.character))
      : undefined;
    if (topLeft != null) {
      active = { leftColumn: topLeft.column, rightColumn: info.columns };
      if (index >= start) edges.push(info.columns - 2);
      continue;
    }
    if (active == null) continue;
    const current = active;
    const left = positions.find((item) => item.column === current.leftColumn)?.character;
    const isInteriorRow = VERTICAL.has(left ?? "") && VERTICAL.has(info.last);
    const isBottomRow = BOTTOM_LEFT.has(left ?? "") && BOTTOM_RIGHT.has(info.last);
    if ((!isInteriorRow && !isBottomRow) || info.columns > current.rightColumn) {
      active = undefined;
      continue;
    }
    if (index >= start) edges.push(current.rightColumn - 2);
    if (isBottomRow) active = undefined;
  }
  return edges.filter((edge) => edge > 0);
}

function characterColumnPositions(text: string): Array<{ character: string; column: number }> {
  const positions: Array<{ character: string; column: number }> = [];
  let column = 0;
  for (const character of Array.from(text)) {
    positions.push({ character, column });
    column += eraCharacterColumns(character);
  }
  return positions;
}

function htmlNodeText(node: any): string | undefined {
  if (node?.type === "text") return String(node.text ?? "");
  if (node?.kind === "break") return undefined;
  if (["image", "shape", "division"].includes(node?.semantic?.type)) return undefined;
  let text = "";
  for (const child of node?.children ?? []) {
    const value = htmlNodeText(child);
    if (value == null) return undefined;
    text += value;
  }
  return text;
}

function isTop(info: HtmlLineInfo): boolean {
  return TOP_LEFT.has(info.first) && TOP_RIGHT.has(info.last);
}

function isInterior(info: HtmlLineInfo): boolean {
  return VERTICAL.has(info.first) && VERTICAL.has(info.last);
}

function isBottom(info: HtmlLineInfo): boolean {
  return BOTTOM_LEFT.has(info.first) && BOTTOM_RIGHT.has(info.last);
}

export function eraCharacterColumns(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint >= 0x2500 && codePoint <= 0x257f) return 2;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return 1;
}

function positionedMediaCandidates(
  line: DisplayLine,
  options: PositionedMediaLayoutOptions,
): Array<{
  requestedLeftColumns: number;
  span: { top: number; bottom: number };
}> {
  const candidates: Array<{
    requestedLeftColumns: number;
    span: { top: number; bottom: number };
  }> = [];
  const visit = (node: any): void => {
    const semantic = node?.semantic;
    const locksPosition =
      ["button", "non_button"].includes(semantic?.type) && semantic.position != null;
    if (locksPosition) {
      const position = Number(semantic.position);
      const span = descendantMediaVerticalSpan(node, options);
      if (Number.isFinite(position) && span != null) {
        // Era positions use font-height hundredths; one half-width console column is 50 units.
        candidates.push({ requestedLeftColumns: position / 50, span });
      }
      return;
    }
    for (const child of node?.children ?? []) visit(child);
  };
  for (const run of line.runs) {
    if (run.type !== "html_document") continue;
    for (const node of run.document?.nodes ?? []) visit(node);
  }
  return candidates;
}

function descendantMediaVerticalSpan(
  node: any,
  options: PositionedMediaLayoutOptions,
): { top: number; bottom: number } | undefined {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let found = false;
  const visit = (child: any): void => {
    const semantic = child?.semantic;
    if (semantic?.type === "image") {
      const bottomAnchored =
        semantic.y?.unit === semantic.height?.unit &&
        Number(semantic.y?.value) + Math.abs(Number(semantic.height?.value)) === 0;
      const span = projectPositionedMediaVerticalSpan({
        y: semantic.y,
        height: semantic.height,
        fontSizePx: options.fontSizePx,
        imageScale: options.imageScale,
        bottomAnchored,
        lineHeightPx: options.lineHeightPx,
      });
      if (span != null) {
        top = Math.min(top, span.top);
        bottom = Math.max(bottom, span.bottom);
        found = true;
      }
    }
    for (const nested of child?.children ?? []) visit(nested);
  };
  for (const child of node?.children ?? []) visit(child);
  return found ? { top, bottom } : undefined;
}
