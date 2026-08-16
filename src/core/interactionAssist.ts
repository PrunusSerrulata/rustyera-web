import { visitPresentationInteractions, type PresentationState } from "@/core/presentation";
import type { InteractionAssistMode, InteractionToken } from "@/core/types";

export interface AssistedInteraction {
  key: string;
  label: string;
  token: InteractionToken;
}

export interface AssistedInteractionRow {
  rowKey: string;
  items: AssistedInteraction[];
}

interface InteractionDescription {
  text: string[];
  alt: string[];
  resources: string[];
}

export function assistedInteractionRows(state: PresentationState): AssistedInteractionRow[] {
  const seen = new Set<string>();
  const rows = new Map<string, AssistedInteraction[]>();
  visitPresentationInteractions(state, ({ rowKey, interaction, source }) => {
    if (interaction.enabled !== true) return;
    const description =
      source.kind === "run"
        ? describeRuns(source.run.runs ?? [])
        : describeHtmlNodes(source.node.children ?? []);
    const title =
      source.kind === "run"
        ? source.run.title
        : source.node.semantic?.type === "button" || source.node.semantic?.type === "non_button"
          ? source.node.semantic.title
          : undefined;
    const items = rows.get(rowKey) ?? [];
    const added = pushInteraction(
      items,
      seen,
      interaction.token ?? { epoch: interaction.epoch, id: interaction.id },
      interactionLabel(description, title),
    );
    if (added && !rows.has(rowKey)) rows.set(rowKey, items);
  });
  return [...rows].map(([rowKey, items]) => ({ rowKey, items }));
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
): boolean {
  if (!token) return false;
  const key = `${String(token.epoch)}:${String(token.id)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  output.push({ key, label, token });
  return true;
}

function describeRuns(runs: any[]): InteractionDescription {
  const description = emptyDescription();
  const visit = (run: any): void => {
    switch (run?.type) {
      case "text":
      case "text_layout":
        description.text.push(String(run.text ?? ""));
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

function describeHtmlNodes(nodes: any[]): InteractionDescription {
  const description = emptyDescription();
  const visit = (node: any): void => {
    if (node?.type === "text") description.text.push(String(node.text ?? ""));
    if (node?.semantic?.type === "image" && node.semantic.source)
      description.resources.push(String(node.semantic.source));
    for (const child of node?.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return description;
}

function emptyDescription(): InteractionDescription {
  return { text: [], alt: [], resources: [] };
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
