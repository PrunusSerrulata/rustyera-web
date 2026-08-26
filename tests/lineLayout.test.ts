import { describe, expect, it } from "vitest";

import { usesConfiguredLineHeight } from "@/core/lineLayout";

const style = {
  foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  font_millipixels: 0,
};

function line(runs: any[]): any {
  return { line_id: 1, alignment: "left", runs };
}

describe("configured console line height", () => {
  it("accepts empty, plain text, and plain button rows", () => {
    expect(usesConfiguredLineHeight(line([]))).toBe(true);
    expect(
      usesConfiguredLineHeight(
        line([
          { type: "text", text: "command ", style },
          {
            type: "button",
            runs: [{ type: "text_layout", text: "[  0] 爱抚", columns: 12, style }],
          },
        ]),
      ),
    ).toBe(true);
    expect(usesConfiguredLineHeight(line([{ type: "separator", pattern: "-", style }]))).toBe(true);
  });

  it("rejects content whose natural height can span multiple console rows", () => {
    expect(usesConfiguredLineHeight(line([{ type: "text", text: "first\nsecond", style }]))).toBe(
      false,
    );
    expect(
      usesConfiguredLineHeight(line([{ type: "text", text: "first\u2028second", style }])),
    ).toBe(false);
    expect(
      usesConfiguredLineHeight(line([{ type: "text", text: "first\u2029second", style }])),
    ).toBe(false);
    expect(
      usesConfiguredLineHeight(
        line([
          {
            type: "text",
            text: "large inline glyphs still use the configured line box",
            style: { ...style, font_millipixels: 24_000, font_family: "custom" },
          },
        ]),
      ),
    ).toBe(true);
    expect(
      usesConfiguredLineHeight(line([{ type: "html_document", document: { nodes: [] } }])),
    ).toBe(false);
    expect(usesConfiguredLineHeight(line([{ type: "image", placement: {} }]))).toBe(false);
    expect(
      usesConfiguredLineHeight(
        line([{ type: "column_cell", content: [], alignment: "left", preferred_columns: 10 }]),
      ),
    ).toBe(false);
    expect(
      usesConfiguredLineHeight(
        line([
          { type: "separator", pattern: "-", style },
          { type: "text", text: "tail", style },
        ]),
      ),
    ).toBe(false);
  });
});
