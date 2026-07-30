import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GameTooltip from "@/components/GameTooltip.vue";
import { defaultTooltipSettings } from "@/core/presentation";

describe("game tooltip", () => {
  let scope: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    scope = document.createElement("main");
    document.body.append(scope);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("uses the runtime delay, style, line breaks, and duration", async () => {
    const target = document.createElement("button");
    target.dataset.eraTooltip = "first<br>second";
    scope.append(target);
    const settings = {
      ...defaultTooltipSettings(),
      foreground: { red: 1, green: 2, blue: 3, alpha: 255 },
      background: { red: 4, green: 5, blue: 6, alpha: 255 },
      delay_ms: 250,
      duration_ms: 400,
      font_family: "monospace",
      font_millipoints: 11_000,
    };
    const wrapper = mount(GameTooltip, { props: { scope, settings } });

    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 20, clientY: 30 }));
    await vi.advanceTimersByTimeAsync(249);
    expect(document.querySelector(".game-tooltip")).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    const tooltip = document.querySelector<HTMLElement>(".game-tooltip");
    expect(tooltip?.textContent?.trim()).toBe("first\nsecond");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.style.color).toBe("rgb(1, 2, 3)");
    expect(tooltip?.style.backgroundColor).toBe("rgb(4, 5, 6)");
    expect(tooltip?.style.fontFamily).toBe("monospace");
    expect(tooltip?.style.fontSize).toBe("11pt");

    await vi.advanceTimersByTimeAsync(400);
    await nextTick();
    expect(document.querySelector(".game-tooltip")).toBeNull();
    wrapper.unmount();
  });

  it("cancels a pending tooltip when the pointer leaves", async () => {
    const target = document.createElement("span");
    target.dataset.eraTooltip = "plain hint";
    scope.append(target);
    const wrapper = mount(GameTooltip, {
      props: { scope, settings: defaultTooltipSettings() },
    });

    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: scope }));
    await vi.advanceTimersByTimeAsync(500);
    await nextTick();

    expect(document.querySelector(".game-tooltip")).toBeNull();
    wrapper.unmount();
  });

  it("activates from pointer movement when a native WebView omits mouseover", async () => {
    const target = document.createElement("button");
    target.dataset.eraTooltip = "native hint";
    scope.append(target);
    const wrapper = mount(GameTooltip, {
      props: {
        scope,
        settings: { ...defaultTooltipSettings(), delay_ms: 0 },
      },
    });

    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 12 }));
    await nextTick();

    expect(document.querySelector(".game-tooltip")?.textContent?.trim()).toBe("native hint");
    wrapper.unmount();
  });
});
