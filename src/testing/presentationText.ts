import { plainRun } from "@/core/presentation";
import type { DisplayLine } from "@/core/types";

// Test observations include canonical HTML text independently of the virtual DOM window.
export function observedLineText(line: DisplayLine): string {
  return line.runs.map(observedRunText).join("");
}

function observedRunText(run: any): string {
  if (run.type === "html_document")
    return (run.document?.nodes ?? []).map(observedHtmlText).join("");
  if (run.type === "button") return (run.runs ?? []).map(observedRunText).join("");
  if (run.type === "column_cell") return (run.content ?? []).map(observedRunText).join("");
  return plainRun(run);
}

function observedHtmlText(node: any): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type !== "element") return "";
  if (node.kind === "break") return "\n";
  return (node.children ?? []).map(observedHtmlText).join("");
}
