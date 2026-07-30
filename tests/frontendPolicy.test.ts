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
    expect(stylesheet).toMatch(
      /\.game-line:has\(\.media-image, \.canvas-replay\)[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0;[\s\S]*?line-height:\s*0;/,
    );
    expect(stylesheet).toMatch(/\.media-positioned\s*\{\s*overflow:\s*visible;/);
    expect(stylesheet).toMatch(
      /\.game-line:has\(\.media-positioned\)\s*\{[^}]*contain:\s*layout;[^}]*overflow:\s*visible;[^}]*z-index:\s*1;/s,
    );
    expect(stylesheet).toMatch(
      /\.media-positioned > \.media-visual\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /:is\(\.game-button, \.html-node:is\(button\)\):hover:not\(:disabled\)[\s\S]*?\.media-positioned\s*> \.media-visual,[\s\S]*?:is\(\.game-button, \.html-node:is\(button\)\):not\(:disabled\)[\s\S]*?\.media-positioned\s*> \.media-visual\.media-hovered\s*\{\s*background:\s*#ffffff18;/,
    );
  });

  it("styles timestamps and fixed-width log levels like the TUI", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /\.log-list time\s*\{[^}]*color:\s*#00c853;[^}]*font-weight:\s*700;/s,
    );
    expect(stylesheet).toMatch(/\.log-list \.error \.log-level\s*\{\s*color:\s*#ff0000;/);
    expect(stylesheet).toMatch(/\.log-list \.warning \.log-level\s*\{\s*color:\s*#ffbf00;/);
    expect(stylesheet).toMatch(/\.log-list \.info \.log-level\s*\{\s*color:\s*#ffffff;/);
    expect(stylesheet).toMatch(/\.log-list \.debug \.log-level\s*\{\s*color:\s*#a0a0a0;/);
    expect(stylesheet).toMatch(/\.log-list\s*\{[^}]*list-style:\s*none;/s);
    expect(stylesheet).toMatch(/\.log-list li\s*\{[^}]*white-space:\s*pre;/s);
  });

  it("keeps game output on physical lines and exposes horizontal overflow", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(/\.game-viewport\s*\{[^}]*overflow:\s*auto;/s);
    expect(stylesheet).toMatch(/\.game-viewport\s*\{[^}]*overflow-anchor:\s*none;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*width:\s*max-content;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*min-height:\s*1em;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*margin:\s*0;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*padding:\s*0 0 1px;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*line-height:\s*1;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*white-space:\s*pre;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*overflow-wrap:\s*normal;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*pointer-events:\s*none;/s);
    expect(stylesheet).toMatch(
      /\.game-line:has\(\.media-image, \.canvas-replay\)[^}]*padding:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.media-image,[\s\S]*?\.canvas-replay\s*\{[^}]*pointer-events:\s*auto;/s,
    );
  });
});
