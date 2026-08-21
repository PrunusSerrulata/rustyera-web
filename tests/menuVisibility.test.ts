import { describe, expect, it } from "vitest";

import {
  menuVisibilityMode,
  menuVisibleAtHeight,
  normalizeMenuSetting,
  normalizeMenuVisibilityMode,
} from "@/core/menuVisibility";

describe("menu visibility policy", () => {
  it.each([
    ["SHOW", "SHOW"],
    ["auto", "AUTO"],
    ["YES", "AUTO"],
    ["TRUE", "AUTO"],
    ["1", "AUTO"],
    ["前", "AUTO"],
    ["NO", "HIDE"],
    ["false", "HIDE"],
    ["0", "HIDE"],
    ["後", "HIDE"],
  ] as const)("normalizes %s to %s", (value, expected) => {
    expect(normalizeMenuVisibilityMode(value)).toBe(expected);
  });

  it("uses automatic mode for missing values and drops invalid sparse overrides", () => {
    expect(menuVisibilityMode(undefined)).toBe("AUTO");
    expect(normalizeMenuSetting({ UseMenu: "sometimes", FontSize: "20" })).toEqual({
      FontSize: "20",
    });
    expect(normalizeMenuSetting({ UseMenu: "YES" })).toEqual({ UseMenu: "AUTO" });
    expect(normalizeMenuSetting({ UseMenu: "NO" })).toEqual({ UseMenu: "HIDE" });
    expect(normalizeMenuSetting({ UseMenu: "前" })).toEqual({ UseMenu: "AUTO" });
    expect(normalizeMenuSetting({ UseMenu: "後" })).toEqual({ UseMenu: "HIDE" });
  });

  it("hides automatic menus only below 480 CSS pixels", () => {
    expect(menuVisibleAtHeight("SHOW", 100)).toBe(true);
    expect(menuVisibleAtHeight("AUTO", 479.99)).toBe(false);
    expect(menuVisibleAtHeight("AUTO", 480)).toBe(true);
    expect(menuVisibleAtHeight("HIDE", 1_000)).toBe(false);
  });
});
