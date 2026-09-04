import type {
  CanonicalHtmlDocument,
  CanonicalHtmlLength,
  CanonicalHtmlNode,
} from "@/core/htmlMeasurement";
import type { DisplayLine } from "@/core/types";

interface ImageLayerRow {
  index: number;
  y: CanonicalHtmlLength;
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
  const offsets = new Map<number, number>();
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) return offsets;

  for (let start = 0; start < lines.length - 1; start += 1) {
    const rows: ImageLayerRow[] = [];
    let cursor = start;
    while (isZeroSpaceLine(lines[cursor])) {
      const y = relativeImageLineY(lines[cursor + 1]);
      if (y == null) break;
      rows.push({ index: cursor + 1, y });
      cursor += 2;
    }
    if (isImageLayerGroup(rows)) {
      rows.forEach((row, layer) => offsets.set(row.index, -(layer + 1) * lineHeightPx));
      start = cursor - 1;
    }
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
    node.semantic.parameters[0].value === 0
  );
}

function relativeImageLineY(line: DisplayLine | undefined): CanonicalHtmlLength | undefined {
  const nodes = htmlDocument(line)?.nodes;
  if (nodes?.length !== 1) return undefined;
  const image = singleImage(nodes[0]);
  if (
    image == null ||
    image.interaction != null ||
    image.semantic.type !== "image" ||
    (image.semantic.display ?? "relative") !== "relative" ||
    image.semantic.y == null
  )
    return undefined;
  return image.semantic.y;
}

function singleImage(
  node: CanonicalHtmlNode,
): Extract<CanonicalHtmlNode, { type: "element" }> | undefined {
  if (node.type !== "element" || node.interaction != null) return undefined;
  if (node.kind === "image" && node.children.length === 0) return node;
  if (node.kind !== "paragraph" || node.semantic.type !== "paragraph" || node.children.length !== 1)
    return undefined;
  const child = node.children[0];
  return child.type === "element" && child.kind === "image" && child.children.length === 0
    ? child
    : undefined;
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
