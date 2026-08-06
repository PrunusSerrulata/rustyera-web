import { describe, expect, it, vi } from "vitest";

import { queryBrowserSystemFonts } from "@/platform/browserBridge";

describe("browser system font access", () => {
  it("reports unsupported browsers without inventing font options", async () => {
    await expect(queryBrowserSystemFonts(undefined)).resolves.toEqual({ kind: "unsupported" });
  });

  it("normalizes real font families with stable case-insensitive deduplication", async () => {
    const query = vi.fn(async () => [
      { family: " Beta Serif ", fullName: "Beta Serif Regular" },
      { family: "Alpha Sans", fullName: "Alpha Sans Regular" },
      { family: "alpha sans", fullName: "Alpha Sans Bold" },
      { family: " ", fullName: "Nameless" },
    ]);

    await expect(queryBrowserSystemFonts(query)).resolves.toEqual({
      kind: "ready",
      fonts: ["Alpha Sans", "Beta Serif"],
    });
  });

  it.each(["NotAllowedError", "SecurityError"])(
    "maps %s to a retryable permission denial",
    async (name) => {
      const query = vi.fn(async () => {
        throw new DOMException("blocked", name);
      });

      await expect(queryBrowserSystemFonts(query)).resolves.toEqual({ kind: "denied" });
    },
  );

  it("maps unexpected host failures without throwing into shared state", async () => {
    const query = vi.fn(async () => {
      throw new Error("font service unavailable");
    });

    await expect(queryBrowserSystemFonts(query)).resolves.toEqual({
      kind: "error",
      message: "font service unavailable",
    });
  });
});
