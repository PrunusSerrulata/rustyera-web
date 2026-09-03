import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_SAVE_MENU === "1" ? describe : describe.skip;

// The official runner owns the independent five-second full DOM/runtime watchdog.
enabled("Tauri snake save menu", () => {
  it("publishes all missing slots together after hidden HTML measurement", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "official runner must provide an isolated fixture");
    const sourcePath = path.join(project, "ERB", "main.erb");
    const source = await readFile(sourcePath, "utf8");
    assert.ok(source.startsWith("@SYSTEM_TITLE\n"));
    // Isolate menu timing from startup. The drawing loop is identical to the browser fixture.
    await writeFile(
      sourcePath,
      source.replace("@SYSTEM_TITLE\n", "@SYSTEM_TITLE\nPRINTL SAVE_MENU_READY\nINPUT\n"),
    );
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshotSummary())),
      { timeout: 20_000, interval: 100 },
    );
    assert.equal(
      await browser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary().bridgeKind),
      "tauri",
    );
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    const open = await $(".welcome .primary");
    assert.ok(await open.isDisplayed());
    assert.ok(await open.isEnabled());
    await open.click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const state = window.__RUSTYERA_TEST__.snapshotSummary();
          if (state.fault) throw new Error(JSON.stringify(state.fault));
          return state.output.includes("SAVE_MENU_READY") && state.wait != null;
        }),
      { timeout: 30_000, interval: 50 },
    );
    try {
      await browser.execute(() => {
        const viewport = document.querySelector(".game-viewport");
        if (!viewport) throw new Error("missing game viewport");
        const evidence = { started: null, frames: [] };
        const observe = () => {
          const state = window.__RUSTYERA_TEST__.snapshotSummary();
          const bounds = viewport.getBoundingClientRect();
          const rows = [...viewport.querySelectorAll(".game-line")]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                text: element.textContent,
                index: element.getAttribute("data-index"),
                lineId: element.getAttribute("data-line-id"),
                visible:
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.bottom > bounds.top &&
                  rect.top < bounds.bottom,
              };
            })
            .filter((row) => /\[\d+\] - /.test(row.text));
          const prompt = document.querySelector(".prompt-bar input");
          const frame = {
            revision: state.presentationRevision,
            canonicalRows: state.output.filter((line) => /^\[\d+\] - /.test(line)).length,
            complete: state.output.includes("SAVE_MENU_COMPLETE"),
            rows,
            prompt: {
              present: prompt != null,
              disabled: prompt?.disabled ?? true,
              wait: state.wait?.wait_id ?? null,
            },
          };
          const previous = evidence.frames.at(-1);
          if (!previous || JSON.stringify(previous.state) !== JSON.stringify(frame))
            evidence.frames.push({
              state: frame,
              elapsedMs: evidence.started == null ? null : performance.now() - evidence.started,
            });
        };
        const observer = new MutationObserver(observe);
        // The hidden HTML measurement hosts live outside the viewport and never trigger this observer.
        observer.observe(viewport, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        window.__SAVE_MENU_OBSERVER__ = { evidence, observe, stop: () => observer.disconnect() };
        observe();
      });
      const input = await $(".prompt-bar input");
      assert.ok(await input.isDisplayed());
      assert.ok(await input.isEnabled());
      await input.setValue("1");
      const submit = await $(".prompt-bar button[type=submit]");
      assert.ok(await submit.isDisplayed());
      assert.ok(await submit.isEnabled());
      await browser.execute(() => {
        window.__SAVE_MENU_OBSERVER__.evidence.started = performance.now();
      });
      await submit.click();
      let state;
      await browser.waitUntil(
        async () => {
          state = await browser.execute(() => {
            const observed = window.__RUSTYERA_TEST__.snapshotSummary();
            if (observed.fault) throw new Error(JSON.stringify(observed.fault));
            window.__SAVE_MENU_OBSERVER__.observe();
            return observed;
          });
          return (
            state.output.includes("SAVE_MENU_COMPLETE") &&
            state.wait != null &&
            (await $(".prompt-bar input").isEnabled())
          );
        },
        { timeout: 30_000, interval: 50 },
      );
      const rows = state.output.filter((line) => /^\[\d+\] - /.test(line));
      const evidence = await browser.execute(() => window.__SAVE_MENU_OBSERVER__.evidence);
      console.log(JSON.stringify({ type: "save-menu-observation", rows, evidence }));
      assert.deepEqual(
        rows,
        Array.from({ length: 41 }, (_, index) => `[${index}] - ----`),
      );
      const completeRevision = evidence.frames.find((frame) => frame.state.complete)?.state
        .revision;
      assert.ok(completeRevision != null);
      assert.ok(evidence.frames.some((frame) => frame.state.rows.some((row) => row.visible)));
      for (const { state: frame } of evidence.frames) {
        assert.ok(
          frame.canonicalRows === 0 || frame.canonicalRows === 41,
          "partial canonical page",
        );
        if (frame.rows.length) {
          assert.equal(frame.complete, true, "DOM slots mounted before complete projection");
          assert.ok(BigInt(frame.revision) >= BigInt(completeRevision));
          for (const row of frame.rows) {
            assert.ok(row.lineId != null && row.index != null);
            assert.match(row.text, /\[\d+\] - ----/);
          }
        }
      }
      assert.equal(evidence.frames.at(-1).state.prompt.disabled, false);
      console.log(
        JSON.stringify({ type: "save-menu-result", bridgeKind: state.bridgeKind, rows, evidence }),
      );
    } finally {
      await browser.execute(() => {
        window.__SAVE_MENU_OBSERVER__?.stop();
        delete window.__SAVE_MENU_OBSERVER__;
      });
    }
  });
});
