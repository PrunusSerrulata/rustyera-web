import { describe, expect, it } from "vitest";

import { defaultPreferences } from "@/core/types";
import { normalizePreferences } from "@/platform/database";

describe("preference normalization", () => {
  it("defaults game text to twelve pixels", () => {
    expect(defaultPreferences().fontSizeOverridePx).toBe(12);
    expect(
      normalizePreferences({ ...defaultPreferences(), fontSizeOverridePx: null }),
    ).toMatchObject({ fontSizeOverridePx: 12 });
  });

  it("clamps every user-controlled numeric projection", () => {
    expect(
      normalizePreferences({
        schemaVersion: 1,
        fontFamilyOverride: "",
        fontSizeOverridePx: 100,
        imageScale: 10,
        masterVolume: -1,
      }),
    ).toEqual({
      schemaVersion: 1,
      fontFamilyOverride: null,
      fontSizeOverridePx: 72,
      imageScale: 4,
      masterVolume: 0,
    });
  });
});
