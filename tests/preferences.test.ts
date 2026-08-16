import { describe, expect, it } from "vitest";

import { defaultPreferences } from "@/core/types";
import { normalizePreferences } from "@/platform/database";

describe("preference normalization", () => {
  it("follows the game font size unless the accessibility override is enabled", () => {
    expect(defaultPreferences().fontSizeOverridePx).toBeNull();
    expect(
      normalizePreferences({ ...defaultPreferences(), fontSizeOverridePx: null }),
    ).toMatchObject({ fontSizeOverridePx: null, schemaVersion: 5, settings: {} });
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
      schemaVersion: 5,
      settings: { FontSize: "72" },
      fontFamilyOverride: null,
      fontSizeOverridePx: null,
      imageScale: 4,
      masterVolume: 0,
      trustProjectFileMetadata: false,
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
        schemaVersion: 5,
        settings: {},
        fontFamilyOverride: null,
        fontSizeOverridePx: null,
        imageScale: 1.75,
        masterVolume: 0.4,
        trustProjectFileMetadata: false,
      });
    },
  );

  it("migrates schema 3 accessibility overrides into sparse mapped settings", () => {
    expect(
      normalizePreferences({
        ...defaultPreferences(),
        schemaVersion: 3,
        fontFamilyOverride: "Accessible Font",
        fontSizeOverridePx: 100,
        imageScale: 2,
        masterVolume: 0.5,
      }),
    ).toEqual({
      schemaVersion: 5,
      settings: { FontName: "Accessible Font", FontSize: "72" },
      fontFamilyOverride: null,
      fontSizeOverridePx: null,
      imageScale: 2,
      masterVolume: 0.5,
      trustProjectFileMetadata: false,
    });
  });

  it("enables metadata trust only for an explicit schema 4 preference", () => {
    expect(
      normalizePreferences({ ...defaultPreferences(), trustProjectFileMetadata: true }),
    ).toMatchObject({ schemaVersion: 5, trustProjectFileMetadata: true });
    expect(
      normalizePreferences({
        ...defaultPreferences(),
        schemaVersion: 3,
        trustProjectFileMetadata: true,
      }),
    ).toMatchObject({ schemaVersion: 5, trustProjectFileMetadata: false });
  });
});
