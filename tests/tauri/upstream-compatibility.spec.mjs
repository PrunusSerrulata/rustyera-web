import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectWebdriverTyped, typedValues } from "../../scripts/interop-assertions.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_UPSTREAM_COMPATIBILITY === "1" ? describe : describe.skip;

enabled("Tauri upstream compatibility", () => {
  it("consumes aliases, save-check versions and UTF-16 widths through the real host", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "runner must provide its isolated project copy");
    const config = await readFile(path.join(project, "reraconfig.toml"), "utf8");
    const snake = /profile\s*=\s*"emuera\.skia\.snake"/.test(config);
    const prefix = snake ? "SNAKE_UPSTREAM" : "UPSTREAM";
    await browser.waitUntil(async () => Boolean(await snapshot()), {
      timeout: 20_000,
      interval: 100,
    });
    assert.equal((await snapshot()).bridgeKind, "tauri");
    await $(".welcome .primary").click();
    const initial = await waitForOutput(`${prefix}_READY`);
    const expressions = Array.from(
      { length: snake ? 18 : 10 },
      (_, i) => `FLAG:${i + (snake ? 12 : 10)}`,
    );
    const initialDiagnostics = await browser.execute(() =>
      window.__RUSTYERA_TEST__.protocolEvidence([
        "project_load_report",
        "diagnostic",
        "command_rejected",
      ]),
    );
    const initialWatches = typedValues(
      await inspectWebdriverTyped(browser, expressions),
      expressions,
    );
    const markers = snake
      ? [
          "SNAKE_UPSTREAM_CHKDATA=0,42,1,0",
          "SNAKE_UPSTREAM_STRINGS=4,4,3",
          "SNAKE_UPSTREAM_RAND=0,5",
          "SNAKE_UPSTREAM_ERD=1,0,2,0,9,1",
        ]
      : ["UPSTREAM_ALIASES=1,3", "UPSTREAM_CHKDATA=0,42,1,0", "UPSTREAM_STRINGS=4,4,3"];
    for (const marker of markers)
      assert.ok(
        initial.output.some((line) => line.includes(marker)),
        marker,
      );
    assert.equal(initial.fault, null);
    const evidence = await browser.execute(() =>
      window.__RUSTYERA_TEST__.protocolEvidence(["project_load_report"]),
    );
    assert.equal(evidence.failure, null);
    const reports = evidence.records.filter(
      (record) =>
        record.direction === "receive" &&
        record.message?.type === "project_load_report" &&
        record.message.value?.success === true,
    );
    assert.ok(reports.length > 0, "a successful public project report is required");
    const identity = reports.at(-1).message.value.compatibility;
    assert.equal(identity.profile, snake ? "emuera.skia.snake" : "emuera.em");
    assert.equal(Number(identity.semantic_version), snake ? 15 : 3);
    assert.equal(Number(identity.policy_version), snake ? 15 : 3);
    await $(".prompt-bar input").setValue("7");
    await $(".prompt-bar button[type=submit]").click();
    const continued = await waitForOutput(`${prefix}_CONTINUED`);
    if (snake)
      assert.ok(
        continued.output.some((line) => line.includes("SNAKE_UPSTREAM_RAND_CONTINUED=0,8")),
      );
    assert.equal(continued.bridgeKind, "tauri");
    assert.equal(continued.fault, null);
    const continuedDiagnostics = await browser.execute(() =>
      window.__RUSTYERA_TEST__.protocolEvidence([
        "project_load_report",
        "diagnostic",
        "command_rejected",
      ]),
    );
    const continuedWatches = typedValues(
      await inspectWebdriverTyped(browser, expressions),
      expressions,
    );
    console.log(
      JSON.stringify({
        type: "upstream-client-stages",
        identity,
        initial,
        initialWatches,
        initialDiagnostics,
        continued,
        continuedWatches,
        continuedDiagnostics,
      }),
    );
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
