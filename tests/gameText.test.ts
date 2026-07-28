import { describe, expect, it } from "vitest";

import { preferredRuntimeLocales, resolveGameTextStyle } from "@/core/gameText";
import { defaultPreferences } from "@/core/types";

describe("game text projection", () => {
  const lines: any[] = [
    {
      runs: [
        {
          type: "text",
          text: "body",
          style: { font_family: "Project Font", font_millipoints: 15_000 },
        },
      ],
    },
  ];

  it("uses the game-only twelve pixel default without losing the project family", () => {
    expect(resolveGameTextStyle(defaultPreferences(), lines)).toEqual({
      fontFamily: "Project Font",
      fontSize: "12px",
      fontSizePx: 12,
    });
  });

  it("puts the Chinese application locale before an English OS locale", () => {
    expect(preferredRuntimeLocales(["en-US", "zh-CN"])[0]).toBe("zh-CN");
  });
});
