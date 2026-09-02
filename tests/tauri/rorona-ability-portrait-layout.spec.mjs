import assert from "node:assert/strict";

import { snapshot, waitForProject } from "./rorona-flow.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_RORONA_ABILITY_PORTRAIT_LAYOUT
  ? describe
  : describe.skip;

enabled("Tauri erarorona ability portrait layout", () => {
  it("keeps the character portrait inside the explanation box", async () => {
    await waitForProject();

    for (const [width, height] of [
      [800, 700],
      [1080, 760],
      [1440, 900],
    ]) {
      await browser.setWindowSize(width, height);
      await revealPortrait();
      const metrics = await portraitBoxMetrics();
      assert.ok(metrics, "the portrait or viewport was not rendered");
      assert.ok(metrics.portraitWidth > 0 && metrics.portraitHeight > 0);
      assert.ok(
        metrics.portraitRight <= metrics.innerRight + 1,
        `portrait exceeded the box inner edge by ${metrics.portraitRight - metrics.innerRight}px`,
      );
    }

    assert.equal((await snapshot()).fault, null);
  });
});

async function revealPortrait() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        if (!(viewport instanceof HTMLElement)) return false;
        const line = document.querySelector('.game-line[data-index="328"]:has(.media-positioned)');
        if (line instanceof HTMLElement) {
          line.scrollIntoView({ block: "center" });
          return true;
        }
        viewport.scrollTop = viewport.scrollHeight;
        return false;
      }),
    { timeout: 10_000, timeoutMsg: "the character portrait could not be revealed" },
  );
}

async function portraitBoxMetrics() {
  return browser.execute(() => {
    const portrait = document.querySelector(
      '.game-line[data-index="328"] .media-positioned > .media-visual',
    );
    const viewport = document.querySelector(".game-viewport");
    if (!(portrait instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return null;
    const portraitBounds = portrait.getBoundingClientRect();
    const sample = document.createElement("span");
    sample.style.cssText = "position:absolute;visibility:hidden;width:124ch";
    viewport.append(sample);
    const innerWidth = sample.getBoundingClientRect().width;
    sample.remove();
    return {
      portraitRight: portraitBounds.right,
      portraitWidth: portraitBounds.width,
      portraitHeight: portraitBounds.height,
      innerRight: viewport.getBoundingClientRect().left + innerWidth,
    };
  });
}
