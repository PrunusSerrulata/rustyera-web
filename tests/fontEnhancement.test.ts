import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type DisplayRun } from "@/core/types";
import TextRunGroup from "@/components/TextRunGroup.vue";
import RunRenderer from "@/components/RunRenderer.vue";
import HtmlNode from "@/components/HtmlNode.vue";

const preferences = reactive(defaultPreferences());
const activate = vi.fn();
vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    effectivePreferences: preferences,
    canInteract: true,
    interactionEnabled: () => true,
    replaceFullWidthSpaces: false,
    gameTextStyle: { fontSizePx: 18 },
    presentation: { settings: {}, resources: { sprites: [], canvases: [] } },
    activate,
  }),
}));

const text = {
  type: "text" as const,
  text: "中文 日本語 Aa 012，。",
  style: {
    bold: true,
    italic: false,
    underline: false,
    strikeout: false,
    foreground: { red: 192, green: 128, blue: 64, alpha: 255 },
    font_millipixels: 18000,
  },
} satisfies DisplayRun;

describe("game font enhancement", () => {
  afterEach(() => {
    preferences.fontEnhancement = false;
    activate.mockClear();
  });

  it("updates existing text paint without changing text, style or button activation", async () => {
    const grouped = mount(TextRunGroup, { props: { runs: [text] } });
    const token = { epoch: 1, id: 2 };
    const button = mount(RunRenderer, {
      props: { run: { type: "button", runs: [text], token, value: { type: "integer", value: 1 } } },
    });
    const html = mount(HtmlNode, {
      props: { node: { type: "text", text: text.text } },
    });
    const before = grouped.get("span").attributes("style");
    const htmlBefore = html.text();
    expect(grouped.find(".game-font-enhanced").exists()).toBe(false);
    preferences.fontEnhancement = true;
    await nextTick();
    expect(grouped.get(".game-font-enhanced").text()).toBe(text.text);
    expect(grouped.get("span").attributes("style")).toBe(before);
    expect(html.get(".html-text.game-font-enhanced").text()).toBe(htmlBefore);
    expect(button.get("button").classes()).not.toContain("game-font-enhanced");
    expect(button.get("button .game-font-enhanced").text()).toBe(text.text);
    await button.get("button").trigger("click");
    expect(activate).toHaveBeenCalledWith(token);
    preferences.fontEnhancement = false;
    await nextTick();
    expect(grouped.find(".game-font-enhanced").exists()).toBe(false);
    expect(html.find(".game-font-enhanced").exists()).toBe(false);
    expect(button.find(".game-font-enhanced").exists()).toBe(false);
    grouped.unmount();
    html.unmount();
    button.unmount();
  });

  it("enhances direct text and separators but leaves media and shapes untouched", () => {
    preferences.fontEnhancement = true;
    for (const run of [text, { type: "separator", pattern: "─", style: {} }]) {
      const wrapper = mount(RunRenderer, { props: { run, viewportColumns: 8 } });
      expect(wrapper.classes()).toContain("game-font-enhanced");
      wrapper.unmount();
    }
    for (const run of [
      { type: "image", placement: {}, alt_text: "image" },
      { type: "shape", shape: { kind: "unsupported" } },
    ]) {
      const wrapper = mount(RunRenderer, {
        props: { run },
        global: { stubs: { MediaImage: true } },
      });
      expect(wrapper.find(".game-font-enhanced").exists()).toBe(false);
      wrapper.unmount();
    }
  });
});
