import assert from "node:assert/strict";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_UPSTREAM_COMPATIBILITY === "1" ? describe : describe.skip;

enabled("Tauri original upstream compatibility", () => {
  it("consumes aliases, save-check versions and UTF-16 widths through the real host", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      interval: 100,
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    const initial = await waitForOutput("UPSTREAM_READY");
    for (const marker of [
      "UPSTREAM_ALIASES=1,3",
      "UPSTREAM_CHKDATA=0,42,1,0",
      "UPSTREAM_STRINGS=4,4,3",
    ])
      assert.ok(
        initial.output.some((line) => line.includes(marker)),
        marker,
      );
    assert.equal(initial.fault, null);
    await $(".prompt-bar input").setValue("7");
    await $(".prompt-bar button[type=submit]").click();
    const continued = await waitForOutput("UPSTREAM_CONTINUED");
    assert.equal(continued.bridgeKind, "tauri");
    assert.equal(continued.fault, null);
    console.log(JSON.stringify({ type: "upstream-compatibility", initial, continued }));
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitForOutput(marker) {
  let state;
  await browser.waitUntil(
    async () => {
      state = await snapshot();
      if (state?.fault) throw new Error(JSON.stringify(state.fault));
      return (
        state?.bridgeKind === "tauri" &&
        state.canInteract &&
        state.wait?.kind === "integer_value" &&
        state.output.some((line) => line.includes(marker))
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: `upstream fixture did not reach ${marker}` },
  );
  return state;
}
