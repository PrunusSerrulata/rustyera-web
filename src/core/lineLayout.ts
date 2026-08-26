import type { DisplayLine, DisplayRun } from "@/core/types";

/**
 * Returns whether a presentation line is guaranteed to occupy exactly one configured console
 * row. Complex and unknown content deliberately stays on the browser's natural measurement path.
 */
export function usesConfiguredLineHeight(line: DisplayLine | undefined): boolean {
  if (!line) return false;
  if (line.runs.length === 0) return true;
  if (line.runs.length === 1 && line.runs[0]?.type === "separator")
    return !hasLineBreak(line.runs[0].pattern);
  return line.runs.every(isFixedInlineRun);
}

function isFixedInlineRun(run: DisplayRun): boolean {
  switch (run.type) {
    case "text":
    case "text_layout":
      return !hasLineBreak(run.text);
    case "button":
      return run.runs.every(
        (child) =>
          (child.type === "text" || child.type === "text_layout") && !hasLineBreak(child.text),
      );
    default:
      return false;
  }
}

function hasLineBreak(text: string): boolean {
  return /[\r\n\u2028\u2029]/u.test(text);
}
