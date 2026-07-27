import { describe, expect, it } from "vitest";

import { normalizePreferences } from "@/platform/database";

describe("preference normalization", () => {
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
