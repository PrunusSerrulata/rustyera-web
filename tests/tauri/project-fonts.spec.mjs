import assert from "node:assert/strict";
import path from "node:path";
import { rename } from "node:fs/promises";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_PROJECT_FONTS ? describe : describe.skip;
const PROJECT_FONT = "等距时代黑体 SC";

enabled("Tauri project fonts", () => {
  it("loads a project FontFace and applies its family from visible settings", async () => {
    await browser.waitUntil(async () => Boolean(await snapshot()), { timeout: 20_000 });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "font project did not reach an input wait",
      totalTimeout: 120_000,
      stallTimeout: 120_000,
      accept: (state) => state?.projectOpen && state.phase === "waiting_input" && state.canInteract,
    });

    await $("button=文件").click();
    await $("button=设置…").click();
    const dialog = await $(".dialog-panel[aria-label='RustyEra Tauri · 设置']");
    await dialog.waitForDisplayed();
    await dialog.$("button=显示").click();
    const choices = await browser.execute(() =>
      [...document.querySelectorAll("#available-game-fonts option")].map((option) => option.value),
    );
    assert.equal(choices.includes(PROJECT_FONT), true);
    await dialog.$("#setting-FontName").setValue(PROJECT_FONT);
    await dialog.$("button=应用").click();

    let observation;
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "project font setting did not reach rendered game text",
      totalTimeout: 120_000,
      stallTimeout: 120_000,
      accept: async (state) => {
        observation = await projectFontObservation();
        return (
          state?.projectOpen &&
          state.phase === "waiting_input" &&
          state.canInteract &&
          observation.face?.status === "loaded" &&
          observation.settingsReady &&
          primaryFont(observation.computedFamily) === normalizeFont(PROJECT_FONT)
        );
      },
    });
    console.log(JSON.stringify({ projectFont: observation }));
    assert.deepEqual(observation.face, { family: PROJECT_FONT, status: "loaded" });
    assert.equal(primaryFont(observation.computedFamily), normalizeFont(PROJECT_FONT));
    assertHealthyFontRuntime(await snapshot());

    await $("button=取消").click();
    const fontPath = path.join(
      process.env.VITE_RUSTYERA_TEST_PROJECT,
      "font",
      "EraMonoSC-1.07.ttf",
    );
    await rename(fontPath, `${fontPath}.disabled`);
    await $("button=文件").click();
    await $("button=重新加载全部脚本").click();
    await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "removed project font remained registered after reload",
      totalTimeout: 120_000,
      stallTimeout: 120_000,
      accept: async (state) =>
        state?.projectOpen &&
        state.phase === "waiting_input" &&
        state.canInteract &&
        !(await browser.execute(
          (family) => [...document.fonts].some((candidate) => candidate.family === family),
          PROJECT_FONT,
        )),
    });
    assertHealthyFontRuntime(await snapshot());
  });
});

async function projectFontObservation() {
  return browser.execute((family) => {
    const face = [...document.fonts].find((candidate) => candidate.family === family);
    const text = [...document.querySelectorAll(".game-line span")]
      .filter((candidate) => candidate.textContent?.trim())
      .at(-1);
    return {
      face: face ? { family: face.family, status: face.status } : null,
      computedFamily: text instanceof HTMLElement ? getComputedStyle(text).fontFamily : null,
      settingsReady: [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "取消" && !button.disabled,
      ),
    };
  }, PROJECT_FONT);
}

function normalizeFont(value) {
  return String(value ?? "")
    .replaceAll(/["']/g, "")
    .trim()
    .toLowerCase();
}

function primaryFont(value) {
  return normalizeFont(String(value ?? "").split(",", 1)[0]);
}

function assertHealthyFontRuntime(state) {
  assert.equal(state.fault, null);
  assert.equal(
    state.logs?.some((entry) =>
      String(entry.message).includes("compiled project cache preparation"),
    ),
    false,
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}
