import type { CanonicalHtmlDocument, CanonicalHtmlLength } from "@/core/htmlMeasurement";
import { projectPresentationLength } from "@/core/shapeProjection";
import type { DisplayLine } from "@/core/types";

interface ImageLayerRow {
  index: number;
  y: CanonicalHtmlLength;
  heights: CanonicalHtmlLength[];
  multipleColumns: boolean;
}

export interface ImageLayerLayout {
  offset: number;
  minimumHeight?: number;
}

/**
 * Locate complete image-layer groups emitted by Snake TW's display library.
 *
 * The library emits at least two consecutive `zero-space -> positioned image`
 * pairs. The reference renderer retains those console rows while painting each
 * successive image at the same origin. Requiring the complete signature keeps
 * an ordinary spacer followed by one image on the normal layout path.
 */
export function htmlImageLayerOffsets(
  lines: readonly DisplayLine[],
  lineHeightPx: number,
): ReadonlyMap<number, number> {
  return htmlImageLayerOffsetsForRange(lines, lineHeightPx, 0, lines.length - 1);
}

/** Resolve only groups intersecting the rendered virtual range. Backtracking follows the current
 * image group to its real start, so layer offsets remain identical when the range begins midway
 * through a group without scanning unrelated history. */
export function htmlImageLayerOffsetsForRange(
  lines: readonly DisplayLine[],
  lineHeightPx: number,
  firstIndex: number,
  lastIndex: number,
): ReadonlyMap<number, number> {
  return new Map(
    [...htmlImageLayerLayoutForRange(lines, lineHeightPx, firstIndex, lastIndex)].map(
      ([index, layout]) => [index, layout.offset],
    ),
  );
}

export function htmlImageLayerLayoutForRange(
  lines: readonly DisplayLine[],
  lineHeightPx: number,
  firstIndex: number,
  lastIndex: number,
  fontSizePx = lineHeightPx,
  imageScale = 1,
): ReadonlyMap<number, ImageLayerLayout> {
  const offsets = new Map<number, ImageLayerLayout>();
  if (![lineHeightPx, fontSizePx, imageScale].every((value) => Number.isFinite(value) && value > 0))
    return offsets;
  if (!lines.length || firstIndex > lastIndex) return offsets;

  const first = Math.max(0, Math.min(lines.length - 1, Math.trunc(firstIndex)));
  const last = Math.max(first, Math.min(lines.length - 1, Math.trunc(lastIndex)));
  for (let start = Math.max(0, first - 1); start <= last && start < lines.length - 1; start += 1) {
    if (!isZeroSpaceLine(lines[start]) || relativeImageLine(lines[start + 1]) == null) continue;
    while (
      start >= 2 &&
      relativeImageLine(lines[start - 1]) != null &&
      isZeroSpaceLine(lines[start - 2])
    )
      start -= 2;
    const rows: ImageLayerRow[] = [];
    let cursor = start;
    while (isZeroSpaceLine(lines[cursor])) {
      const row = relativeImageLine(lines[cursor + 1]);
      if (row == null) break;
      rows.push({ index: cursor + 1, ...row });
      cursor += 2;
    }
    if (isImageLayerGroup(rows)) {
      const multipleColumns = rows.some((row) => row.multipleColumns);
      const standardSequence = rows.every(
        (row, layer) => row.y.unit === "font_height_hundredths" && row.y.value === -100 * layer,
      );
      const sized = rows.every(
        (row) =>
          row.heights.length > 0 &&
          row.heights.every((height) => Number.isFinite(height.value) && height.value !== 0),
      );
      // Extend only the confirmed multi-column signature. Existing single-image groups retain
      // their signed displacement, including pixel units and nonstandard vertical steps.
      if (multipleColumns && (!standardSequence || !sized)) {
        start = cursor - 1;
        continue;
      }
      let bottom = 0;
      for (const row of rows)
        for (const height of row.heights)
          bottom = Math.max(
            bottom,
            Math.abs(projectPresentationLength(height, fontSizePx) ?? 0) * imageScale,
          );
      rows.forEach((row, layer) => {
        if (row.index < first || row.index > last) return;
        if (!multipleColumns) {
          offsets.set(row.index, { offset: -(layer + 1) * lineHeightPx });
          return;
        }
        const advance = (row.index - start) * lineHeightPx;
        const y = (projectPresentationLength(row.y, fontSizePx) ?? 0) * imageScale;
        offsets.set(row.index, {
          offset: -advance - y,
          // Reserve the group's visible extent once, after the final layer. Intermediate
          // rows must not acquire the height of their overflowing images.
          minimumHeight:
            layer === rows.length - 1 ? Math.max(lineHeightPx, bottom - advance) : lineHeightPx,
        });
      });
    }
    // Backtracking can move start before the loop's prior cursor. Always skip the group just
    // inspected, including invalid groups, or the next iteration can rediscover it forever.
    start = cursor - 1;
  }
  return offsets;
}

