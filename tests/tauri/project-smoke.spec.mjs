import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 300_000;

const projectSmoke =
  process.env.VITE_RUSTYERA_TAURI_PROJECT_SMOKE === "1" ? describe : describe.skip;

projectSmoke("Tauri real-project startup", () => {
  it("opens the configured project and reaches a stable input wait", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await browser.waitUntil(
      async () => {
        const state = await snapshot();
        return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
      },
      {
        timeout: PROJECT_TIMEOUT,
        timeoutMsg: "configured Era project did not reach a stable input wait",
      },
    );

    const state = await snapshot();
    assert.equal(state.bridgeKind, "tauri");
    assert.equal(state.fault, null);
    assert.equal(state.wait?.kind, "integer_value");
    assert.match(state.output.join("\n"), /\[0\].+\n\[1\]/);
    const lineMetrics = await gameLineMetrics();
    assert.ok(lineMetrics, "the main viewport did not render a body line");
    assert.equal(lineMetrics.lineHeight, lineMetrics.fontSize);
    assert.equal(lineMetrics.minHeight, lineMetrics.fontSize);
    assert.equal(lineMetrics.marginTop, "0px");
    assert.equal(lineMetrics.marginBottom, "0px");
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: state.bridgeKind,
        phase: state.phase,
        wait: state.wait,
        lineMetrics,
        outputTail: state.output.slice(-8),
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function gameLineMetrics() {
  return browser.execute(() => {
    const line = [...document.querySelectorAll(".game-line")].find(
      (candidate) =>
        !candidate.querySelector(".media-image, .canvas-replay") && candidate.textContent?.trim(),
    );
    if (!(line instanceof HTMLElement)) return null;
    const style = getComputedStyle(line);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
    };
  });
}
