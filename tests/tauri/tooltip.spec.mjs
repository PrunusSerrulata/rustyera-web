import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 300_000;
const tooltipTest = process.env.VITE_RUSTYERA_TAURI_TOOLTIP === "1" ? describe : describe.skip;

tooltipTest("Tauri game tooltip", () => {
  it("shows runtime-styled button and nonbutton tooltip text", async () => {
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
        timeoutMsg: "tooltip fixture did not reach a stable input wait",
      },
    );

    const button = await $("button[data-era-tooltip]");
    await button.moveTo();
    await $(".game-tooltip").waitForDisplayed({ timeout: 20_000 });
    const buttonTooltip = await tooltipState();
    assert.equal(buttonTooltip?.text, "button tip\nsecond line");
    assert.equal(buttonTooltip?.role, "tooltip");
    assert.equal(buttonTooltip?.color, "rgb(1, 2, 3)");
    assert.equal(buttonTooltip?.backgroundColor, "rgb(250, 240, 208)");
    assert.match(buttonTooltip?.fontFamily ?? "", /monospace/i);

    const nonbutton = await $("[data-era-tooltip='plain tip']");
    await nonbutton.moveTo();
    await browser.waitUntil(async () => (await tooltipState())?.text === "plain tip", {
      timeout: 20_000,
      timeoutMsg: "nonbutton tooltip did not replace the button tooltip",
    });
    const plainTooltip = await tooltipState();
    const state = await snapshot();
    assert.equal(state.bridgeKind, "tauri");
    assert.equal(state.fault, null);

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: state.bridgeKind,
        platform: process.platform,
        buttonTooltip,
        plainTooltip,
        outputTail: state.output.slice(-4),
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function tooltipState() {
  return browser.execute(() => {
    const element = document.querySelector(".game-tooltip");
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    return {
      text: element.textContent?.trim(),
      role: element.getAttribute("role"),
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      visible: element.getClientRects().length > 0,
    };
  });
}
