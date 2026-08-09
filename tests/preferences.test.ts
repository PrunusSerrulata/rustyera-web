import { describe, expect, it } from "vitest";

import { defaultPreferences } from "@/core/types";
import { normalizePreferences } from "@/platform/database";

describe("preference normalization", () => {
  it("follows the game font size unless the accessibility override is enabled", () => {
    expect(defaultPreferences().fontSizeOverridePx).toBeNull();
    expect(
      normalizePreferences({ ...defaultPreferences(), fontSizeOverridePx: null }),
    ).toMatchObject({ fontSizeOverridePx: null, schemaVersion: 3 });
  });

  it("clamps every user-controlled numeric projection", () => {
    expect(
      normalizePreferences({
        schemaVersion: 3,
        fontFamilyOverride: "",
        fontSizeOverridePx: 100,
        imageScale: 10,
        masterVolume: -1,
      }),
    ).toEqual({
      schemaVersion: 3,
      fontFamilyOverride: null,
      fontSizeOverridePx: 72,
      imageScale: 4,
      masterVolume: 0,
    });
  });

  it.each([1, 2])(
    "migrates schema %i font overrides without resetting other preferences",
    (schemaVersion) => {
      expect(
        normalizePreferences({
          ...defaultPreferences(),
          schemaVersion,
          fontFamilyOverride: "Legacy Font",
          fontSizeOverridePx: 24,
          imageScale: 1.75,
          masterVolume: 0.4,
        }),
      ).toEqual({
        schemaVersion: 3,
        fontFamilyOverride: null,
        fontSizeOverridePx: null,
        imageScale: 1.75,
        masterVolume: 0.4,
      });
    },
  );

  it("preserves explicit schema 3 accessibility overrides and clamps their size", () => {
    expect(
      normalizePreferences({
        ...defaultPreferences(),
        fontFamilyOverride: "Accessible Font",
        fontSizeOverridePx: 100,
        imageScale: 2,
        masterVolume: 0.5,
      }),
    ).toEqual({
      schemaVersion: 3,
      fontFamilyOverride: "Accessible Font",
      fontSizeOverridePx: 72,
      imageScale: 2,
      masterVolume: 0.5,
    });
  });
});
