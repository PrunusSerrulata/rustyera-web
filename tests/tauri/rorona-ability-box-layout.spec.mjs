import assert from "node:assert/strict";

import { snapshot, waitForProject } from "./rorona-flow.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_RORONA_ABILITY_BOX_LAYOUT
  ? describe
  : describe.skip;
const LABELS = ["烙印", "经验", "宝珠", "请选择要提升的能力"];
const TARGETS = [
  { label: LABELS[0], marker: "┌烙印", index: 483 },
  { label: LABELS[1], marker: "┌经验", index: 486 },
  { label: LABELS[2], marker: "┌宝珠", index: 493 },
  { label: LABELS[3], marker: LABELS[3], index: 516 },
];
const VIEWPORTS = [
  [800, 700],
  [1080, 760],
  [1440, 900],
];

enabled("Tauri erarorona ability box layout", () => {
  it("aligns HTML table edges across fonts, sizes, and viewport widths", async () => {
    await waitForProject();

    for (const family of ["等距时代黑体 SC", "monospace"]) {
      for (const size of [12, 16, 18, 24]) {
        await applyFont(family, size);
        const contentWidths = [];
        for (const [width, height] of VIEWPORTS) {
          await browser.setWindowSize(width, height);
          const viewport = await viewportMetrics();
          assert.ok(viewport.contentWidth > 0, "the game viewport has no measurable width");
          assert.ok(viewport.innerWidth > 0, "the Tauri webview has no measurable width");
          assert.ok(viewport.family.includes(family), `${family} was not the computed font family`);
          assert.equal(viewport.size, `${size}px`);
          contentWidths.push(viewport.contentWidth);
          for (const target of TARGETS) await assertAligned(target);
        }
        assert.ok(
          contentWidths[0] < contentWidths[1] && contentWidths[1] < contentWidths[2],
          `content widths did not track the requested windows: ${contentWidths.join(", ")}`,
        );
      }
    }

    await applyFont("sans-serif", 16);
    for (const target of TARGETS) {
      assert.equal(
        await revealLabel(target.marker, target.index),
        true,
        `${target.label} was not visible with sans-serif`,
      );
    }
    assert.equal((await snapshot()).fault, null);
  });
});

async function applyFont(family, size) {
  await browser.execute(
    (requestedFamily, requestedSize) => {
      const application = document.querySelector(".app-shell");
      if (!(application instanceof HTMLElement)) throw new Error("app shell is not available");
      let sheet = document.querySelector("#rustyera-test-game-text-style");
      if (!(sheet instanceof HTMLStyleElement)) {
        sheet = document.createElement("style");
        sheet.id = "rustyera-test-game-text-style";
        document.head.append(sheet);
      }
      sheet.textContent = "[data-rustyera-test-game-text-style] {}";
      const rule = sheet.sheet?.cssRules[0];
      if (!(rule instanceof CSSStyleRule)) throw new Error("test style rule is not available");
      rule.style.setProperty("--game-font", requestedFamily, "important");
      rule.style.setProperty("--game-size", `${requestedSize}px`, "important");
      rule.style.setProperty("--game-line-height", `${requestedSize + 1}px`, "important");
      application.dataset.rustyeraTestGameTextStyle = "";
    },
    family,
    size,
  );
  await browser.waitUntil(
    async () => {
      const style = await viewportMetrics();
      return style.family.includes(family) && style.size === `${size}px`;
    },
    { timeout: 10_000, timeoutMsg: `font ${family} ${size}px was not applied` },
  );
}

