import { htmlTextSegments, type HtmlTextSegment } from "@/core/htmlBoxLayout";
import {
  RuntimeServiceError,
  type ProjectionQueryContext,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { TextStyle } from "@/core/types";

export type CanonicalHtmlKind =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "font"
  | "paragraph"
  | "no_break"
  | "button"
  | "non_button"
  | "clear_button"
  | "image"
  | "shape"
  | "division"
  | "break";
export interface CanonicalHtmlLength {
  unit: "pixels" | "font_height_hundredths";
  value: number;
}
export type CanonicalHtmlDisplayMode =
  "relative" | "absolute" | "absolute_left_top" | "absolute_left_bottom";
export interface CanonicalHtmlTextRenderIntent {
  renderer?: "gdi" | "skia";
  edging?: "alias" | "anti_alias" | "subpixel_anti_alias";
  hinting?: "none" | "slight" | "normal" | "full";
}
export type CanonicalHtmlColorMatrix = {
  type: "fixed";
  value: readonly ServiceInteger[];
};
type BoxLengths = readonly [
  CanonicalHtmlLength,
  CanonicalHtmlLength,
  CanonicalHtmlLength,
  CanonicalHtmlLength,
];
export interface CanonicalHtmlBoxModel {
  border?: BoxLengths | null;
  radius?: BoxLengths | null;
  margin?: BoxLengths | null;
  padding?: BoxLengths | null;
  border_colors?: readonly number[] | null;
}
export type CanonicalHtmlSemantic =
  | { type: "style" | "no_break" | "break" }
  | {
      type: "font";
      face?: string | null;
      color?: number | null;
      button_color?: number | null;
      size_millipixels?: number | null;
      vertical_alignment?: "top" | "middle" | "bottom" | null;
      render_intent?: CanonicalHtmlTextRenderIntent;
    }
  | { type: "paragraph"; alignment: "left" | "center" | "right" }
  | { type: "button"; value?: string | null; title?: string | null; position?: number | null }
  | { type: "non_button"; title?: string | null; position?: number | null }
  | { type: "clear_button"; suppress_tooltip: boolean }
  | {
      type: "image";
      source: string;
      hover_source?: string | null;
      mask_source?: string | null;
      width?: CanonicalHtmlLength | null;
      height?: CanonicalHtmlLength | null;
      y?: CanonicalHtmlLength | null;
      x?: CanonicalHtmlLength | null;
      display?: CanonicalHtmlDisplayMode;
      color_matrix?: CanonicalHtmlColorMatrix | null;
    }
  | {
      type: "shape";
      kind: string;
      parameters: CanonicalHtmlLength[];
      color?: number | null;
      button_color?: number | null;
    }
  | {
      type: "division";
      x?: CanonicalHtmlLength | null;
      y?: CanonicalHtmlLength | null;
      width: CanonicalHtmlLength;
      height?: CanonicalHtmlLength | null;
      depth: number;
      color?: number | null;
      display?: CanonicalHtmlDisplayMode;
      /** Legacy test/document compatibility; core protocol 45 uses display. */
      relative?: boolean;
      box_model: CanonicalHtmlBoxModel;
    };
export type CanonicalHtmlNode =
  | { type: "text"; text: string; start?: ServiceInteger; end?: ServiceInteger }
  | {
      type: "element";
      kind: CanonicalHtmlKind;
      attributes: readonly { name: string; value: string }[];
      children: CanonicalHtmlNode[];
      semantic: CanonicalHtmlSemantic;
      interaction?: unknown;
      start?: ServiceInteger;
      end?: ServiceInteger;
    };
export interface CanonicalHtmlDocument {
  nodes: CanonicalHtmlNode[];
}
export interface HtmlQueryStyle {
  current: TextStyle;
  base: TextStyle;
  settings: { line_height: number | bigint; [key: string]: unknown };
}
export interface HtmlMeasurementCut {
  id: number;
  textNodePath: readonly number[];
  decodedUtf8Offset: number;
  decodedUtf16Offset: number;
}
export interface HtmlMeasurementProbe {
  document: CanonicalHtmlDocument;
  mode: "text_part";
  cuts: readonly HtmlMeasurementCut[];
  style: HtmlQueryStyle;
}
export interface HtmlImageMeasurementProbe {
  document: CanonicalHtmlDocument;
  /** Reference AltText is constructed by core, not derived from source markup by this provider. */
  missingDocument: CanonicalHtmlDocument;
  style: HtmlQueryStyle;
}
export type HtmlImageMeasurementResult = { context: ProjectionQueryContext } & (
  | { type: "loaded"; naturalWidth: number; naturalHeight: number }
  | { type: "missing"; fallbackAdvancePx: number }
);
export interface HtmlFixedSlotProbe {
  document: CanonicalHtmlDocument;
  style: HtmlQueryStyle;
}
export interface HtmlFixedSlotResult {
  context: ProjectionQueryContext;
  type: "ready";
}
export interface HtmlTextBoundary {
  utf8: number;
  utf16: number;
}
export interface HtmlMeasuredTextNode {
  path: number[];
  boundaries: HtmlTextBoundary[];
}
export interface HtmlMeasuredFragment {
  textNodePath?: number[];
  decodedUtf16Start?: number;
  decodedUtf16End?: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}
/** DOM geometry is diagnostic input; the core retains reference first-row layout policy. */
export interface HtmlFirstRowMetrics {
  advancePx: number;
  heightPx: number;
  fragments: HtmlMeasuredFragment[];
}
export interface HtmlMeasurementResult {
  context: ProjectionQueryContext;
  advancePx: number;
  cuts: { id: number; advancePx: number }[];
  textNodes: HtmlMeasuredTextNode[];
  firstRow: HtmlFirstRowMetrics;
}
export const HTML_MEASUREMENT_LIMITS = Object.freeze({
  nodes: 4096,
  depth: 64,
  scalars: 65536,
  cuts: 2048,
  work: 1_000_000,
  domNodes: 4096,
  media: 32,
  pixels: 64 * 1024 * 1024,
  side: 8192,
});
const semantics: Record<CanonicalHtmlKind, CanonicalHtmlSemantic["type"]> = {
  bold: "style",
  italic: "style",
  underline: "style",
  strike: "style",
  font: "font",
  paragraph: "paragraph",
  no_break: "no_break",
  button: "button",
  non_button: "non_button",
  clear_button: "clear_button",
  image: "image",
  shape: "shape",
  division: "division",
  break: "break",
};
function invalid(message: string): never {
  throw new RuntimeServiceError("invalid_request", message);
}
export function htmlTextBoundaries(text: string): HtmlTextBoundary[] {
  const boundaries = [{ utf8: 0, utf16: 0 }];
  let utf8 = 0;
  let utf16 = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) invalid("HTML text contains an unpaired surrogate");
    utf8 += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    utf16 += scalar.length;
    boundaries.push({ utf8, utf16 });
    if (boundaries.length > HTML_MEASUREMENT_LIMITS.scalars + 1)
      throw new RuntimeServiceError("resource_limit", "HTML scalar limit exceeded");
  }
  return boundaries;
}
function checkedLength(length: CanonicalHtmlLength | null | undefined): void {
  if (length == null) return;
  if (
    !["pixels", "font_height_hundredths"].includes(length.unit) ||
    !Number.isInteger(length.value) ||
    length.value < -2147483648 ||
    length.value > 2147483647
  )
    invalid("HTML semantic length is invalid");
}
function checkedColor(value: number | null | undefined): void {
  if (value != null && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
    invalid("HTML semantic color is invalid");
}
function checkedString(value: string | null | undefined): void {
  if (value != null && (typeof value !== "string" || value.length > 4096))
    invalid("HTML semantic string is invalid");
}
function checkedSemantic(node: Extract<CanonicalHtmlNode, { type: "element" }>): void {
  const semantic = node.semantic;
  if (!semantic || semantic.type !== semantics[node.kind])
    invalid("HTML kind and semantic disagree");
  if (semantic.type === "image") {
    if (typeof semantic.source !== "string" || semantic.source.length > 4096)
      invalid("HTML image source is invalid");
    checkedString(semantic.hover_source);
    checkedString(semantic.mask_source);
    checkedLength(semantic.width);
    checkedLength(semantic.height);
    checkedLength(semantic.y);
    checkedLength(semantic.x);
    if (
      semantic.display != null &&
      !["relative", "absolute", "absolute_left_top", "absolute_left_bottom"].includes(
        semantic.display,
      )
    )
      invalid("HTML image display mode is invalid");
  } else if (semantic.type === "shape") {
    if (
      typeof semantic.kind !== "string" ||
      !["rect", "space"].includes(semantic.kind.toLowerCase())
    )
      invalid("HTML shape has no existing projection");
    if (!Array.isArray(semantic.parameters) || semantic.parameters.length > 8)
      invalid("HTML shape parameters are invalid");
    if (
      semantic.kind.toLowerCase() === "space"
        ? semantic.parameters.length !== 1
        : ![1, 4].includes(semantic.parameters.length)
    )
      invalid("HTML shape has no valid existing slot projection");
    semantic.parameters.forEach(checkedLength);
    checkedColor(semantic.color);
    checkedColor(semantic.button_color);
  } else if (semantic.type === "division") {
    if (!semantic.width) invalid("HTML division width is missing");
    checkedLength(semantic.x);
    checkedLength(semantic.y);
    checkedLength(semantic.width);
    checkedLength(semantic.height);
    checkedColor(semantic.color);
    const display = semantic.display ?? (semantic.relative === true ? "relative" : "absolute");
    if (
      !["relative", "absolute", "absolute_left_top", "absolute_left_bottom"].includes(display) ||
      !Number.isInteger(semantic.depth) ||
      !semantic.box_model
    )
      invalid("HTML division semantic is invalid");
    for (const name of ["border", "radius", "margin", "padding"] as const) {
      const lengths = semantic.box_model[name];
      if (lengths != null) {
        if (!Array.isArray(lengths) || lengths.length !== 4) invalid("HTML box model is invalid");
        lengths.forEach(checkedLength);
      }
    }
    if (semantic.box_model.border_colors != null) {
      if (
        !Array.isArray(semantic.box_model.border_colors) ||
        semantic.box_model.border_colors.length !== 4
      )
        invalid("HTML border colors are invalid");
      semantic.box_model.border_colors.forEach(checkedColor);
    }
  } else if (semantic.type === "font") {
    checkedString(semantic.face);
    checkedColor(semantic.color);
    checkedColor(semantic.button_color);
    if (
      semantic.size_millipixels != null &&
      (!Number.isInteger(semantic.size_millipixels) ||
        semantic.size_millipixels <= 0 ||
        semantic.size_millipixels > 0xffffffff)
    )
      invalid("HTML font size is invalid");
    if (
      semantic.vertical_alignment != null &&
      !["top", "middle", "bottom"].includes(semantic.vertical_alignment)
    )
      invalid("HTML font vertical alignment is invalid");
    const intent = semantic.render_intent;
    if (
      intent &&
      ((intent.renderer != null && !["gdi", "skia"].includes(intent.renderer)) ||
        (intent.edging != null &&
          !["alias", "anti_alias", "subpixel_anti_alias"].includes(intent.edging)) ||
        (intent.hinting != null && !["none", "slight", "normal", "full"].includes(intent.hinting)))
    )
      invalid("HTML font render intent is invalid");
  } else if (semantic.type === "button" || semantic.type === "non_button") {
    if (
      semantic.position != null &&
      (!Number.isInteger(semantic.position) ||
        semantic.position < -2147483648 ||
        semantic.position > 2147483647)
    )
      invalid("HTML button position is invalid");
    checkedString(semantic.title);
    if (semantic.type === "button") checkedString(semantic.value);
  } else if (
    semantic.type === "paragraph" &&
    !["left", "center", "right"].includes(semantic.alignment)
  )
    invalid("HTML paragraph alignment is invalid");
  else if (semantic.type === "clear_button" && typeof semantic.suppress_tooltip !== "boolean")
    invalid("HTML clear-button semantic is invalid");
}
export function inspectHtmlDocument(
  document: CanonicalHtmlDocument,
  replaceFullWidthSpaces = false,
): { textNodes: HtmlMeasuredTextNode[]; work: number; media: number } {
  if (!document || !Array.isArray(document.nodes))
    invalid("HTML document is not a canonical node list");
  let nodes = 0;
  let scalars = 0;
  let dom = 1;
  let media = 0;
  const seen = new Set<CanonicalHtmlNode>();
  const textNodes: HtmlMeasuredTextNode[] = [];
  const visit = (list: CanonicalHtmlNode[], path: number[], depth: number) => {
    if (depth > HTML_MEASUREMENT_LIMITS.depth)
      throw new RuntimeServiceError("resource_limit", "HTML tree depth limit exceeded");
    for (const [index, node] of list.entries()) {
      if (++nodes > HTML_MEASUREMENT_LIMITS.nodes)
        throw new RuntimeServiceError("resource_limit", "HTML tree node limit exceeded");
      if (!node || typeof node !== "object" || seen.has(node))
        invalid("HTML tree contains a repeated or cyclic node");
      seen.add(node);
      const next = [...path, index];
      if (node.type === "text") {
        if (typeof node.text !== "string") invalid("HTML text is not a string");
        const boundaries = htmlTextBoundaries(node.text);
        scalars += boundaries.length - 1;
        dom += 1 + htmlTextSegments(node.text, replaceFullWidthSpaces, false).length * 2;
        textNodes.push({ path: next, boundaries });
      } else if (node.type === "element" && Object.hasOwn(semantics, node.kind)) {
        if (
          !Array.isArray(node.children) ||
          !Array.isArray(node.attributes) ||
          node.attributes.length > 64
        )
          invalid("HTML element structure is invalid");
        for (const attribute of node.attributes) {
          if (
            !attribute ||
            typeof attribute.name !== "string" ||
            typeof attribute.value !== "string" ||
            attribute.name.length > 4096 ||
            attribute.value.length > 4096
          )
            invalid("HTML canonical attribute is invalid");
        }
        checkedSemantic(node);
        dom += node.kind === "image" ? 8 : 2;
        if (node.kind === "image") media += 1;
        visit(node.children, next, depth + 1);
      } else invalid("HTML node kind is unknown");
      if (
        scalars > HTML_MEASUREMENT_LIMITS.scalars ||
        dom > HTML_MEASUREMENT_LIMITS.domNodes ||
        media > HTML_MEASUREMENT_LIMITS.media
      )
        throw new RuntimeServiceError("resource_limit", "HTML projection budget exceeded");
    }
  };
  visit(document.nodes, [], 0);
  return { textNodes, work: nodes + scalars, media };
}
export function htmlNodeAt(
  document: CanonicalHtmlDocument,
  path: readonly number[],
): CanonicalHtmlNode {
  if (!Array.isArray(path) || !path.length || path.length > HTML_MEASUREMENT_LIMITS.depth + 1)
    invalid("HTML cut path is invalid");
  let children = document.nodes;
  let found: CanonicalHtmlNode | undefined;
  for (const [offset, index] of path.entries()) {
    if (!Number.isInteger(index) || index < 0 || index >= children.length)
      invalid("HTML cut path is outside the document");
    found = children[index];
    if (offset + 1 < path.length) {
      if (found.type !== "element") invalid("HTML cut path traverses text");
      children = found.children;
    }
  }
  return found!;
}
export function validateHtmlCut(document: CanonicalHtmlDocument, cut: HtmlMeasurementCut): void {
  if (!Number.isInteger(cut.id) || cut.id < 0 || cut.id > 0xffffffff)
    invalid("HTML cut ID is invalid");
  const node = htmlNodeAt(document, cut.textNodePath);
  if (node.type !== "text") invalid("HTML cut does not name a text node");
  if (
    !htmlTextBoundaries(node.text).some(
      (boundary) =>
        boundary.utf8 === cut.decodedUtf8Offset && boundary.utf16 === cut.decodedUtf16Offset,
    )
  )
    invalid("HTML UTF-8/UTF-16 cut is not one matching scalar boundary");
}
/** Crop canonical nodes, not markup. The prefix is shaped independently of the discarded suffix. */
export function htmlPrefixDocument(
  document: CanonicalHtmlDocument,
  cut: HtmlMeasurementCut,
): CanonicalHtmlDocument {
  validateHtmlCut(document, cut);
  const crop = (nodes: CanonicalHtmlNode[], depth: number): CanonicalHtmlNode[] => {
    const index = cut.textNodePath[depth];
    const prefix = nodes.slice(0, index).map((node) => structuredClone(node));
    const target = nodes[index];
    prefix.push(
      target.type === "text"
        ? { ...target, text: target.text.slice(0, cut.decodedUtf16Offset) }
        : { ...target, children: crop(target.children, depth + 1) },
    );
    return prefix;
  };
  return { nodes: crop(document.nodes, 0) };
}
export interface HtmlProjectedSegment extends HtmlTextSegment {
  boundaries: { sourceUtf16: number; domUtf16: number }[];
}
/** Preserve source scalar boundaries when one U+3000 projects as two ASCII spaces. */
export function htmlMeasurementSegments(
  text: string,
  replaceFullWidthSpaces: boolean,
): HtmlProjectedSegment[] {
  const source = htmlTextBoundaries(text);
  const projected = [{ sourceUtf16: 0, domUtf16: 0 }];
  let domUtf16 = 0;
  for (let i = 1; i < source.length; i += 1) {
    const scalar = text.slice(source[i - 1].utf16, source[i].utf16);
    domUtf16 += replaceFullWidthSpaces && scalar === "　" ? 2 : scalar.length;
    projected.push({ sourceUtf16: source[i].utf16, domUtf16 });
  }
  let start = 0;
  let boundaryIndex = 0;
  return htmlTextSegments(text, replaceFullWidthSpaces, false).map((segment) => {
    const end = start + segment.text.length;
    while (projected[boundaryIndex]?.domUtf16 < start) boundaryIndex += 1;
    const boundaries: HtmlProjectedSegment["boundaries"] = [];
    for (
      let index = boundaryIndex;
      index < projected.length && projected[index].domUtf16 <= end;
      index += 1
    ) {
      boundaries.push({
        sourceUtf16: projected[index].sourceUtf16,
        domUtf16: projected[index].domUtf16 - start,
      });
      boundaryIndex = index;
    }
    start = end;
    return { ...segment, boundaries };
  });
}