function htmlDocument(line: DisplayLine | undefined): CanonicalHtmlDocument | undefined {
  if (!line || line.runs.length !== 1 || line.runs[0]?.type !== "html_document") return undefined;
  return line.runs[0].document as CanonicalHtmlDocument;
}

function isZeroSpaceLine(line: DisplayLine | undefined): boolean {
  const nodes = htmlDocument(line)?.nodes;
  if (nodes?.length !== 1) return false;
  const node = nodes[0];
  return (
    node.type === "element" &&
    node.kind === "shape" &&
    node.interaction == null &&
    node.children.length === 0 &&
    node.semantic.type === "shape" &&
    node.semantic.kind.toLowerCase() === "space" &&
    node.semantic.parameters.length === 1 &&
    Number(node.semantic.parameters[0].value) === 0
  );
}

function relativeImageLine(
  line: DisplayLine | undefined,
): Omit<ImageLayerRow, "index"> | undefined {
  const nodes = htmlDocument(line)?.nodes;
  if (nodes?.length !== 1) return undefined;
  const root = nodes[0];
  if (root.type !== "element" || root.interaction != null) return undefined;
  const children =
    root.kind === "paragraph" && root.semantic.type === "paragraph" ? root.children : [root];
  let y: CanonicalHtmlLength | undefined;
  const heights: CanonicalHtmlLength[] = [];
  for (const child of children) {
    if (child.type !== "element" || child.interaction != null || child.children.length !== 0)
      return undefined;
    const semantic = child.semantic;
    if (
      child.kind === "shape" &&
      semantic.type === "shape" &&
      semantic.kind.toLowerCase() === "space" &&
      semantic.parameters.length === 1 &&
      Number.isFinite(Number(semantic.parameters[0].value)) &&
      Number(semantic.parameters[0].value) >= 0
    )
      continue;
    if (
      child.kind !== "image" ||
      semantic.type !== "image" ||
      (semantic.display ?? "relative") !== "relative" ||
      semantic.y == null ||
      !Number.isFinite(Number(semantic.y.value))
    )
      return undefined;
    if (y && (y.unit !== semantic.y.unit || y.value !== Number(semantic.y.value))) return undefined;
    // Runtime CBOR lengths may be bigint even though measurement requests use numbers.
    y = { ...semantic.y, value: Number(semantic.y.value) };
    if (semantic.height) heights.push({ ...semantic.height, value: Number(semantic.height.value) });
  }
  return y ? { y, heights, multipleColumns: children.length > 1 } : undefined;
}

function isImageLayerGroup(rows: readonly ImageLayerRow[]): boolean {
  if (rows.length < 2 || rows[0].y.value !== 0) return false;
  const unit = rows[0].y.unit;
  let previous = 0;
  for (const row of rows.slice(1)) {
    if (row.y.unit !== unit || !Number.isFinite(row.y.value) || row.y.value >= previous)
      return false;
    previous = row.y.value;
  }
  return true;
}
