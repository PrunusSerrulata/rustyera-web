/** Numeric CBOR projection of erabasic-html's existing canonical model.
 * This module never accepts or parses EraHTML source strings. */
import {
  HTML_MEASUREMENT_LIMITS,
  inspectHtmlDocument,
  type CanonicalHtmlBoxModel,
  type CanonicalHtmlDocument,
  type CanonicalHtmlKind,
  type CanonicalHtmlLength,
  type CanonicalHtmlNode,
  type CanonicalHtmlSemantic,
  type CanonicalHtmlTextRenderIntent,
  type HtmlQueryStyle,
} from "@/core/htmlMeasurement";
import {
  RuntimeServiceError,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { Color, TextStyle } from "@/core/types";

export function invalidHtmlWire(message: string): never {
  throw new RuntimeServiceError("invalid_request", message);
}
export function htmlWireMap(
  value: unknown,
  required: readonly number[],
  optional: readonly number[] = [],
): Map<number, unknown> {
  if (
    !(value instanceof Map) ||
    required.some((key) => !value.has(key)) ||
    [...value.keys()].some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalidHtmlWire("HTML CBOR map has missing or unknown fields");
  return value;
}
export function htmlWireList(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) return invalidHtmlWire("HTML CBOR value is not an array");
  if (value.length > maximum)
    throw new RuntimeServiceError("resource_limit", "HTML CBOR array exceeds its limit");
  return value;
}
export function htmlWireInteger(value: unknown, minimum: number, maximum: number): number {
  const integer = serviceInteger(value, "HTML field", minimum < 0);
  if (integer < minimum || integer > maximum)
    return invalidHtmlWire("HTML integer is out of range");
  return Number(integer);
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string") return invalidHtmlWire("HTML field is not a string");
  if (value.length > maximum)
    throw new RuntimeServiceError("resource_limit", "HTML string exceeds its limit");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidHtmlWire("HTML field is not a boolean");
  return value;
}
function optional<T>(value: unknown, decode: (value: unknown) => T): T | undefined {
  return value == null ? undefined : decode(value);
}
function u32(value: unknown): number {
  return htmlWireInteger(value, 0, 0xffffffff);
}
function i32(value: unknown): number {
  return htmlWireInteger(value, -2147483648, 2147483647);
}
function variant(value: unknown): [number, unknown[]] {
  const outer = htmlWireList(value, 2);
  if (outer.length !== 2) return invalidHtmlWire("HTML enum requires [variant, fields]");
  return [htmlWireInteger(outer[0], 0, 255), htmlWireList(outer[1], 16)];
}
function fields(value: unknown[], minimum: number, maximum = minimum): void {
  if (value.length < minimum || value.length > maximum)
    invalidHtmlWire("HTML enum field count is invalid");
}
function index<T extends string>(value: unknown, variants: readonly T[]): T {
  return variants[htmlWireInteger(value, 0, variants.length - 1)]!;
}
function renderIntent(value: unknown): CanonicalHtmlTextRenderIntent {
  const map = htmlWireMap(value, [], [0, 1, 2]);
  return {
    renderer: optional(map.get(0), (value) => index(value, ["gdi", "skia"] as const)),
    edging: optional(map.get(1), (value) =>
      index(value, ["alias", "anti_alias", "subpixel_anti_alias"] as const),
    ),
    hinting: optional(map.get(2), (value) =>
      index(value, ["none", "slight", "normal", "full"] as const),
    ),
  };
}
function colorMatrix(value: unknown) {
  const [tag, data] = variant(value);
  if (tag !== 1) return invalidHtmlWire("HTML service exposed a non-fixed color matrix");
  fields(data, 1);
  const matrix = htmlWireList(data[0], 25);
  fields(matrix, 25);
  return {
    type: "fixed" as const,
    value: matrix.map((component) => serviceInteger(component, "HTML color matrix", true)),
  };
}
function length(value: unknown): CanonicalHtmlLength {
  const [tag, data] = variant(value);
  fields(data, 1);
  if (tag !== 0 && tag !== 1) return invalidHtmlWire("unknown HTML length unit");
  return { unit: tag === 0 ? "pixels" : "font_height_hundredths", value: i32(data[0]) };
}
function boxModel(value: unknown): CanonicalHtmlBoxModel {
  const map = htmlWireMap(value, [], [0, 1, 2, 3, 4]);
  const lengths = (value: unknown): NonNullable<CanonicalHtmlBoxModel["border"]> => {
    const array = htmlWireList(value, 4);
    fields(array, 4);
    return [length(array[0]), length(array[1]), length(array[2]), length(array[3])];
  };
  const colors = optional(map.get(4), (value) => {
    const array = htmlWireList(value, 4);
    fields(array, 4);
    return array.map(u32);
  });
  return {
    border: optional(map.get(0), lengths),
    radius: optional(map.get(1), lengths),
    margin: optional(map.get(2), lengths),
    padding: optional(map.get(3), lengths),
    border_colors: colors,
  };
}
function semantic(value: unknown): CanonicalHtmlSemantic {
  const [tag, data] = variant(value);
  const str = (index: number) => optional(data[index], text);
  const color = (index: number) => optional(data[index], u32);
  const distance = (index: number) => optional(data[index], length);
  switch (tag) {
    case 0:
      fields(data, 0);
      return { type: "style" };
    case 1:
      fields(data, 0, 6);
      return {
        type: "font",
        face: str(0),
        color: color(1),
        button_color: color(2),
        size_millipixels: optional(data[3], u32),
        vertical_alignment: optional(data[4], (value) =>
          index(value, ["top", "middle", "bottom"] as const),
        ),
        render_intent: data[5] == null ? {} : renderIntent(data[5]),
      };
    case 2: {
      fields(data, 1);
      const alignment = ["left", "center", "right"] as const;
      return { type: "paragraph", alignment: alignment[htmlWireInteger(data[0], 0, 2)] };
    }
    case 3:
      fields(data, 0);
      return { type: "no_break" };
    case 4:
      fields(data, 0, 3);
      return { type: "button", value: str(0), title: str(1), position: optional(data[2], i32) };
    case 5:
      fields(data, 0, 2);
      return { type: "non_button", title: str(0), position: optional(data[1], i32) };
    case 6:
      fields(data, 1);
      return { type: "clear_button", suppress_tooltip: boolean(data[0]) };
    case 7:
      fields(data, 1, 9);
      return {
        type: "image",
        source: text(data[0]),
        hover_source: str(1),
        mask_source: str(2),
        height: distance(3),
        width: distance(4),
        y: distance(5),
        x: distance(6),
        display:
          data[7] == null
            ? "relative"
            : index(data[7], [
                "relative",
                "absolute",
                "absolute_left_top",
                "absolute_left_bottom",
              ] as const),
        color_matrix: optional(data[8], colorMatrix),
      };
    case 8:
      fields(data, 2, 4);
      return {
        type: "shape",
        kind: text(data[0]),
        parameters: htmlWireList(data[1], 8).map(length),
        color: color(2),
        button_color: color(3),
      };
    case 9: {
      fields(data, 8);
      const display = index(data[6], [
        "relative",
        "absolute",
        "absolute_left_top",
        "absolute_left_bottom",
      ] as const);
      return {
        type: "division",
        x: distance(0),
        y: distance(1),
        width: length(data[2]),
        height: distance(3),
        depth: i32(data[4]),
        color: color(5),
        display,
        relative: display === "relative",
        box_model: boxModel(data[7]),
      };
    }
    case 10:
      fields(data, 0);
      return { type: "break" };
    default:
      return invalidHtmlWire("unknown HTML canonical semantic");
  }
}
const kinds: readonly CanonicalHtmlKind[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "font",
  "paragraph",
  "no_break",
  "button",
  "non_button",
  "clear_button",
  "image",
  "shape",
  "division",
  "break",
];

function interaction(value: unknown): unknown {
  if (value == null) return undefined;
  const map = htmlWireMap(value, [0, 1, 4, 5], [2, 3]);
  return {
    epoch: serviceInteger(map.get(0), "HTML interaction epoch"),
    id: serviceInteger(map.get(1), "HTML interaction ID"),
    integer_value: optional(map.get(2), (value) =>
      serviceInteger(value, "HTML button value", true),
    ),
    string_value: optional(map.get(3), text),
    generation: serviceInteger(map.get(4), "HTML interaction generation"),
    enabled: boolean(map.get(5)),
  };
}

export function decodeHtmlServiceDocument(value: unknown): CanonicalHtmlDocument {
  const map = htmlWireMap(value, [0]);
  let count = 0;
  let stringUnits = 0;
  const node = (value: unknown, depth: number): CanonicalHtmlNode => {
    if (++count > HTML_MEASUREMENT_LIMITS.nodes || depth > HTML_MEASUREMENT_LIMITS.depth)
      throw new RuntimeServiceError("resource_limit", "HTML canonical tree exceeds its limit");
    const [tag, data] = variant(value);
    if (tag === 0) {
      fields(data, 3);
      const content = text(data[0], HTML_MEASUREMENT_LIMITS.scalars * 2);
      stringUnits += content.length;
      if (stringUnits > HTML_MEASUREMENT_LIMITS.scalars * 2)
        throw new RuntimeServiceError("resource_limit", "HTML text budget exceeded");
      const [start, end] = span(data[1], data[2]);
      return { type: "text", text: content, start, end };
    }
    if (tag !== 1) return invalidHtmlWire("unknown HTML node variant");
    fields(data, 7);
    const attributes = htmlWireList(data[1], 64).map((value) => {
      const map = htmlWireMap(value, [0, 1]);
      return { name: text(map.get(0)), value: text(map.get(1)) };
    });
    const [start, end] = span(data[4], data[5]);
    return {
      type: "element",
      kind: kinds[htmlWireInteger(data[0], 0, kinds.length - 1)],
      attributes,
      children: htmlWireList(data[2], HTML_MEASUREMENT_LIMITS.nodes).map((child) =>
        node(child, depth + 1),
      ),
      interaction: interaction(data[3]),
      start,
      end,
      semantic: semantic(data[6]),
    };
  };
  const document = {
    nodes: htmlWireList(map.get(0), HTML_MEASUREMENT_LIMITS.nodes).map((value) => node(value, 0)),
  };
  inspectHtmlDocument(document);
  return document;
}
function span(start: unknown, end: unknown): [ServiceInteger, ServiceInteger] {
  const first = serviceInteger(start, "HTML source span start");
  const last = serviceInteger(end, "HTML source span end");
  if (BigInt(first) > BigInt(last)) return invalidHtmlWire("HTML source span is reversed");
  return [first, last];
}
function rgba(value: unknown): Color {
  const map = htmlWireMap(value, [0, 1, 2, 3]);
  const channel = (key: number) => htmlWireInteger(map.get(key), 0, 255);
  return { red: channel(0), green: channel(1), blue: channel(2), alpha: channel(3) };
}
function textStyle(value: unknown): TextStyle {
  const map = htmlWireMap(value, [0, 2, 3, 4, 5, 7], [1, 6]);
  return {
    foreground: rgba(map.get(0)),
    background: optional(map.get(1), rgba),
    bold: boolean(map.get(2)),
    italic: boolean(map.get(3)),
    underline: boolean(map.get(4)),
    strikeout: boolean(map.get(5)),
    font_family: optional(map.get(6), text),
    font_millipixels: u32(map.get(7)),
  };
}
export function decodeHtmlQueryStyle(value: unknown): HtmlQueryStyle {
  const map = htmlWireMap(value, [0, 1, 2]);
  const settings = htmlWireMap(map.get(2), [0, 1, 2, 3, 4, 5, 6, 7]);
  return {
    current: textStyle(map.get(0)),
    base: textStyle(map.get(1)),
    settings: {
      drawable_width: serviceInteger(settings.get(0), "drawable width", true),
      line_height: serviceInteger(settings.get(1), "line height", true),
      background: rgba(settings.get(2)),
      button_focus_foreground: rgba(settings.get(3)),
      maximum_physical_lines: u32(settings.get(4)),
      prevent_button_wrap: boolean(settings.get(5)),
      legacy_nonbutton_wrap: boolean(settings.get(6)),
      drawable_height: serviceInteger(settings.get(7), "drawable height", true),
    },
  };
}
