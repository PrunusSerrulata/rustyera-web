import assert from "node:assert/strict";

import { reachTitle, snapshot, submit, waitForProject } from "./rorona-flow.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_RORONA_LOAD_SCROLL ? describe : describe.skip;

enabled("Tauri erarorona load-game scrolling", () => {
  it("keeps the newest load-game line at the viewport bottom", async () => {
    await waitForProject();
    await reachTitle(20);
    await submit(1, true);
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return (
          state?.phase === "waiting_input" &&
          state?.wait?.kind === "string_value" &&
          state.output.slice(-100).join("\n").includes("载入游戏")
        );
      },
      { timeout: 30_000, interval: 20, timeoutMsg: "load-game page was not reached" },
    );

    const result = await browser.execute(() => {
      const viewport = document.querySelector(".game-viewport");
      if (!(viewport instanceof HTMLElement)) return null;
      return {
        bottomGap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    });
    assert.ok(result, "game viewport was not present");
    assert.ok(result.bottomGap <= 1, `load-game viewport bottom gap was ${result.bottomGap}px`);
    console.log(JSON.stringify({ type: "tauri-rorona-load-scroll", ...result }));
  });
});
