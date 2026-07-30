import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    effectivePreferences: { imageScale: 1 },
    gameTextStyle: { fontSizePx: 12 },
  }),
}));

import HtmlNode from "@/components/HtmlNode.vue";

describe("frontend host and image-line policy", () => {
  it("grants the Tauri main window permission to close", () => {
    const capability = JSON.parse(
      readFileSync(resolve("src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(capability.permissions).toContain("core:window:allow-close");
  });

  it("keeps the Tauri end-to-end window hidden by default", () => {
    const webdriverConfig = JSON.parse(
      readFileSync(resolve("src-tauri/tauri.webdriver.conf.json"), "utf8"),
    );
    expect(webdriverConfig.app.windows).toContainEqual(
      expect.objectContaining({ label: "main", visible: false }),
    );
  });

  it("builds the release Tauri binary without a Windows console", () => {
    const entrypoint = readFileSync(resolve("src-tauri/src/main.rs"), "utf8");
    expect(entrypoint).toMatch(
      /^#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)\]/,
    );
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
      /\.game-button,[\s\S]*?--game-interaction-hover-background:\s*#ffffff18;[\s\S]*?--game-interaction-border-radius:\s*5px;/,
    );
    expect(stylesheet).toMatch(
      /:is\(\.game-button, \.html-node:is\(button\)\):has\(\.media-positioned\):hover:not\(:disabled\)\s*\{\s*background:\s*transparent;/,
    );
    expect(stylesheet).toMatch(
      /:is\(\.game-button, \.html-node:is\(button\)\):has\(\.media-positioned\):not\(:disabled\)[\s\S]*?> \.media-visual\.media-hovered\s*\{[^}]*border-radius:\s*var\(--game-interaction-border-radius\);[^}]*background:\s*var\(--game-interaction-hover-background\);/s,
    );
  });

  it("projects HTML space shapes before positioned images", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "shape",
          children: [],
          semantic: {
            type: "shape",
            kind: "space",
            parameters: [{ unit: "font_height_hundredths", value: 3600 }],
          },
        },
      },
    });

    expect(wrapper.get(".html-shape-space").attributes("style")).toContain("width: 432px");
    expect(wrapper.get(".html-shape-space").attributes("style")).toContain("height: 12px");
  });

  it("locks positioned HTML buttons to Emuera font-relative horizontal coordinates", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "non_button",
          children: [{ type: "text", text: "layer" }],
          semantic: { type: "non_button", position: 250 },
        },
      },
    });

    const positioned = wrapper.get(".html-node-positioned");
    expect(positioned.text()).toBe("layer");
    expect(positioned.attributes("style")).toContain("left: 30px");
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /\.html-node-positioned\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;/s,
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