async function viewportMetrics() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    if (!(viewport instanceof HTMLElement)) {
      return { family: "", size: "", contentWidth: 0, innerWidth: window.innerWidth };
    }
    const computed = getComputedStyle(viewport);
    return {
      family: computed.fontFamily,
      size: computed.fontSize,
      contentWidth: viewport.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function assertAligned(target) {
  assert.equal(
    await revealLabel(target.marker, target.index),
    true,
    `${target.label} could not be revealed`,
  );
  let metrics;
  await browser.waitUntil(
    async () => {
      metrics = await boxMetrics(target.marker);
      return metrics.visible && metrics.count >= 2 && metrics.spread <= 1;
    },
    { timeout: 10_000, timeoutMsg: `${target.label} box edges did not align` },
  );
  assert.ok(metrics.spread <= 1, `${target.label} right-edge spread was ${metrics.spread}px`);
}

async function revealLabel(label, targetIndex) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await browser.execute(
      (expected, index, firstAttempt) => {
        const viewport = document.querySelector(".game-viewport");
        if (!(viewport instanceof HTMLElement)) return { found: false, visible: false };
        const visible = (element) => {
          const bounds = element.getBoundingClientRect();
          const viewportBounds = viewport.getBoundingClientRect();
          return bounds.bottom > viewportBounds.top && bounds.top < viewportBounds.bottom;
        };
        const sample = document.querySelector(".game-line");
        const measuredLineHeight = Number.parseFloat(
          sample instanceof HTMLElement ? getComputedStyle(sample).lineHeight : "",
        );
        const lineHeight = Number.isFinite(measuredLineHeight) ? measuredLineHeight : 16;
        if (firstAttempt)
          viewport.scrollTop = Math.max(0, index * lineHeight - viewport.clientHeight / 2);
        const lines = [...document.querySelectorAll(".game-line")];
        const target = lines.find(
          (line) =>
            line.getAttribute("data-index") === String(index) &&
            line.textContent?.includes(expected),
        );
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "center" });
          return { found: true, visible: visible(target) };
        }
        const renderedIndex = Number(
          lines[Math.floor(lines.length / 2)]?.getAttribute("data-index"),
        );
        if (Number.isFinite(renderedIndex))
          viewport.scrollTop += (index - renderedIndex) * lineHeight;
        return { found: false, visible: false };
      },
      label,
      targetIndex,
      attempt === 0,
    );
    if (result.found) return result.visible;
  }
  return false;
}

async function boxMetrics(label) {
  return browser.execute((expected) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden";
    };
    const textNodes = [...document.querySelectorAll(".game-line")].filter((line) =>
      line.textContent?.includes(expected),
    );
    const target = textNodes.find((line) => line.querySelector(".html-box-row"));
    if (!target || !visible(target)) return { visible: false, count: 0, spread: null };
    const lines = [...target.parentElement.querySelectorAll(":scope > .game-line")];
    const index = lines.indexOf(target);
    const lineText = (line) => line.textContent?.trim() ?? "";
    const isTopBorder = (line) => /^[┌┏╔]/u.test(lineText(line)) && /[┐┓╗]$/u.test(lineText(line));
    const isBottomBorder = (line) =>
      /^[└┗╚]/u.test(lineText(line)) && /[┘┛╝]$/u.test(lineText(line));
    let tableStart = index;
    while (tableStart > 0 && !isTopBorder(lines[tableStart])) {
      tableStart -= 1;
      if (isBottomBorder(lines[tableStart])) break;
    }
    let tableEnd = index;
    while (tableEnd + 1 < lines.length && !isBottomBorder(lines[tableEnd])) {
      tableEnd += 1;
      if (isTopBorder(lines[tableEnd])) break;
    }
    const boundedTable = isTopBorder(lines[tableStart]) && isBottomBorder(lines[tableEnd]);
    const nearby = boundedTable
      ? lines.slice(tableStart, tableEnd + 1)
      : lines.slice(Math.max(0, index - 5), index + 6);
    const rightCharacters = new Set(["│", "┃", "║", "┐", "┓", "╗", "┘", "┛", "╝"]);
    const rightEdges = nearby
      .map((line) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const positions = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue ?? "";
          for (let offset = 0; offset < text.length; offset += 1) {
            if (!rightCharacters.has(text[offset])) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            positions.push(range.getBoundingClientRect().left);
          }
        }
        return positions.at(-1);
      })
      .filter((value) => value != null);
    return {
      visible: true,
      count: rightEdges.length,
      rows: nearby.length,
      spread: Math.max(...rightEdges) - Math.min(...rightEdges),
    };
  }, label);
}
