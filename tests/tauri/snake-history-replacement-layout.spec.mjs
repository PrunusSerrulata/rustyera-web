import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// The official runner owns the independent five-second full DOM/runtime watchdog.
describe("Tauri snake history replacement layout", () => {
  it("keeps menu rows separate after two continuation clicks and a scroll round trip", async () => {
    const evidence = { waits: [], layouts: [] };
    const state = () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshotSummary());
    const waitForInput = async (previous) => {
      await browser.waitUntil(
        async () => {
          const current = await state();
          assert.equal(current?.fault ?? null, null);
          return current?.canInteract && current.wait?.wait_id !== previous;
        },
        { timeout: 120_000, interval: 50, timeoutMsg: "runtime did not reach the next input wait" },
      );
      const current = await state();
      evidence.waits.push({
        phase: current.phase,
        wait: current.wait,
        revision: current.presentationRevision,
      });
      return current;
    };
    const capture = async () => {
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
      const layout = await browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        return {
          viewport: { height: viewport.clientHeight, scrollTop: viewport.scrollTop },
          rows: [...document.querySelectorAll(".virtual-history > .game-line")].map((element) => {
            const box = element.getBoundingClientRect();
            return {
              id: element.dataset.lineId,
              index: Number(element.dataset.index),
              top: box.top,
              bottom: box.bottom,
              height: box.height,
              layer: element.classList.contains("html-image-layer-line"),
            };
          }),
        };
      });
      evidence.layouts.push(layout);
      await browser.saveScreenshot(
        `${process.env.RUSTYERA_LAYOUT_EVIDENCE}.${evidence.layouts.length}.png`,
      );
      assert.ok(layout.rows.length >= 2, "missing history rows");
      let pairs = 0;
      for (let index = 0; index < layout.rows.length; index += 1) {
        const row = layout.rows[index];
        assert.ok([row.top, row.bottom, row.height].every(Number.isFinite) && row.height > 0);
        const next = layout.rows[index + 1];
        if (!next || row.layer || next.layer || next.index !== row.index + 1) continue;
        pairs += 1;
        assert.ok(
          row.bottom <= next.top + 1,
          `lines ${row.id}/${next.id} overlap by ${row.bottom - next.top}px`,
        );
      }
      assert.ok(pairs >= 2, "missing adjacent ordinary rows");
      return layout;
    };
    try {
      await browser.waitUntil(async () => Boolean(await state()), {
        timeout: 20_000,
        interval: 50,
      });
      assert.equal((await state()).bridgeKind, "tauri");
      await $(".welcome .primary").click();
      let current = await waitForInput();
      assert.equal(current.wait.kind, "integer_value");
      await $(".prompt-bar input").setValue("12");
      await $(".prompt-bar button[type=submit]").click();
      current = await waitForInput(current.wait.wait_id);
      for (let index = 0; index < 2; index += 1) {
        assert.equal(current.wait.kind, "enter_key");
        await browser.pause(3_000);
        const lineId = await browser.execute(() => {
          const viewport = document.querySelector(".game-viewport");
          const bounds = viewport.getBoundingClientRect();
          const interactive =
            "button, a, input, select, textarea, [role=button], [data-no-continue]";
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
            if (hit && viewport.contains(hit) && !hit.closest(interactive))
              return row.dataset.lineId;
          }
          return null;
        });
        assert.ok(lineId, "no visible non-interactive continuation row");
        await $(`.game-line[data-line-id="${lineId}"]`).click();
        current = await waitForInput(current.wait.wait_id);
      }
      const before = await capture();
      // The native provider does not implement wheel actions. Exercise the real WebView
      // scroll container directly; game inputs above still use native pointer events.
      await browser.pause(3_000);
      await browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        viewport.scrollBy({ top: -4 * viewport.clientHeight, behavior: "instant" });
      });
      await browser.waitUntil(
        async () => {
          const scroll = await browser.execute(
            () => document.querySelector(".game-viewport").scrollTop,
          );
          return before.viewport.scrollTop - scroll >= before.viewport.height * 3;
        },
        {
          timeout: 4_000,
          interval: 50,
          timeoutMsg: "viewport did not scroll at least three pages",
        },
      );
      await browser.pause(3_000);
      await browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
      });
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const element = document.querySelector(".game-viewport");
            return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
          }),
        { timeout: 4_000, interval: 50 },
      );
      await capture();
      assert.equal((await state()).fault, null);
      assert.equal((await state()).canInteract, true);
    } finally {
      assert.ok(process.env.RUSTYERA_LAYOUT_EVIDENCE, "missing evidence destination");
      await writeFile(process.env.RUSTYERA_LAYOUT_EVIDENCE, JSON.stringify(evidence, null, 2));
    }
  });
});
