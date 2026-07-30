import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const eraTwClock = process.env.VITE_RUSTYERA_TAURI_ERATW_CLOCK ? describe : describe.skip;

eraTwClock("Tauri eraTW positioned clock", () => {
  it("anchors the home clock to the adjacent upper separator", async () => {
    await waitForProject();
    const inputs = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 9999, 0, 2, 1999, 0, 100, 1, 100];
    for (const value of inputs) await submit(value);
    await drainTransientWaits(300);

    const state = await snapshot();
    let clock;
    try {
      await browser.waitUntil(
        async () => {
          clock = await clockMetrics();
          return (
            clock.count === 1 &&
            clock.insideViewport &&
            clock.rightGap <= 16 &&
            Math.abs(clock.top - clock.separatorTop) <= 1
          );
        },
        { timeout: STEP_TIMEOUT, timeoutMsg: "home clock geometry did not stabilize" },
      );
    } catch (error) {
      const failureState = await snapshot();
      console.error(
        JSON.stringify({
          failureStage: "clock geometry",
          clock,
          phase: failureState.phase,
          wait: failureState.wait,
          fault: failureState.fault,
          outputTail: failureState.output.slice(-20),
        }),
      );
      throw error;
    }
    console.log(JSON.stringify({ clock, wait: state.wait, fault: state.fault }));
    assert.equal(state.fault, null);
    assert.ok(state.output.some((line) => line.includes("你的倉庫")));
    assert.equal(clock.count, 1);
    assert.ok(clock.insideViewport, "clock must remain inside the viewport");
    assert.ok(clock.rightGap <= 16, "clock must remain near the right edge");
    assert.ok(
      Math.abs(clock.top - clock.separatorTop) <= 1,
      "clock must align with the home screen's adjacent upper separator",
    );
  });
});

async function waitForProject() {
  await browser.waitUntil(async () => Boolean(await snapshot()), {
    timeout: 20_000,
    timeoutMsg: "test control was not installed in the Tauri WebView",
  });
  assert.equal((await snapshot()).bridgeKind, "tauri");
  await browser.execute(() =>
    window.__RUSTYERA_TEST__.configure({
      start: { type: "new_game", seed: 1 },
      clock: "2026-01-01T00:00:00Z",
    }),
  );
  await $(".welcome .primary").click();
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
    },
    { timeout: PROJECT_TIMEOUT, timeoutMsg: "eraTW did not reach its first input" },
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value) {
  await drainTransientWaits(300);
  const before = await snapshot();
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await waitForWaitChange(before.wait?.wait_id);
}

async function drainTransientWaits(maximum) {
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const state = await snapshot();
    if (state.wait?.kind !== "void" && state.wait?.kind !== "enter_key") return;
    await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
  throw new Error(`transient wait budget exhausted after ${maximum} attempts`);
}

async function waitForWaitChange(waitId) {
  if (waitId == null) return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return (
        state.fault != null ||
        (state.phase === "waiting_input" && state.canInteract && state.wait?.wait_id !== waitId)
      );
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game input did not advance" },
  );
}

async function clockMetrics() {
  return browser.execute(() => {
    const visual = document.querySelector(".media-visual.media-sprite");
    const owner = visual?.closest(".game-line");
    const separator = owner?.nextElementSibling?.querySelector(".separator");
    const viewport = document.querySelector(".game-viewport");
    const bounds = visual?.getBoundingClientRect();
    const separatorBounds = separator?.getBoundingClientRect();
    const viewportBounds = viewport?.getBoundingClientRect();
    return {
      count: visual ? 1 : 0,
      mediaCount: document.querySelectorAll(".media-image, .canvas-replay").length,
      top: bounds?.top ?? -Infinity,
      separatorTop: separatorBounds?.top ?? Infinity,
      rightGap: bounds && viewportBounds ? viewportBounds.right - bounds.right : Infinity,
      insideViewport: Boolean(
        bounds &&
        viewportBounds &&
        bounds.left >= viewportBounds.left &&
        bounds.top >= viewportBounds.top &&
        bounds.right <= viewportBounds.right &&
        bounds.bottom <= viewportBounds.bottom,
      ),
    };
  });
}
