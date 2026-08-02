import { afterEach, describe, expect, it } from "vitest";

import { measureGameViewport } from "@/platform/viewportMeasurement";

describe("game viewport measurement", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  afterEach(() => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: originalInnerWidth },
      innerHeight: { configurable: true, value: originalInnerHeight },
    });
    document.body.replaceChildren();
  });

  it("reports one consistent size, chrome inset, and measured font column count", () => {
    const viewport = document.createElement("main");
    const history = document.createElement("div");
    viewport.append(history);
    document.body.append(viewport);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1120 },
      innerHeight: { configurable: true, value: 840 },
    });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1100 },
      clientHeight: { configurable: true, value: 750 },
    });
    Object.defineProperty(history, "clientWidth", { configurable: true, value: 1000 });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("column-width-probe")) return { width: 100 } as DOMRect;
      return originalBounds.call(this);
    };

    try {
      expect(measureGameViewport(viewport, history)).toEqual({
        width: 1100,
        height: 750,
        lineColumns: 100,
        chromeWidth: 20,
        chromeHeight: 90,
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
    }
  });
});
