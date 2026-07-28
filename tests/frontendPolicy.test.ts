import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({ activate: vi.fn(), effectivePreferences: { imageScale: 1 } }),
}));

import HtmlNode from "@/components/HtmlNode.vue";

describe("frontend host and image-line policy", () => {
  it("grants the Tauri main window permission to close", () => {
    const capability = JSON.parse(
      readFileSync(resolve("src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(capability.permissions).toContain("core:window:allow-close");
  });

  it("renders HTML image paragraphs with the margin-reset selector", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "paragraph",
          children: [{ type: "text", text: "title" }],
        },
      },
    });
    expect(wrapper.get("p.html-node").text()).toBe("title");

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(/\.game-line \.html-node:is\(p\)\s*\{\s*margin:\s*0;/);
  });
});
