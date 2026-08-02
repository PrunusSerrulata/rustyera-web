import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    effectivePreferences: { imageScale: 1 },
    gameTextStyle: { fontSizePx: 12 },
    gameLineHeightPx: 18,
    presentation: {
      settings: { line_height: 18_000 },
      resources: { sprites: [], canvases: [] },
    },
  }),
}));

import HtmlNode from "@/components/HtmlNode.vue";

describe("frontend host and image-line policy", () => {
  it("grants both Tauri hosts the window permissions used by the frontend", () => {
    const windowPermissions = [
      "core:window:allow-close",
      "core:window:allow-maximize",
      "core:window:allow-set-position",
      "core:window:allow-set-resizable",
      "core:window:allow-set-size",
      "core:window:allow-unmaximize",
    ];
    const capability = JSON.parse(
      readFileSync(resolve("src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(capability.permissions).toEqual(expect.arrayContaining(windowPermissions));
    const webdriverConfig = JSON.parse(
      readFileSync(resolve("src-tauri/tauri.webdriver.conf.json"), "utf8"),
    );
    const webdriverPermissions = webdriverConfig.app.security.capabilities.find(
      (entry: { identifier: string }) => entry.identifier === "webdriver-test",
    ).permissions;
    expect(webdriverPermissions).toEqual(expect.arrayContaining(windowPermissions));
  });

  it("keeps the Tauri end-to-end window visible to native automation", () => {
    const webdriverConfig = JSON.parse(
      readFileSync(resolve("src-tauri/tauri.webdriver.conf.json"), "utf8"),
    );
    expect(webdriverConfig.app.windows).toContainEqual(
      expect.objectContaining({ label: "main", visible: true }),
    );
  });

  it("does not enable project-specific Tauri specs during the default suite", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    expect(runner).not.toMatch(/VITE_RUSTYERA_TAURI_[A-Z_]+:[\s\S]*?\?\s*"1"\s*:\s*"0"/);
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
      global: { stubs: { MediaImage: true } },
    });
    expect(wrapper.get("p.html-node").text()).toBe("title");

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(/\.game-viewport\s*\{[^}]*scrollbar-width:\s*thin;/s);
    expect(stylesheet).toMatch(/\.game-line \.html-node:is\(p\)\s*\{\s*margin:\s*0;/);
    expect(stylesheet).toMatch(
      /\.game-line:has\(\.media-image, \.canvas-replay\)[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0;[\s\S]*?line-height:\s*var\(--game-line-height\);/,
    );
    expect(stylesheet).toMatch(/\.media-positioned\s*\{\s*overflow:\s*visible;/);
    expect(stylesheet).toMatch(/\.virtual-history\s*\{[^}]*width:\s*100%;/s);
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

  it("reserves one configured console row for an overflowing HTML image", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "image",
          children: [],
          semantic: {
            type: "image",
            source: "portrait",
            height: { unit: "font_height_hundredths", value: 3000 },
            y: { unit: "font_height_hundredths", value: -3000 },
          },
        },
      },
      global: { stubs: { MediaImage: true } },
    });

    expect(wrapper.getComponent({ name: "MediaImage" }).props("placement")).toMatchObject({
      height: 18_000,
      requested_height: { unit: "font_height_hundredths", value: 3000 },
      requested_y: { unit: "font_height_hundredths", value: -3000 },
    });
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
      /\.html-node\.html-node-positioned\s*\{[^}]*display:\s*inline-block;[^}]*position:\s*relative;[^}]*width:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.html-node\.html-node-positioned\.html-positioned-media\s*>\s*br\s*\{[^}]*display:\s*none;/s,
    );
    expect(stylesheet).toMatch(
      /\.html-node\.html-node-positioned:not\(\.html-positioned-media\):has\(> br:last-child\)\s*\{[^}]*padding-bottom:\s*1\.25em;/s,
    );
    expect(stylesheet).not.toMatch(/\.html-node-positioned\s*\{[^}]*position:\s*absolute;/s);
  });

  it("reserves positioned image height instead of accumulating native placeholder breaks", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "non_button",
          semantic: { type: "non_button", position: 0 },
          children: [
            {
              type: "element",
              kind: "image",
              semantic: {
                type: "image",
                source: "background",
                height: { unit: "font_height_hundredths", value: 3000 },
              },
            },
            ...new Array(30).fill(null).map(() => ({ type: "element", kind: "break" })),
          ],
        },
      },
      global: { stubs: { MediaImage: true } },
    });

    const positioned = wrapper.get(".html-node-positioned.html-positioned-media");
    expect(positioned.attributes("style")).toContain("height: 360px");
    expect(positioned.findAll(":scope > br")).toHaveLength(30);
  });

  it("keeps positioned image layers without direct breaks in a single console-row slot", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "non_button",
          semantic: { type: "non_button", position: 0 },
          children: [
            {
              type: "element",
              kind: "image",
              semantic: {
                type: "image",
                source: "portrait-layer",
                height: { unit: "font_height_hundredths", value: 3000 },
              },
            },
          ],
        },
      },
      global: { stubs: { MediaImage: true } },
    });

    const positioned = wrapper.get(".html-node-positioned");
    expect(positioned.classes()).not.toContain("html-positioned-media");
    expect(positioned.attributes("style")).not.toContain("height:");
  });

  it.each([
    ["missing", undefined],
    ["zero", { unit: "font_height_hundredths", value: 0 }],
  ])("keeps placeholder breaks when a positioned image has %s height", (_label, height) => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "non_button",
          semantic: { type: "non_button", position: 0 },
          children: [
            {
              type: "element",
              kind: "image",
              semantic: { type: "image", source: "natural-size", height },
            },
            { type: "element", kind: "break" },
            { type: "element", kind: "break" },
          ],
        },
      },
      global: { stubs: { MediaImage: true } },
    });

    const positioned = wrapper.get(".html-node-positioned");
    expect(positioned.classes()).not.toContain("html-positioned-media");
    expect(positioned.attributes("style")).not.toContain("height:");
    expect(positioned.findAll(":scope > br")).toHaveLength(2);
  });

  it("projects HTML ASCII spaces onto Emuera half-width font cells", () => {
    const wrapper = mount(HtmlNode, {
      props: { node: { type: "text", text: "  image" } },
    });

    const space = wrapper.get<HTMLElement>(".html-ascii-space");
    expect(space.element.textContent).toBe("  ");
    expect(space.attributes("style")).toContain("width: 12px");
    expect(wrapper.element.textContent).toBe("  image");
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
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*min-height:\s*var\(--game-line-height\);/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*margin:\s*0;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*padding:\s*0;/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*line-height:\s*var\(--game-line-height\);/s);
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

  it("uses the embedded Tauri driver without an unsupported external driver", () => {
    const testRunner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const tauriTestConfiguration = JSON.parse(
      readFileSync(resolve("src-tauri/tauri.webdriver.conf.json"), "utf8"),
    );
    expect(testRunner).toMatch(/driverProvider:\s*"embedded"/);
    expect(testRunner).not.toContain("autoInstallTauriDriver");
    expect(testRunner).toMatch(/captureBackendLogs:\s*true/);
    expect(tauriTestConfiguration.app.windows[0].visible).toBe(true);
    expect(testRunner).toContain("startWdioSession(capabilities, { maxInstances: 1 })");
    expect(testRunner).toContain("cleanupWdioSession(browser)");
    expect(testRunner).toContain("const specProfiles =");
    expect(existsSync(resolve("wdio.tauri.conf.mjs"))).toBe(false);
    const packageManifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(packageManifest.devDependencies.mocha).toBeTruthy();
    expect(packageManifest.devDependencies.webdriverio).toBeTruthy();
  });
});
