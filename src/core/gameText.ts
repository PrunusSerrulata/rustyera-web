import type { DisplayLine, Preferences, TextStyle } from "@/core/types";

export interface ResolvedGameTextStyle {
  fontFamily: string;
  fontSize: string;
  fontSizePx: number;
}

export function resolveGameTextStyle(
  preferences: Preferences,
  lines: DisplayLine[],
): ResolvedGameTextStyle {
  const runtimeStyle = latestRuntimeTextStyle(lines);
  const fontSizePx =
    preferences.fontSizeOverridePx ??
    (runtimeStyle?.font_millipixels ? Number(runtimeStyle.font_millipixels) / 1000 : 12);
  return {
    fontFamily: preferences.fontFamilyOverride || runtimeStyle?.font_family || "sans-serif",
    fontSize: `${fontSizePx}px`,
    fontSizePx,
  };
}

export function preferredRuntimeLocales(browserLocales: readonly string[]): string[] {
  // The application chrome is Simplified Chinese, so native runtime prompts must not
  // unexpectedly become English merely because the OS lists English first.
  return ["zh-CN", ...browserLocales.filter((locale) => locale.toLowerCase() !== "zh-cn"), "ja"];
}

function latestRuntimeTextStyle(lines: DisplayLine[]): TextStyle | undefined {
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const style = latestRunStyle(lines[lineIndex].runs);
    if (style) return style;
  }
  return undefined;
}

function latestRunStyle(runs: any[]): TextStyle | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.type === "text" && run.style) return run.style;
    if (run.type === "button") {
      const style = latestRunStyle(run.runs ?? []);
      if (style) return style;
    }
    if (run.type === "column_cell") {
      const style = latestRunStyle(run.content ?? []);
      if (style) return style;
    }
  }
  return undefined;
}
