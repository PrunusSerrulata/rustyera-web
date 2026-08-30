import {
  presentationInteractionEnabled,
  visitPresentationInteractions,
  type PresentationState,
} from "@/core/presentation";
import { isDefaultForeground } from "@/core/presentation/htmlFormat";
import type { InteractionAssistMode, InteractionToken } from "@/core/types";

export interface AssistedInteraction {
  key: string;
  label: string;
  token: InteractionToken;
  color?: string;
}

export interface AssistedInteractionRow {
  rowKey: string;
  items: AssistedInteraction[];
}

interface InteractionDescription {
  text: string[];
  alt: string[];
  resources: string[];
  foreground?: string;
}

export function assistedInteractionRows(state: PresentationState): AssistedInteractionRow[] {
  const seen = new Set<string>();
  const rows = new Map<string, AssistedInteraction[]>();
  visitPresentationInteractions(state, ({ rowKey, interaction, source }) => {
    if (!presentationInteractionEnabled(state, interaction)) return;
    let description: InteractionDescription;
    let title: unknown;
    if (source.kind === "run") {
      description = describeRuns(source.run.runs ?? []);
      title = source.run.title;
    } else if (source.kind === "html") {
      description = describeHtmlNodes(source.node.children ?? [], source.effectiveForeground);
      title =
        source.node.semantic?.type === "button" || source.node.semantic?.type === "non_button"
          ? source.node.semantic.title
          : undefined;
    } else {
      description = describeSceneLayer(source.layer);
      title = source.layer.interaction?.title;
    }
    const items = rows.get(rowKey) ?? [];
    const added = pushInteraction(
      items,
      seen,
      interaction.token ?? { epoch: interaction.epoch, id: interaction.id },
      interactionLabel(description, title),
      description.foreground,
    );
    if (added && !rows.has(rowKey)) rows.set(rowKey, items);
  });
  return [...rows].map(([rowKey, items]) => ({ rowKey, items }));
}

function describeSceneLayer(layer: any): InteractionDescription {
  const description = emptyDescription();
  for (const source of [layer?.source, layer?.interaction?.hover_source]) {
    if (source?.type === "resource" && source.resource_id)
      description.resources.push(String(source.resource_id));
    else if (source?.type === "sprite" && source.sprite_name)
      description.resources.push(String(source.sprite_name));
  }
  return description;
}

export function interactionAssistModeVisible(
  mode: InteractionAssistMode,
  hostKind: "browser" | "tauri",
  mobileBrowser: boolean,
): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return hostKind === "browser" && mobileBrowser;
}

function pushInteraction(
  output: AssistedInteraction[],
  seen: Set<string>,
  token: InteractionToken | undefined,
  label: string,
  color?: string,
): boolean {
  if (!token) return false;
  const key = `${String(token.epoch)}:${String(token.id)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  output.push({ key, label, token, ...(color == null ? {} : { color }) });
  return true;
}

function describeRuns(runs: any[]): InteractionDescription {
  const description = emptyDescription();
  const visit = (run: any): void => {
    switch (run?.type) {
      case "text":
      case "text_layout":
        description.text.push(String(run.text ?? ""));
        if (description.foreground == null && String(run.text ?? "").trim())
          description.foreground = runForeground(run.style?.foreground);
        break;
      case "button":
        for (const child of run.runs ?? []) visit(child);
        break;
      case "column_cell":
        for (const child of run.content ?? []) visit(child);
        break;
      case "html_document": {
        const html = describeHtmlNodes(run.document?.nodes ?? []);
        description.text.push(...html.text);
        description.alt.push(...html.alt);
        description.resources.push(...html.resources);
        description.foreground ??= html.foreground;
        break;
      }
      case "image":
        if (run.alt_text) description.alt.push(String(run.alt_text));
        if (run.placement?.resource_id)
          description.resources.push(String(run.placement.resource_id));
        break;
    }
  };
  for (const run of runs) visit(run);
  return description;
}

function describeHtmlNodes(nodes: any[], inheritedForeground?: unknown): InteractionDescription {
  const description = emptyDescription();
  const visit = (node: any, foreground: unknown): void => {
    const currentForeground =
      node?.semantic?.type === "font" && node.semantic.color != null
        ? node.semantic.color
        : foreground;
    if (node?.type === "text") {
      description.text.push(String(node.text ?? ""));
      if (description.foreground == null && String(node.text ?? "").trim())
        description.foreground = htmlForeground(currentForeground);
    }
    if (node?.semantic?.type === "image" && node.semantic.source)
      description.resources.push(String(node.semantic.source));
    for (const child of node?.children ?? []) visit(child, currentForeground);
  };
  for (const node of nodes) visit(node, inheritedForeground);
  return description;
}

function emptyDescription(): InteractionDescription {
  return { text: [], alt: [], resources: [] };
}

function runForeground(color: any): string | undefined {
  if (color == null || isDefaultForeground(color)) return undefined;
  const red = Number(color.red);
  const green = Number(color.green);
  const blue = Number(color.blue);
  const alpha = color.alpha == null ? 255 : Number(color.alpha);
  if (![red, green, blue, alpha].every(Number.isFinite)) return undefined;
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function htmlForeground(value: unknown): string | undefined {
  if (value == null) return undefined;
  const color = Number(value);
  if (!Number.isFinite(color)) return undefined;
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  if (red === 192 && green === 192 && blue === 192) return undefined;
  return `rgb(${red}, ${green}, ${blue})`;
}

function interactionLabel(description: InteractionDescription, title: unknown): string {
  for (const candidate of [
    description.text.join(""),
    description.alt[0],
    typeof title === "string" ? title : "",
    description.resources[0],
  ]) {
    const normalized = normalizeLabel(candidate);
    if (normalized) return normalized;
  }
  return "未命名交互项";
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
