import type { DisplayLine, TooltipSettings } from "@/core/types";

export interface PresentationState {
  revision: number;
  historyRevision: number;
  title: string;
  lines: DisplayLine[];
  backgrounds: any[];
  audio: any[];
  inputWait: any | null;
  settings: any;
  tooltip: TooltipSettings;
  resources: any;
  htmlIsland: any[];
  redraw: any;
  buttonGeneration: number;
}

export function emptyPresentation(): PresentationState {
  return {
    revision: 0,
    historyRevision: 0,
    title: "RustyEra",
    lines: [],
    backgrounds: [],
    audio: [],
    inputWait: null,
    settings: {},
    tooltip: defaultTooltipSettings(),
    resources: { sprites: [], canvases: [], animation_timer_ms: 0 },
    htmlIsland: [],
    redraw: { enabled: true },
    buttonGeneration: 0,
  };
}

export function applySnapshot(state: PresentationState, snapshot: any): void {
  const nextLines = [...(snapshot.history?.logical_lines ?? [])] as DisplayLine[];
  // A resynchronization snapshot can carry an equal-length dynamic-map tail with new line IDs.
  // Emuera replaces that tail in place, so only actual history growth should request bottom follow.
  if (nextLines.length > state.lines.length) state.historyRevision += 1;
  state.revision = snapshot.revision;
  state.title = snapshot.title;
  state.lines = nextLines;
  state.backgrounds = snapshot.backgrounds ?? [];
  state.audio = snapshot.audio ?? [];
  state.inputWait = snapshot.input_wait ?? null;
  state.settings = snapshot.settings ?? {};
  state.tooltip = snapshot.tooltip ?? defaultTooltipSettings();
  state.resources = snapshot.resources ?? { sprites: [], canvases: [], animation_timer_ms: 0 };
  state.htmlIsland = snapshot.html_island ?? [];
  state.redraw = snapshot.redraw ?? { enabled: true };
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
  if (delta.base_revision !== state.revision) {
    throw new Error(`展示 revision 不连续：${state.revision} → ${delta.base_revision}`);
  }
  const previousLineCount = state.lines.length;
  let existingLineChanged = false;
  for (const operation of delta.operations ?? []) {
    switch (operation.type) {
      case "append_line":
        state.lines.push(operation.line);
        break;
      case "delete_lines":
        state.lines.splice(
          Math.max(0, state.lines.length - Number(operation.count)),
          Number(operation.count),
        );
        break;
      case "clear":
        state.lines = [];
        break;
      case "set_title":
        state.title = operation.title;
        break;
      case "set_backgrounds":
        state.backgrounds = operation.backgrounds;
        break;
      case "set_audio":
        state.audio = operation.audio;
        break;
      case "set_input_wait":
        state.inputWait = operation.input_wait ?? null;
        break;
      case "replace_line": {
        const index = state.lines.findIndex((line) => line.line_id === operation.line_id);
        if (index >= 0) {
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
      case "set_html_island":
        state.htmlIsland = operation.html_island;
        break;
      case "set_redraw":
        state.redraw = operation.redraw;
        break;
      case "set_button_generation":
        state.buttonGeneration = operation.generation;
        disableOldButtons(state.lines, operation.generation);
        break;
      case "trim_lines":
        state.lines.splice(0, Math.min(Number(operation.count), state.lines.length));
        break;
    }
  }
  // Emuera's dynamic-map loop deletes and recreates the same tail rows. Its console keeps the
  // scrollbar unchanged when the final line count is unchanged, so only actual history growth
  // (or an in-place line whose dimensions may change) should request another bottom follow.
  if (state.lines.length > previousLineCount || existingLineChanged) state.historyRevision += 1;
  state.revision = delta.new_revision;
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

function disableOldButtons(lines: DisplayLine[], generation: number): void {
  const visit = (runs: any[]) => {
    for (const run of runs) {
      if (run.type === "button") {
        if (run.generation !== generation) run.enabled = false;
        visit(run.runs);
      } else if (run.type === "column_cell") visit(run.content);
    }
  };
  for (const line of lines) visit(line.runs);
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

function projectedLength(length: any, lineHeight: number): string {
  const value = Number(length?.value ?? 0);
  if (length?.unit === "logical") return `${Math.trunc(value / 1000)}px`;
  if (length?.unit === "pixels") return `${Math.trunc(value)}px`;
  return String(Math.trunc((value * Number(lineHeight)) / 100_000));
}

function rawLength(length: any): string {
  const value = Number(length?.value ?? 0);
  if (length?.unit === "logical") return `${Math.trunc(value / 1000)}px`;
  if (length?.unit === "pixels") return `${Math.trunc(value)}px`;
  return String(Math.trunc(value));
}

function htmlColor(color: any): string {
  return `#${[color.red, color.green, color.blue]
    .map((component) =>
      Number(component ?? 0)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase(),
    )
    .join("")}`;
}

function isDefaultForeground(color: any): boolean {
  return Number(color.red) === 192 && Number(color.green) === 192 && Number(color.blue) === 192;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll(">", "&gt;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
