import type { CSSProperties } from "vue";

import type { DisplayRun, Preferences } from "@/core/types";

export type TextDisplayRun = Extract<DisplayRun, { type: "text" | "text_layout" }>;
type StyledTextDisplayRun = Extract<DisplayRun, { type: "text" | "text_layout" | "separator" }>;

export interface CollectedTextRunGroup {
  runs: TextDisplayRun[];
  nextIndex: number;
}

export function collectTextRunGroup(
  runs: readonly DisplayRun[],
  startIndex: number,
): CollectedTextRunGroup | undefined {
  const first = runs[startIndex];
  if (first?.type !== "text" && first?.type !== "text_layout") return undefined;
  const textRuns: TextDisplayRun[] = [];
  let nextIndex = startIndex;
  while (runs[nextIndex]?.type === "text" || runs[nextIndex]?.type === "text_layout") {
    textRuns.push(runs[nextIndex] as TextDisplayRun);
    nextIndex += 1;
  }
  return { runs: textRuns, nextIndex };
}

type TextPreferences = Pick<Preferences, "fontFamilyOverride" | "fontSizeOverridePx">;

export function textRunStyle(
  run: StyledTextDisplayRun,
  preferences: TextPreferences,
): CSSProperties {
  const style = run.style ?? {};
  const foreground = style.foreground;
  const background = style.background;
  return {
    color: foreground ? `var(--game-interaction-foreground, ${rgba(foreground)})` : undefined,
    backgroundColor: background ? rgba(background) : undefined,
    fontWeight: style.bold ? "bold" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration:
      [style.underline && "underline", style.strikeout && "line-through"]
        .filter(Boolean)
        .join(" ") || undefined,
    fontFamily: preferences.fontFamilyOverride
      ? "var(--game-font)"
      : style.font_family
        ? `${style.font_family}, var(--game-font)`
        : undefined,
    fontSize:
      preferences.fontSizeOverridePx != null
        ? "var(--game-size)"
        : style.font_millipixels
          ? `${Number(style.font_millipixels) / 1000}px`
          : undefined,
  };
}

export function textLayoutStyle(run: TextDisplayRun): CSSProperties | undefined {
  if (run.type !== "text_layout") return undefined;
  return {
    display: "inline-block",
    // The viewport reports columns from the active font's zero advance. Use the
    // same physical cell here so fonts whose half-width advance is not exactly
    // half an em cannot accumulate layout drift across a console row.
    width: `${Math.max(0, Number(run.columns) || 0)}ch`,
    verticalAlign: "top",
  };
}

export function renderedText(run: TextDisplayRun, replaceFullWidthSpaces: boolean): string {
  return replaceFullWidthSpaces ? String(run.text ?? "").replaceAll("　", "  ") : run.text;
}

function rgba(color: { red: number; green: number; blue: number; alpha: number }): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`;
}
