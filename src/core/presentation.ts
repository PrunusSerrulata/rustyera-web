import type { DisplayLine } from "@/core/types";

export interface PresentationState {
  revision: number;
  historyRevision: number;
  title: string;
  lines: DisplayLine[];
  backgrounds: any[];
  audio: any[];
  inputWait: any | null;
  settings: any;
  tooltip: any;
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
    tooltip: {},
    resources: { sprites: [], canvases: [], animation_timer_ms: 0 },
    htmlIsland: [],
    redraw: { enabled: true },
    buttonGeneration: 0,
  };
}

export function applySnapshot(state: PresentationState, snapshot: any): void {
  const previousLast = state.lines.at(-1);
  const nextLines = [...(snapshot.history?.logical_lines ?? [])] as DisplayLine[];
  const nextLast = nextLines.at(-1);
  if (
    nextLines.length > state.lines.length ||
    nextLast?.line_id !== previousLast?.line_id ||
    lineContentChanged(previousLast, nextLast)
  ) {
    state.historyRevision += 1;
  }
  state.revision = snapshot.revision;
  state.title = snapshot.title;
  state.lines = nextLines;
  state.backgrounds = snapshot.backgrounds ?? [];
  state.audio = snapshot.audio ?? [];
  state.inputWait = snapshot.input_wait ?? null;
  state.settings = snapshot.settings ?? {};
  state.tooltip = snapshot.tooltip ?? {};
  state.resources = snapshot.resources ?? { sprites: [], canvases: [], animation_timer_ms: 0 };
  state.htmlIsland = snapshot.html_island ?? [];
  state.redraw = snapshot.redraw ?? { enabled: true };
}

export function applyDelta(state: PresentationState, delta: any): void {
  if (delta.base_revision !== state.revision) {
    throw new Error(`展示 revision 不连续：${state.revision} → ${delta.base_revision}`);
  }
  let historyChanged = false;
  for (const operation of delta.operations ?? []) {
    switch (operation.type) {
      case "append_line":
        state.lines.push(operation.line);
        historyChanged = true;
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
          historyChanged ||= lineContentChanged(state.lines[index], operation.line);
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
  if (historyChanged) state.historyRevision += 1;
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
      return `text:${run.text}`;
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
