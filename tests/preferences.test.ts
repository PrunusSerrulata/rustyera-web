import { describe, expect, it } from "vitest";

import { defaultPreferences } from "@/core/types";
import { normalizePreferences } from "@/platform/database";

describe("preference normalization", () => {
  it("follows the game font size unless the accessibility override is enabled", () => {
    expect(defaultPreferences().fontSizeOverridePx).toBeNull();
    expect(
      normalizePreferences({ ...defaultPreferences(), fontSizeOverridePx: null }),
    ).toMatchObject({ fontSizeOverridePx: null, schemaVersion: 2 });
  });

  it("clamps every user-controlled numeric projection", () => {
    expect(
      normalizePreferences({
        schemaVersion: 2,
        fontFamilyOverride: "",
        fontSizeOverridePx: 100,
        imageScale: 10,
        masterVolume: -1,
      }),
    ).toEqual({
      schemaVersion: 2,
      fontFamilyOverride: null,
      fontSizeOverridePx: 72,
      imageScale: 4,
      masterVolume: 0,
    });
  });

  it("removes the legacy implicit twelve-pixel override", () => {
    expect(
      normalizePreferences({
        ...defaultPreferences(),
        schemaVersion: 1,
        fontSizeOverridePx: 12,
      }),
    ).toMatchObject({ schemaVersion: 2, fontSizeOverridePx: null });
  });
});
