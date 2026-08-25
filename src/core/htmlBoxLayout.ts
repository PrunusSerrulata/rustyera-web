import type { DisplayLine } from "@/core/types";

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

interface HtmlLineInfo {
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

export function htmlTextSegments(
  value: unknown,
  replaceFullWidthSpaces: boolean,
  alignTrailingEdge: boolean,
  trailingFill?: { character: string; columns: number },
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
  for (const part of text.split(/( +|[\u2500-\u257f])/u).filter(Boolean)) {
    if (part[0] === " ") {
      segments.push({ text: part, kind: "space", width: `${part.length}ch` });
    } else if (/^[\u2500-\u257f]$/u.test(part)) {
      segments.push({
        text: part,
        kind: "box",
        width: "2ch",
        continuation: boxContinuation(part),
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

export function boxContinuation(character: string): string | undefined {
  return HORIZONTAL_CONTINUATION.get(character);
}

function htmlLineInfo(line: DisplayLine): HtmlLineInfo | undefined {
  let text = "";
  let trailingRunIndex = -1;
  for (let runIndex = 0; runIndex < line.runs.length; runIndex += 1) {
    const run = line.runs[runIndex];
    if (run.type !== "html_document") return undefined;
    let runText = "";
    for (const node of run.document.nodes ?? []) {
      const value = htmlNodeText(node);
      if (value == null) return undefined;
      runText += value;
    }
    if (runText) trailingRunIndex = runIndex;
    text += runText;
  }
  const characters = Array.from(text);
  const first = characters[0];
  const last = characters.at(-1);
  if (!first || !last || trailingRunIndex < 0) return undefined;
  return {
    columns: characters.reduce((columns, character) => columns + eraCharacterColumns(character), 0),
    first,
    last,
    trailingRunIndex,
  };
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

function eraCharacterColumns(character: string): number {
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
