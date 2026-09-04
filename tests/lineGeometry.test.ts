import { afterEach, describe, expect, it, vi } from "vitest";

import { currentLineGeometry } from "@/platform/lineGeometry";

describe("line geometry projection", () => {
  afterEach(() => document.body.replaceChildren());

  it("measures a stable realized line relative to the viewport after scroll", () => {
    const viewport = document.createElement("main");
    viewport.className = "game-viewport";
    const line = document.createElement("div");
    line.className = "game-line";
    line.dataset.lineId = "18446744073709551614";
    viewport.append(line);
    document.body.append(viewport);
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 610,
      x: 0,
      y: 10,
      toJSON: () => ({}),
    });
    vi.spyOn(line, "getBoundingClientRect").mockReturnValue({
      top: 6,
      left: 0,
      width: 800,
      height: 18,
      right: 800,
      bottom: 24,
      x: 0,
      y: 6,
      toJSON: () => ({}),
    });
    expect(currentLineGeometry(viewport, 18446744073709551614n)).toEqual({
      top: -4,
      height: 18,
      viewportHeight: 600,
    });
  });

  it("rejects a trimmed or virtualized-away line instead of fabricating geometry", () => {
    const viewport = document.createElement("main");
    viewport.className = "game-viewport";
    document.body.append(viewport);
    expect(() => currentLineGeometry(viewport, 9)).toThrow("not realized");
  });
});
