import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// The official runner owns the independent five-second complete-state watchdog.
describe("Tauri buttons across message continuation", () => {
  it("keeps status header buttons enabled when continuation appends the command menu", async () => {
    const evidence = { waits: [], buttons: [] };
    const state = () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshotSummary());
    try {
      await browser.waitUntil(async () => Boolean(await state()), { timeout: 20000, interval: 50 });
      assert.equal((await state()).bridgeKind, "tauri");
      await $(".welcome .primary").click();
      await browser.waitUntil(async () => (await state())?.canInteract, {
        timeout: 120000,
        interval: 50,
      });
      const before = await state();
      evidence.waits.push(before.wait);
      assert.equal(before.wait.kind, "enter_key");
      await browser.pause(3000);
      const lineId = await browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        const bounds = viewport.getBoundingClientRect();
        const interactive = "button, a, input, select, textarea, [role=button], [data-no-continue]";
        for (const row of [...viewport.querySelectorAll(".game-line")].reverse()) {
          const rect = row.getBoundingClientRect();
          if (
            rect.height <= 0 ||
            rect.top < bounds.top ||
            rect.bottom > bounds.bottom ||
            row.querySelector(interactive)
          )
            continue;
          const x = (rect.left + rect.right) / 2;
          if (x <= bounds.left || x >= bounds.right) continue;
          const hit = document.elementFromPoint(x, (rect.top + rect.bottom) / 2);
          if (hit && viewport.contains(hit) && !hit.closest(interactive)) return row.dataset.lineId;
        }
        return null;
      });
      assert.ok(lineId, "no visible non-interactive continuation row");
      await $(`.game-line[data-line-id="${lineId}"]`).click();

      await browser.waitUntil(
        async () => {
          const current = await state();
          assert.equal(current?.fault ?? null, null);
          return current?.canInteract && current.wait?.wait_id !== before.wait.wait_id;
        },
        { timeout: 20000, interval: 50 },
      );
      evidence.waits.push((await state()).wait);
      assert.equal((await state()).wait.kind, "integer_value");
      assert.equal((await state()).canInteract, true);
      const wanted = ["催眠发动可", "Status", "通常", "Palam"];
      const seen = new Set();
      for (let page = 0; page < 4 && seen.size < wanted.length; page += 1) {
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
        const found = await browser.execute(
          (labels) =>
            [...document.querySelectorAll(".game-line button")].flatMap((button) => {
              const label = labels.find((value) => button.textContent.includes(value));
              const rect = button.getBoundingClientRect();
              const bounds = document.querySelector(".game-viewport").getBoundingClientRect();
              return label &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom > bounds.top &&
                rect.top < bounds.bottom &&
                rect.right > bounds.left &&
                rect.left < bounds.right
                ? [{ label, text: button.textContent, disabled: button.disabled }]
                : [];
            }),
          wanted,
        );
        evidence.buttons.push(...found);
        for (const button of found) {
          assert.equal(button.disabled, false, `${button.label} was retired by a continuation`);
          seen.add(button.label);
        }
        if (seen.size === wanted.length) break;
        await browser.pause(3000);
        await browser.execute(() => {
          const viewport = document.querySelector(".game-viewport");
          viewport.scrollBy({ top: -viewport.clientHeight, behavior: "instant" });
        });
      }
      assert.deepEqual([...seen].sort(), [...wanted].sort(), "missing header buttons");
      assert.equal((await state()).fault, null);
      await browser.saveScreenshot(`${process.env.RUSTYERA_LAYOUT_EVIDENCE}.png`);
    } finally {
      assert.ok(process.env.RUSTYERA_LAYOUT_EVIDENCE);
      await writeFile(process.env.RUSTYERA_LAYOUT_EVIDENCE, JSON.stringify(evidence, null, 2));
    }
  });
});
