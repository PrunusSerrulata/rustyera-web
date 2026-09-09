import { describe, expect, it } from "vitest";
import { resolveCurrentSpriteReplay, resolveSpriteReplay } from "@/core/replayResources";

describe("current sprite aliases", () => {
  it("selects the live alias independently of numeric revision ordering", () => {
    const old = { name: "panel", revision: 9007199254740999n, current_alias: false };
    const current = { name: "PANEL", revision: 4n, current_alias: true };
    expect(resolveCurrentSpriteReplay([old, current], "panel")).toBe(current);
    expect(resolveSpriteReplay([old, current], "panel", old.revision)).toBe(old);
  });
  it("does not resurrect a disposed alias from an exact historical drawing", () => {
    const old = { name: "panel", revision: 2, current_alias: false };
    expect(resolveCurrentSpriteReplay([old], "panel")).toBeUndefined();
    expect(resolveSpriteReplay([old], "panel", 2)).toBe(old);
  });
  it("accepts a unique legacy projection and rejects ambiguous legacy/current aliases", () => {
    const legacy = { name: "panel", revision: 2 };
    expect(resolveCurrentSpriteReplay([legacy], "panel")).toBe(legacy);
    expect(() => resolveCurrentSpriteReplay([legacy, { ...legacy, revision: 3 }], "panel")).toThrow(
      "ambiguous",
    );
    expect(() =>
      resolveCurrentSpriteReplay(
        [
          { ...legacy, current_alias: true },
          { ...legacy, revision: 3, current_alias: true },
        ],
        "panel",
      ),
    ).toThrow("multiple current");
  });
});
