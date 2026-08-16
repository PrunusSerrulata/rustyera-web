import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const reraconfig = process.env.VITE_RUSTYERA_TAURI_RERACONFIG ? describe : describe.skip;

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

reraconfig("Tauri reraconfig settings", () => {
  it("persists and hot-applies only the new cross-client settings", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      timeoutMsg: "test control was not installed in the Tauri WebView",
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");

    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "configured project did not reach an input wait",
      totalTimeout: 120_000,
      stallTimeout: 120_000,
      accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
    });

    await $("button=文件").click();
    await $("button=项目设置…").click();
    const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 项目设置']");
    await dialog.waitForDisplayed();
    await dialog.$("button=交互与输出").click();

    const volume = await dialog.$("#setting-AudioVolume");
    const replaceSpaces = await dialog.$("#setting-ReplaceFullWidthSpaces");
    const widthMode = await dialog.$("#setting-CharacterWidthMode");
    assert.equal(await volume.getValue(), "100");
    assert.equal(await volume.getAttribute("type"), "range");
    assert.equal(await replaceSpaces.isSelected(), false);
    assert.equal(await widthMode.getValue(), "AUTOMATIC");
    const optionElements = await widthMode.$$("option");
    const optionValues = [];
    for (let index = 0; index < optionElements.length; index += 1) {
      optionValues.push(await optionElements[index].getAttribute("value"));
    }
    assert.deepEqual(optionValues, ["AUTOMATIC", "AMBIGUOUS_NARROW", "AMBIGUOUS_WIDE"]);

    await setRangeValue(volume, 42);
    await dialog.$("label[for='setting-ReplaceFullWidthSpaces']").click();
    assert.equal(await replaceSpaces.isSelected(), true);
    await dialog.$("button=应用").click();
    await browser.waitUntil(
      async () => {
        const contents = await readFile(
          path.join(process.env.VITE_RUSTYERA_TEST_PROJECT, "reraconfig.toml"),
          "utf8",
        );
        return (
          /volume\s*=\s*42/.test(contents) && /replace_full_width_spaces\s*=\s*true/.test(contents)
        );
      },
      {
        timeout: 20_000,
        timeoutMsg: "new reraconfig settings were not persisted",
      },
    );

    await dialog.$("button=取消").click();
    await dialog.waitForExist({ reverse: true });
    await $("button=文件").click();
    await $("button=项目设置…").click();
    const reopened = await $(".dialog-panel[aria-label='RustyEra Tauri · 项目设置']");
    await reopened.waitForDisplayed();
    await reopened.$("button=交互与输出").click();
    assert.equal(await reopened.$("#setting-AudioVolume").getValue(), "42");
    assert.equal(await reopened.$("#setting-ReplaceFullWidthSpaces").isSelected(), true);
    assert.equal(await reopened.$("#setting-CharacterWidthMode").getValue(), "AUTOMATIC");
    const source = await readFile(
      path.join(process.env.VITE_RUSTYERA_TEST_PROJECT, "reraconfig.toml"),
      "utf8",
    );
    assert.match(source, /volume\s*=\s*42/);
    assert.match(source, /replace_full_width_spaces\s*=\s*true/);
    assert.doesNotMatch(source, /character_width_mode/);

    console.log(
      JSON.stringify({
        bridgeKind: (await snapshot()).bridgeKind,
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        audioVolume: 42,
        replaceFullWidthSpaces: true,
        characterWidthMode: "AUTOMATIC",
      }),
    );
  });
});

async function setRangeValue(element, value) {
  const minimum = Number(await element.getAttribute("min"));
  const maximum = Number(await element.getAttribute("max"));
  const trackWidth = (await element.getSize("width")) - 16;
  let offset = Math.round(((value - minimum) / (maximum - minimum) - 0.5) * trackWidth);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await element.click({ x: offset });
    const actual = Number(await element.getValue());
    if (actual === value) return;
    offset += Math.round(((value - actual) / (maximum - minimum)) * trackWidth);
  }
  assert.equal(await element.getValue(), String(value));
}
