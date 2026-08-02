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
          style: { font_family: "Project Font", font_millipixels: 15_000 },
        },
      ],
    },
  ];

  it("uses the project font family and pixel size by default", () => {
    expect(resolveGameTextStyle(defaultPreferences(), lines)).toEqual({
      fontFamily: "Project Font",
      fontSize: "15px",
      fontSizePx: 15,
    });
  });

  it("keeps the accessibility font-size override opt-in", () => {
    expect(
      resolveGameTextStyle({ ...defaultPreferences(), fontSizeOverridePx: 20 }, lines),
    ).toMatchObject({ fontFamily: "Project Font", fontSize: "20px", fontSizePx: 20 });
  });

  it("puts the Chinese application locale before an English OS locale", () => {
    expect(preferredRuntimeLocales(["en-US", "zh-CN"])[0]).toBe("zh-CN");
  });
});
