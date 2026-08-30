import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { describe, expect, it, vi } from "vitest";

const runtimeTextPolicy = vi.hoisted(() => ({ replaceFullWidthSpaces: false }));
const reactiveRuntimeTextPolicy = reactive(runtimeTextPolicy);

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    canInteract: true,
    interactionEnabled: (interaction: any) => interaction.enabled === true,
    effectivePreferences: { imageScale: 1 },
    gameTextStyle: { fontSizePx: 12 },
    gameLineHeightPx: 18,
    presentation: {
      settings: { line_height: 18_000 },
      resources: { sprites: [], canvases: [] },
    },
    get replaceFullWidthSpaces() {
      return reactiveRuntimeTextPolicy.replaceFullWidthSpaces;
    },
  }),
}));

import HtmlNode from "@/components/HtmlNode.vue";
import RunRenderer from "@/components/RunRenderer.vue";
import { RuntimePointerObservation } from "@/platform/pointerObservation";

describe("frontend host and image-line policy", () => {
  it("keeps a button's accessible name intact across per-character layout runs", () => {
    const label = "SNAKE_POINTER_TARGET";
    const wrapper = mount(RunRenderer, {
      props: {
        run: {
          type: "button",
          token: { epoch: 4, id: 1 },
          enabled: true,
          runs: [...label].map((text) => ({ type: "text_layout", text, columns: 1, style: {} })),
        },
      },
    });
    try {
      const button = wrapper.get("button");
      expect(button.findAll(".text-layout")).toHaveLength(label.length);
      expect(button.attributes("aria-label")).toBe(label);
    } finally {
      wrapper.unmount();
    }
  });

  it("hotly replaces full-width spaces in ordinary and HTML text without changing source", async () => {
    const run = { type: "text", text: "A　B", style: {} };
    const node = { type: "text", text: "C　D" };
    reactiveRuntimeTextPolicy.replaceFullWidthSpaces = false;
    const ordinary = mount(RunRenderer, { props: { run } });
    const html = mount(HtmlNode, { props: { node }, global: { stubs: { MediaImage: true } } });
    expect(ordinary.element.textContent).toBe("A　B");
    expect(html.element.textContent).toBe("C　D");

    reactiveRuntimeTextPolicy.replaceFullWidthSpaces = true;
    ordinary.vm.$forceUpdate();
    html.vm.$forceUpdate();
    await nextTick();
    expect(ordinary.element.textContent).toBe("A  B");
    expect(html.element.textContent).toBe("C  D");
    expect(run.text).toBe("A　B");
    expect(node.text).toBe("C　D");
  });

  it("registers script button values from both renderers independently of DOM labels", async () => {
    const viewport = document.createElement("main");
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 200 },
    });
    const bounds = vi
      .spyOn(viewport, "getBoundingClientRect")
      .mockReturnValue({ left: 0, top: 0 } as DOMRect);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const originalHit = document.elementFromPoint;
    let hit: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    const ordinary = mount(RunRenderer, {
      attachTo: viewport,
      props: {
        run: {
          type: "button",
          token: { epoch: 4, id: 1 },
          value: { type: "integer", value: 300 },
          enabled: true,
          runs: [{ type: "text", text: "not 300", style: {} }],
        },
      },
    });
    const html = mount(HtmlNode, {
      attachTo: viewport,
      props: {
        node: {
          type: "element",
          kind: "button",
          semantic: { type: "button" },
          interaction: { epoch: 4, id: 2, string_value: "001", enabled: true },
          children: [{ type: "text", text: "not 001" }],
        },
      },
    });
    const pointer = new RuntimePointerObservation(() => viewport);
    pointer.start();
    let htmlMounted = true;
    try {
      await nextTick();
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 20 }));
      hit = ordinary.get("button").element;
      expect(pointer.sample(4).buttonValue).toBe("300");
      await ordinary.setProps({ run: { ...ordinary.props("run"), enabled: false } });
      expect(ordinary.get("button").attributes("disabled")).toBeDefined();
      expect(pointer.sample(4).buttonValue).toBe("300");
      hit = html.get("button").element;
      expect(pointer.sample(4).buttonValue).toBe("001");
      const node = html.props("node");
      await html.setProps({
        node: { ...node, interaction: { ...node.interaction, enabled: false } },
      });
      expect(html.get("button").attributes("disabled")).toBeDefined();
      expect(pointer.sample(4).buttonValue).toBe("001");
      html.unmount();
      htmlMounted = false;
      expect(pointer.sample(4).buttonValue).toBe("");
    } finally {
      pointer.stop();
      ordinary.unmount();
      if (htmlMounted) html.unmount();
      viewport.remove();
      focus.mockRestore();
      bounds.mockRestore();
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalHit,
      });
    }
  });

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

  it("keeps the native window dark before the Vue frontend paints", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const productionConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const webdriverConfig = JSON.parse(
      readFileSync(resolve("src-tauri/tauri.webdriver.conf.json"), "utf8"),
    );

    expect(stylesheet).toMatch(/:root\s*\{[^}]*background:\s*#101114;/s);
    expect(productionConfig.app.windows[0].backgroundColor).toBe("#101114");
    // The WebDriver config replaces the complete windows array during Tauri's JSON merge.
    expect(webdriverConfig.app.windows[0].backgroundColor).toBe("#101114");
  });

  it("does not enable project-specific Tauri specs during the default suite", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    expect(runner).not.toMatch(/VITE_RUSTYERA_TAURI_[A-Z_]+:[\s\S]*?\?\s*"1"\s*:\s*"0"/);
  });

  it("selects native fetch before loading the Tauri WebDriver service", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    const environmentIndex = runner.indexOf("Object.assign(process.env, environment)");
    const serviceImportIndex = runner.indexOf('await import("@wdio/tauri-service")');

    expect(runner).toContain('WDIO_USE_NATIVE_FETCH: "1"');
    expect(environmentIndex).toBeGreaterThanOrEqual(0);
    expect(serviceImportIndex).toBeGreaterThan(environmentIndex);
  });

  it("stops the Tauri suite at its first failing spec", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    expect(runner).toContain('new Mocha({ reporter: "spec", timeout: 300_000, bail: true })');
  });

  it("gives the reraconfig Tauri spec a deterministic schema-v1 project copy", () => {
    const runner = readFileSync(resolve("scripts/tauri-test.mjs"), "utf8");
    expect(runner).toContain("normalizeReraconfig: true");
    expect(runner).toContain('.replace(/^schema_version\\s*=.*$/m, "schema_version = 1")');
    expect(runner).toContain("replace_full_width_spaces");
    expect(runner).toContain("character_width_mode");
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
      /\.game-line:has\(\.media-positioned\)\s*\{[^}]*overflow:\s*visible;/s,
    );
    expect(stylesheet).not.toMatch(/\.virtual-history\s*\{[^}]*z-index:/s);
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

  it("uses the selected color for button text without decorating buttons", () => {
    const wrapper = mount(RunRenderer, {
      props: {
        run: {
          type: "button",
          enabled: true,
          token: { epoch: 1, id: 1 },
          runs: [
            {
              type: "text",
              text: "choice",
              style: {
                foreground: { red: 12, green: 34, blue: 56, alpha: 255 },
                underline: false,
                strikeout: false,
              },
            },
          ],
        },
      },
    });
    const button = wrapper.get("button");
    expect(button.attributes("disabled")).toBeUndefined();
    const text = button.get("span");
    expect(text.attributes("style")).toContain(
      "color: var(--game-interaction-foreground, rgba(12, 34, 56, 1))",
    );

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const buttonRule = stylesheet.match(
      /\.game-button,\s*\.html-node:is\(button\)\s*\{(?<body>[^}]*)\}/,
    );
    expect(buttonRule?.groups?.body).toContain("appearance: none");
    expect(buttonRule?.groups?.body).toContain("text-decoration: none");
    expect(buttonRule?.groups?.body).not.toContain("text-decoration: underline");
    expect(stylesheet).toMatch(
      /:is\(\.game-button, \.html-node:is\(button\)\):hover:not\(:disabled\)\s*\{[^}]*--game-interaction-foreground:\s*var\(--game-focus\);[^}]*color:\s*var\(--game-interaction-foreground\);/s,
    );
    wrapper.unmount();
  });

  it("projects Era HTML normal and focused font colors", () => {
    const font = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "font",
          semantic: {
            type: "font",
            face: "ＭＳ ゴシック",
            color: 0xc07070,
            button_color: 0x70c070,
          },
          children: [{ type: "text", text: "▮▮" }],
        },
      },
    }).get<HTMLElement>(".html-font");
    expect(font.text()).toBe("▮▮");
    expect(font.attributes("style")).toContain(
      "color: var(--game-interaction-foreground, rgb(192, 112, 112))",
    );
    expect(font.attributes("style")).toContain("--game-button-foreground: rgb(112, 192, 112)");
    expect(font.attributes("style")).toContain("font-family: ＭＳ ゴシック, var(--game-font)");

    const inherited = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "font",
          semantic: { type: "font", face: null, color: null, button_color: null },
          children: [{ type: "text", text: "default" }],
        },
      },
    }).get<HTMLElement>(".html-font");
    expect(inherited.attributes("style")).toContain(
      "color: var(--game-interaction-foreground, inherit)",
    );
    expect(inherited.attributes("style")).toContain("--game-button-foreground: var(--game-focus)");

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /:is\(\.game-button, \.html-node:is\(button\)\):hover:not\(:disabled\) \.html-font\s*\{[^}]*--game-interaction-foreground:\s*var\(--game-button-foreground\);/s,
    );
  });

  it("layers simple relative Era HTML divisions without advancing the row", () => {
    const division = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "division",
          semantic: {
            type: "division",
            x: { unit: "font_height_hundredths", value: 50 },
            y: { unit: "pixels", value: 3 },
            width: { unit: "font_height_hundredths", value: 400 },
            height: { unit: "font_height_hundredths", value: 400 },
            depth: 0,
            color: 0x010203,
            relative: true,
            box_model: {},
          },
          children: [{ type: "text", text: "portrait" }],
        },
      },
    });
    expect(division.get(".html-division").text()).toBe("portrait");
    expect(division.get(".html-division-visual").attributes("style")).toContain("left: 6px");
    expect(division.get(".html-division-visual").attributes("style")).toContain("top: 3px");
    expect(division.get(".html-division-visual").attributes("style")).toContain("width: 48px");
    expect(division.get(".html-division-visual").attributes("style")).toContain("height: 48px");
    expect(division.get(".html-division-visual").attributes("style")).toContain("z-index: 0");
    expect(division.get(".html-division-visual").attributes("style")).toContain(
      "background-color: rgb(1, 2, 3)",
    );

    const bordered = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "division",
          semantic: {
            type: "division",
            x: { unit: "font_height_hundredths", value: 2450 },
            y: null,
            width: { unit: "pixels", value: 640 },
            height: { unit: "pixels", value: 600 },
            depth: 1,
            color: null,
            relative: true,
            box_model: {
              border: Array(4).fill({ unit: "pixels", value: 1 }),
              border_colors: Array(4).fill(0xc0c0c0),
            },
          },
          children: [{ type: "text", text: "portrait" }],
        },
      },
    });
    const borderedStyle = bordered.get(".html-division-visual").attributes("style");
    expect(borderedStyle).toContain("left: 294px");
    expect(borderedStyle).toContain("border-style: solid");
    expect(borderedStyle).toContain("border-width: 1px");
    expect(borderedStyle).toContain("border-color: rgb(192, 192, 192)");
    expect(borderedStyle).toContain("z-index: -1");

    const margined = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "division",
          semantic: {
            type: "division",
            x: { unit: "pixels", value: 10 },
            y: { unit: "pixels", value: 20 },
            width: { unit: "pixels", value: 100 },
            height: { unit: "pixels", value: 80 },
            depth: 2,
            color: null,
            relative: true,
            box_model: {
              margin: [1, 2, 3, 4].map((value) => ({ unit: "pixels", value })),
              padding: Array(4).fill({ unit: "pixels", value: 5 }),
              border: Array(4).fill({ unit: "pixels", value: 1 }),
            },
          },
          children: [{ type: "text", text: "margined" }],
        },
      },
    });
    const marginedStyle = margined.get(".html-division-visual").attributes("style");
    expect(marginedStyle).toContain("left: 14px");
    expect(marginedStyle).toContain("top: 21px");
    expect(marginedStyle).toContain("width: 94px");
    expect(marginedStyle).toContain("height: 76px");
    expect(marginedStyle).toContain("border-width: 1px");
    expect(marginedStyle).toContain("padding: 5px");
    expect(marginedStyle).toContain("z-index: -1");

    for (const semantic of [
      {
        type: "division",
        x: null,
        y: null,
        width: { unit: "pixels", value: 10 },
        height: { unit: "pixels", value: 10 },
        depth: 0,
        color: null,
        relative: false,
        box_model: {},
      },
      {
        type: "division",
        x: null,
        y: null,
        width: { unit: "pixels", value: 10 },
        height: { unit: "pixels", value: 10 },
        depth: 0,
        color: null,
        relative: true,
        box_model: { padding: [{ unit: "pixels", value: 1 }] },
      },
    ]) {
      const unsupported = mount(HtmlNode, {
        props: {
          node: {
            type: "element",
            kind: "division",
            semantic,
            children: [{ type: "text", text: "fallback" }],
          },
        },
      });
      expect(unsupported.find(".html-division").exists()).toBe(false);
      expect(unsupported.get("div.html-node").text()).toBe("fallback");
    }

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /\.html-division\s*\{[^}]*display:\s*inline-block;[^}]*position:\s*relative;[^}]*width:\s*0;[^}]*height:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.html-division-visual\s*\{[^}]*position:\s*absolute;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("falls back temporary runtime fonts to the configured game font", () => {
    const wrapper = mount(RunRenderer, {
      props: {
        run: {
          type: "text",
          text: "map",
          style: { font_family: "ＭＳ ゴシック" },
        },
      },
    });

    expect(wrapper.get("span").attributes("style")).toContain(
      "font-family: ＭＳ ゴシック, var(--game-font)",
    );
  });

  it("gives special glyphs and equivalent ASCII font-independent runtime advance", () => {
    const render = (text: string) =>
      mount(RunRenderer, {
        props: {
          run: {
            type: "text_layout",
            text,
            columns: 2,
            style: {},
          },
        },
      }).get("span");

    const ambiguous = render("■");
    const sun = render("☀");
    const heart = render("❤");
    const greek = render("γ");
    const cyrillic = render("ф");
    const mathematical = render("∬");
    const ascii = render("- ");
    const trailingSpace = mount(RunRenderer, {
      props: {
        run: { type: "text_layout", text: " ", columns: 0, style: {} },
      },
    }).get("span");
    expect(ambiguous.classes()).toContain("text-layout");
    expect(ambiguous.attributes("data-columns")).toBe("2");
    for (const segment of [ambiguous, sun, heart, greek, cyrillic, mathematical, ascii])
      expect(segment.attributes("style")).toContain("width: 2ch");
    expect(trailingSpace.attributes("style")).toContain("width: 0ch");
    for (const segment of [ambiguous, sun, heart, greek, cyrillic, mathematical, ascii])
      expect(segment.attributes("style")).toContain("vertical-align: top");
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

  it("projects Era HTML rectangles with normal and focused colors", () => {
    const wrapper = mount(HtmlNode, {
      props: {
        node: {
          type: "element",
          kind: "shape",
          children: [],
          semantic: {
            type: "shape",
            kind: "rect",
            parameters: [
              { unit: "font_height_hundredths", value: 50 },
              { unit: "font_height_hundredths", value: 25 },
              { unit: "font_height_hundredths", value: 500 },
              { unit: "font_height_hundredths", value: 36 },
            ],
            color: 0xc07070,
            button_color: 0x70c070,
          },
        },
      },
    });

    expect(wrapper.get(".html-shape-rect").attributes("style")).toContain("width: 66px");
    expect(wrapper.get(".html-shape-rect").attributes("style")).toContain("height: 12px");
    const visual = wrapper.get(".html-shape-rect-visual");
    expect(visual.attributes("style")).toContain("left: 6px");
    expect(visual.attributes("style")).toContain("top: 3px");
    expect(visual.attributes("style")).toContain("width: 60px");
    expect(visual.attributes("style")).toContain("height: 4.32px");
    expect(visual.attributes("style")).toContain(
      "background-color: var(--game-shape-foreground, rgb(192, 112, 112))",
    );
    expect(visual.attributes("style")).toContain(
      "--game-button-shape-foreground: rgb(112, 192, 112)",
    );

    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const slotRule = stylesheet.match(/:is\(\.shape-rect, \.html-shape-rect\)\s*\{([^}]*)\}/s)?.[1];
    expect(slotRule).toMatch(/display:\s*inline-block;/);
    expect(slotRule).toMatch(/position:\s*relative;/);
    expect(slotRule).toMatch(/vertical-align:\s*top;/);
    expect(slotRule).not.toMatch(/border:/);
    const visualRule = stylesheet.match(
      /(?:^|\n):is\(\.shape-rect-visual, \.html-shape-rect-visual\)\s*\{([^}]*)\}/s,
    )?.[1];
    expect(visualRule).toMatch(/position:\s*absolute;/);
    expect(visualRule).toMatch(/pointer-events:\s*none;/);
    expect(visualRule).not.toMatch(/border:/);
    expect(stylesheet).not.toMatch(/(?:^|\n)\.shape\s*\{[^}]*border:/s);
    const hoverRule = stylesheet.match(
      /:is\(\.game-button, \.html-node:is\(button\)\):hover:not\(:disabled\)\s+:is\(\.shape-rect-visual, \.html-shape-rect-visual\)\s*\{([^}]*)\}/s,
    )?.[1];
    expect(hoverRule).toMatch(/--game-shape-foreground:\s*var\(--game-button-shape-foreground\);/);
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
            color_matrix: {
              type: "fixed",
              value: Array.from({ length: 25 }, (_, index) => (index % 6 === 0 ? 256 : 0)),
            },
          },
        },
      },
      global: { stubs: { MediaImage: true } },
    });

    expect(wrapper.getComponent({ name: "MediaImage" }).props("placement")).toMatchObject({
      height: 18_000,
      requested_height: { unit: "font_height_hundredths", value: 3000 },
      requested_y: { unit: "font_height_hundredths", value: -3000 },
      color_matrix: { type: "fixed" },
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

  it("projects HTML ASCII spaces onto the active console cells", () => {
    const wrapper = mount(HtmlNode, {
      props: { node: { type: "text", text: "  image" } },
    });

    const space = wrapper.get<HTMLElement>(".html-ascii-space");
    expect(space.element.textContent).toBe("  ");
    expect(space.attributes("style")).toContain("width: 2ch");
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

  it("keeps settings controls flat and the color disk saturated at its edge", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(stylesheet).toMatch(/--settings-control-height:\s*2\.25rem/);
    expect(stylesheet).toMatch(
      /\.setting-control > input:not\(\[type="checkbox"\]\):not\(\[type="range"\]\),[\s\S]*?height:\s*var\(--settings-control-height/,
    );
    expect(stylesheet).toMatch(
      /\.range-setting-control input\[type="range"\]\s*\{[^}]*border:\s*0;/s,
    );
    expect(stylesheet).toMatch(/radial-gradient\(circle closest-side, #fff 0%, #fff0 100%\)/);
  });

  it("keeps preference labels and override status columns stable", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const labelRule = stylesheet.match(/\.preference-setting-label\s*\{([^}]*)\}/s)?.[1];
    const statusRule = stylesheet.match(/\.preference-setting-label small\s*\{([^}]*)\}/s)?.[1];
    expect(labelRule).toMatch(/display:\s*grid;/);
    expect(labelRule).toMatch(/grid-template-columns:\s*1\.2rem max-content 3em;/);
    expect(statusRule).toMatch(/width:\s*3em;/);
    expect(statusRule).toMatch(/white-space:\s*nowrap;/);
    expect(statusRule).toMatch(/text-align:\s*left;/);
    expect(stylesheet).toMatch(
      /\.setting-control\.preference-setting-control\s*\{[^}]*width:\s*auto;/s,
    );
    expect(stylesheet).toMatch(
      /\.preference-image-scale-setting\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);/s,
    );
    expect(stylesheet).toMatch(
      /\.preference-interaction-assist-setting\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);[^}]*align-items:\s*center;/s,
    );
    expect(stylesheet).toMatch(
      /\.preference-interaction-assist-setting > label\s*\{[^}]*padding-top:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.preference-color-setting > \.preference-setting-label\s*\{[^}]*padding-top:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.preference-setting-label > span,[\s\S]*?\.preference-auxiliary-label > span\s*\{[^}]*white-space:\s*nowrap;/s,
    );
  });

  it("keeps interaction assistance compact and overlays expanded rows", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const gameArea = stylesheet.match(/\.game-area\s*\{([^}]*)\}/s)?.[1];
    const panel = stylesheet.match(/\.interaction-assist-panel\s*\{([^}]*)\}/s)?.[1];
    const expandedPanel = stylesheet.match(
      /\.interaction-assist-panel\.expanded\s*\{([^}]*)\}/s,
    )?.[1];
    const header = stylesheet.match(/\.interaction-assist-header\s*\{([^}]*)\}/s)?.[1];
    const toggle = stylesheet.match(/\.interaction-assist-toggle\s*\{([^}]*)\}/s)?.[1];
    const downIcon = stylesheet.match(
      /\.interaction-assist-toggle-icon\.direction-down\s*\{([^}]*)\}/s,
    )?.[1];
    const actions = stylesheet.match(/\.interaction-assist-actions\s*\{([^}]*)\}/s)?.[1];
    const expandedActions = stylesheet.match(
      /\.interaction-assist-actions\.expanded\s*\{([^}]*)\}/s,
    )?.[1];
    const row = stylesheet.match(/\.interaction-assist-row\s*\{([^}]*)\}/s)?.[1];
    const action = stylesheet.match(/\.interaction-assist-action\s*\{([^}]*)\}/s)?.[1];
    const actionText = stylesheet.match(/\.interaction-assist-action > span\s*\{([^}]*)\}/s)?.[1];

    expect(gameArea).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) auto;/);
    expect(gameArea).toMatch(/background:\s*var\(--game-background\);/);
    expect(panel).toMatch(/--interaction-assist-actions-border-width:\s*1px;/);
    expect(panel).toMatch(/--interaction-assist-actions-padding-block:\s*6px;/);
    expect(panel).toMatch(/--interaction-assist-row-gap:\s*6px;/);
    expect(panel).toMatch(/background:\s*transparent;/);
    expect(expandedPanel).toMatch(/position:\s*absolute;/);
    expect(expandedPanel).toMatch(/bottom:\s*0;/);
    expect(header).toMatch(/justify-content:\s*flex-end;/);
    expect(header).toMatch(/background:\s*transparent;/);
    expect(header).toMatch(/box-shadow:\s*none;/);
    expect(toggle).toMatch(/border-bottom:\s*0;/);
    expect(toggle).toMatch(/background:\s*#202329f5;/);
    expect(downIcon).toMatch(/transform:\s*rotate\(180deg\);/);
    expect(actions).toMatch(/overflow-x:\s*auto;/);
    expect(actions).toMatch(/overflow-y:\s*hidden;/);
    expect(actions).toMatch(/background:\s*#202329f5;/);
    expect(actions).toMatch(/box-shadow:\s*none;/);
    expect(actions).toMatch(
      /border-top:\s*var\(--interaction-assist-actions-border-width\) solid #3a3f4b;/,
    );
    expect(actions).toMatch(/padding:\s*var\(--interaction-assist-actions-padding-block\) 7px;/);
    expect(actions).toMatch(
      /min-height:\s*calc\([\s\S]*var\(--interaction-assist-action-height\)[\s\S]*var\(--interaction-assist-actions-padding-block\)[\s\S]*var\(--interaction-assist-actions-padding-block\)[\s\S]*var\(--interaction-assist-actions-border-width\)[\s\S]*\);/,
    );
    expect(expandedActions).toMatch(/gap:\s*var\(--interaction-assist-row-gap\);/);
    expect(row).toMatch(/min-height:\s*var\(--interaction-assist-action-height\);/);
    expect(action).toMatch(/width:\s*10rem;/);
    expect(action).toMatch(/min-width:\s*10rem;/);
    expect(action).toMatch(/max-width:\s*10rem;/);
    expect(actionText).toMatch(/font-size:\s*1rem;/);
    expect(actionText).toMatch(/line-height:\s*1rem;/);
    expect(actionText).toMatch(/text-overflow:\s*ellipsis;/);
    expect(actionText).toMatch(/white-space:\s*nowrap;/);
  });

  it("expands the hidden-menu touch target without changing its visual box", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const toggle = stylesheet.match(/\.menu-touch-toggle\s*\{([^}]*)\}/s)?.[1];
    const target = stylesheet.match(/\.menu-touch-toggle::before\s*\{([^}]*)\}/s)?.[1];
    const openTarget = stylesheet.match(
      /\.menu-overlay\.menu-overlay-open \.menu-touch-toggle::before\s*\{([^}]*)\}/s,
    )?.[1];
    const icon = stylesheet.match(/\.menu-touch-toggle-icon\s*\{([^}]*)\}/s)?.[1];
    const down = stylesheet.match(/\.menu-touch-toggle-icon\.direction-down\s*\{([^}]*)\}/s)?.[1];

    expect(toggle).toMatch(/padding:\s*0\.18rem 0\.5rem;/);
    expect(target).toMatch(/position:\s*absolute;/);
    expect(target).toMatch(/inset:\s*-4px -12px -20px;/);
    expect(target).toMatch(/content:\s*"";/);
    expect(openTarget).toMatch(/top:\s*0;/);
    expect(toggle).toMatch(/z-index:\s*29;/);
    expect(stylesheet).toMatch(/\.menu-bar\s*\{[^}]*z-index:\s*30;/s);
    expect(stylesheet).toMatch(/\.menu-popup\s*\{[^}]*z-index:\s*100;/s);
    expect(icon).toMatch(/width:\s*1rem;/);
    expect(icon).toMatch(/height:\s*0\.875rem;/);
    expect(down).toMatch(/transform:\s*rotate\(180deg\);/);
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
    expect(stylesheet).not.toMatch(/\.game-line\s*\{[^}]*contain:/s);
    expect(stylesheet).toMatch(/\.game-line\s*\{[^}]*pointer-events:\s*none;/s);
    expect(stylesheet).toMatch(
      /\.game-line:has\(\.media-image, \.canvas-replay\)[^}]*padding:\s*0;/s,
    );
    expect(stylesheet).toMatch(
      /\.media-image,[\s\S]*?\.canvas-replay\s*\{[^}]*pointer-events:\s*auto;/s,
    );
    const separatorRule = stylesheet.match(/\.separator\s*\{([^}]*)\}/s)?.[1];
    expect(separatorRule).toBeDefined();
    expect(separatorRule).toMatch(/display:\s*block;/);
    expect(separatorRule).toMatch(/max-width:\s*100%;/);
    expect(separatorRule).toMatch(/overflow:\s*hidden;/);
    expect(separatorRule).toMatch(/line-height:\s*inherit;/);
    expect(separatorRule).toMatch(/white-space:\s*nowrap;/);
    expect(separatorRule).not.toMatch(/background:/);
  });

  it("bounds menus and dialog shells to small dynamic viewports with scrollable content", () => {
    const stylesheet = readFileSync(resolve("src/styles.css"), "utf8");
    const menu = stylesheet.match(/\.menu-popup\s*\{([^}]*)\}/s)?.[1];
    const panel = stylesheet.match(/\.dialog-panel\s*\{([^}]*)\}/s)?.[1];
    const content = stylesheet.match(/\.dialog-content\s*\{([^}]*)\}/s)?.[1];
    const settings = stylesheet.match(/\.settings-dialog\s*\{([^}]*)\}/s)?.[1];
    const settingsScroll = stylesheet.match(/\.settings-scroll\s*\{([^}]*)\}/s)?.[1];

    expect(menu).toMatch(/max-height:\s*calc\(100dvh/);
    expect(menu).toMatch(/overflow-y:\s*auto;/);
    expect(menu).not.toMatch(/scrollbar-gutter\s*:[^;]*\bstable\b/);
    expect(panel).toMatch(/max-width:\s*calc\(100vw - 16px\);/);
    expect(panel).toMatch(/max-height:\s*calc\(100dvh - 16px\);/);
    expect(content).toMatch(/overflow:\s*auto;/);
    expect(content).toMatch(/overscroll-behavior:\s*contain;/);
    expect(settings).not.toMatch(/max-height:/);
    expect(settingsScroll).not.toMatch(/max-height:|overflow:/);
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
