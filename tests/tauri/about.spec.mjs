import assert from "node:assert/strict";

describe("Tauri help menu", () => {
  it("shows build information and gates diagnosis export until a project opens", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".menu:nth-child(3) > button").click();
    await button("关于…").click();
    const dialog = await $(".dialog-panel[aria-label='关于 RustyEra']");
    await dialog.waitForDisplayed();
    const aboutText = await dialog.getText();
    assert.match(aboutText, /PrunusSerrulata/);
    assert.match(aboutText, /前端版本0\.1\.0/);
    assert.match(aboutText, /core 版本0\.1\.0 \(076b22ef\)/);
    assert.match(aboutText, /GPL-3\.0-only/);
    await dialog.$("button=确定").click();

    await $(".menu:nth-child(3) > button").click();
    assert.equal(await button("导出诊断信息…").isEnabled(), false);

    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: (await snapshot()).bridgeKind,
        about: aboutText,
        diagnosisExportEnabled: false,
      }),
    );
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

function button(label) {
  return $(`//button[normalize-space()=${JSON.stringify(label)}]`);
}
