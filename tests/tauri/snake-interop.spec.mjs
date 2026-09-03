import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { clickTauriTestElement, setTauriTestInput } from "../../scripts/dom-test-input.mjs";

import {
  assertProjectStorage,
  nativeStorageCapture,
  inspectWebdriverTyped,
  assertSuccessfulWrites,
  typedValues,
  validateExpectedValues,
} from "../../scripts/interop-assertions.mjs";

import { driveRuntimeUntil } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_INTEROP === "1" ? describe : describe.skip;
const defaultWatches = [
  "DAY",
  "MONEY",
  "TIME",
  "MASTER",
  "TARGET",
  "GLOBAL",
  "GLOBALS",
  "NO@0",
  "NAME@0",
  "CALLNAME@0",
  "BASE@0:0",
  "CFLAG@0:0",
];
const saveNames = ["save1000.sav", "global.sav"];
const gzipMagic = Buffer.from([0x89, 0x45, 0x52, 0x41, 0x5a, 0x49, 0x50, 0x0a]);

// The official runner owns the independent five-second complete DOM/runtime watchdog.
// Configuration and expectations belong to its disposable project, never the game checkout.
enabled("Tauri real snake TW save interoperability", () => {
  it("loads the reference pair and optionally saves through the visible game menu", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "the official runner must supply an isolated project");
    const artifact = path.join(project, ".rustyera", "batch5-interop-result.json");
    const evidence = { version: 1, project, result: "running", steps: [] };
    const record = (stage, value) => {
      evidence.steps.push({ stage, ...value });
      console.log(JSON.stringify({ type: "snake-interop-stage", stage, ...value }));
    };
    try {
      const configuration = await readOptionalJson(
        path.join(project, "batch5-interop-config.json"),
      );
      const mode = configuration?.mode ?? "consumer";
      assert.ok(["producer", "consumer"].includes(mode), "unsupported interop mode");
      const expected = await readOptionalJson(path.join(project, "batch5-interop-expect.json"));
      if (mode === "consumer") {
        assert.ok(
          expected?.values && Object.keys(expected.values).length > 0,
          "consumer requires reference values in batch5-interop-expect.json",
        );
      }
      if (expected) validateExpectedValues(expected.values);
      const watches = expected?.values ? Object.keys(expected.values) : defaultWatches;
      evidence.mode = mode;
      evidence.restorePath = "visible title Continue → save1000 → confirm → LOADDATA";
      evidence.clock = configuration?.clock ?? "2026-01-01T00:00:00Z";
      evidence.beforeFiles = await saveIdentities(project);
      for (const name of saveNames) {
        if (expected?.file_sha256?.[name])
          assert.equal(evidence.beforeFiles[name].sha256, expected.file_sha256[name], name);
      }
      await browser.waitUntil(async () => Boolean(await snapshot()), {
        timeout: 20_000,
        interval: 100,
      });
      assert.equal((await snapshot()).bridgeKind, "tauri");
      await browser.execute(
        (clock) =>
          window.__RUSTYERA_TEST__.configure({
            start: { type: "new_game", seed: "123456" },
            clock,
          }),
        evidence.clock,
      );
      const open = await $(".welcome .primary");
      assert.ok(await open.isDisplayed(), "project open must be visible");
      assert.ok(await open.isEnabled(), "project open must be enabled");
      record("open", {
        action: "click",
        selector: ".welcome .primary",
        text: await open.getText(),
      });
      await clickTauriTestElement(browser, open);
      // TW opens its translation/database connections in SYSTEM_TITLE. A fresh-session
      // lifecycle save import skips that game initialization and cannot stand in for LOADDATA.
      await stableWait("title initialization", record);
      const beforeLoadMenu = await clickGameButton(
        /\[\s*1\s*\].*继续游戏/,
        "continue game",
        record,
      );
      await stableWait("load slot menu", record, beforeLoadMenu);
      const beforeLoadSlot = await clickGameButton(/\[\s*1000\s*\]/, "load save1000", record);
      const loadConfirmation = await stableWait("load confirmation", record, beforeLoadSlot);
      assert.ok(loadConfirmation.output.some((line) => line.includes("读取该存档")));
      const beforeLoad = await clickGameButton(/\[\s*0\s*\].*是/, "confirm load", record);
      const loaded = await stableWait("traditional save load", record, beforeLoad);
      record("loaded", { runtime: loaded });
      const initial = await observe(watches);
      evidence.initial = initial;
      assertTypedValues(initial, watches);
      assert.equal(initial.fault, null);
      assertProjectStorage(initial.storage);
      if (expected) assertExpected(initial, expected);
      if (mode === "producer") {
        const beforeMenu = await clickGameButton(/\[\s*200\s*\].*SAVE/i, "open save menu", record);
        await stableWait("save slot menu", record, beforeMenu);
        const beforeSlot = await clickGameButton(/\[\s*1000\s*\]/, "choose save1000", record);
        const confirmation = await stableWait("save overwrite confirmation", record, beforeSlot);
        assert.ok(
          confirmation.output.some((line) => /替换该存档|要将存档存储/.test(line)),
          "the game must explicitly request save confirmation",
        );
        const beforeSave = (await observe([])).storage.records.length;
        const beforeConfirmation = await clickGameButton(/\[\s*0\s*\].*是/, "confirm save", record);
        const saved = await stableWait("save and GLOBAL completion", record, beforeConfirmation);
        record("saved", { runtime: saved });
        evidence.final = await observe(watches);
        assertTypedValues(evidence.final, watches);
        assert.equal(evidence.final.fault, null);
        assertProjectStorage(evidence.final.storage);
        assertSuccessfulWrites(evidence.final.storage.records.slice(beforeSave));
      } else {
        evidence.final = initial;
      }
      evidence.afterFiles = await saveIdentities(project);
      if (mode === "producer")
        assert.notEqual(
          evidence.beforeFiles["save1000.sav"].sha256,
          evidence.afterFiles["save1000.sav"].sha256,
          "producer must replace the ordinary save",
        );
      evidence.result = "passed";
    } catch (error) {
      evidence.result = "failed";
      evidence.error = { name: error.name, message: error.message };
      try {
        evidence.failure = await observe([]);
      } catch (observationError) {
        evidence.observationError = observationError.message;
      }
      throw error;
    } finally {
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, JSON.stringify(evidence, null, 2) + "\n");
      console.log(
        JSON.stringify({
          type: "snake-interop-result",
          result: evidence.result,
          mode: evidence.mode,
          artifact,
          beforeFiles: evidence.beforeFiles,
          afterFiles: evidence.afterFiles,
          error: evidence.error,
        }),
      );
    }
  });
});

async function readOptionalJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveIdentities(project) {
  const identities = {};
  for (const name of saveNames) {
    const bytes = await readFile(path.join(project, "sav", name));
    assert.ok(
      bytes.length >= 12 && bytes.subarray(0, 8).equals(gzipMagic),
      `${name}: expected ERAZIP`,
    );
    assert.equal(bytes.readUInt32LE(8), 1808, `${name}: expected version 1808`);
    identities[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return identities;
}

async function snapshot() {
  return browser.execute(() => {
    const state = window.__RUSTYERA_TEST__?.snapshotSummary();
    if (!state) return null;
    return {
      bridgeKind: state.bridgeKind,
      buildIdentity: state.buildIdentity,
      phase: state.phase,
      status: state.status,
      canInteract: state.canInteract,
      wait: state.wait,
      presentationRevision: state.presentationRevision,
      fault: state.fault,
      output: state.output.slice(-40),
      logs: state.logs.slice(-8),
    };
  });
}

function waitIdentity(state) {
  return JSON.stringify([state?.wait?.wait_id, state?.wait?.generation]);
}

async function stableWait(label, record, preceding) {
  let lastInput = preceding ? waitIdentity(preceding) : null;
  let enterCount = 0;
  return driveRuntimeUntil({
    browser,
    snapshot,
    label,
    totalTimeout: 300_000,
    pollInterval: 100,
    accept: (state) =>
      state?.canInteract &&
      state.wait &&
      waitIdentity(state) !== lastInput &&
      !["enter_key", "any_key"].includes(state.wait.kind),
    advance: async (state) => {
      if (!state?.canInteract || !state.wait || waitIdentity(state) === lastInput) return false;
      assert.ok(["enter_key", "any_key"].includes(state.wait.kind), `${label}: unexpected wait`);
      assert.ok(enterCount++ < 16, `${label}: too many Enter continuations`);
      const prompt = await $(".prompt-bar input");
      const submit = await $(".prompt-bar button[type=submit]");
      assert.ok(
        (await prompt.isDisplayed()) && (await prompt.isEnabled()),
        "visible prompt required",
      );
      assert.ok(
        (await submit.isDisplayed()) && (await submit.isEnabled()),
        "visible submit required",
      );
      lastInput = waitIdentity(state);
      record(label, { action: "Enter", runtime: state, previousValue: await prompt.getValue() });
      await setTauriTestInput(browser, prompt, "");
      await clickTauriTestElement(browser, submit);
      return true;
    },
  });
}

async function clickGameButton(pattern, label, record) {
  const candidates = [];
  for (const button of await $$(".game-viewport button")) {
    if ((await button.isDisplayed()) && (await button.isEnabled())) {
      const text = await button.getText();
      if (pattern.test(text)) candidates.push({ button, text });
    }
  }
  assert.equal(candidates.length, 1, `${label}: expected one visible enabled game button`);
  const { button, text } = candidates[0];
  await button.scrollIntoView();
  assert.ok((await button.isDisplayed()) && (await button.isEnabled()), `${label}: button changed`);
  const state = await snapshot();
  record(label, { action: "click", text, runtime: state });
  await clickTauriTestElement(browser, button);
  return state;
}

async function observe(watches) {
  const trace = process.env.RUSTYERA_TEST_NATIVE_STORAGE_TRACE;
  assert.ok(trace, "official runner must supply native storage capture");
  const storage = nativeStorageCapture(
    await readFile(trace, "utf8"),
    process.env.VITE_RUSTYERA_TEST_PROJECT,
  );
  if (watches.length) assertProjectStorage(storage);
  const typed = watches.length ? await inspectWebdriverTyped(browser, watches) : null;
  const observation = await browser.execute(() => {
    const state = window.__RUSTYERA_TEST__.snapshotSummary();
    const { records, ...summary } = window.__RUSTYERA_TEST__.protocolEvidence([
      "projection_observation",
      "command_rejected",
      "start",
      "client_preferences_applied",
      "state_changed",
      "service_request",
      "service_response",
      "storage_request",
      "storage_response",
    ]);
    return {
      buildIdentity: state.buildIdentity,
      fault: state.fault,
      output: state.output,
      projectionEvidence: records.filter((record) =>
        [
          "projection_observation",
          "command_rejected",
          "start",
          "client_preferences_applied",
          "state_changed",
          "service_request",
          "service_response",
        ].includes(record.message?.type),
      ),
      storage: {
        ...summary,
        records: records.filter((record) =>
          ["storage_request", "storage_response"].includes(record.message?.type),
        ),
      },
    };
  });
  return { ...observation, storage, typed };
}

function assertTypedValues(observation, watches) {
  typedValues(observation.typed, watches);
}

function assertExpected(observation, expected) {
  assert.equal(observation.typed?.version, 1);
  for (const [watch, wanted] of Object.entries(expected.values)) {
    const actual = observation.typed.values[watch];
    assert.equal(actual?.present, true, `${watch}: ${JSON.stringify(actual)}`);
    assert.equal(actual.value.type, wanted.type, `${watch}: value type`);
    assert.equal(
      actual.value.type === "integer" ? String(actual.value.value) : actual.value.value,
      wanted.type === "integer" ? String(wanted.value) : wanted.value,
      `${watch}: exact value`,
    );
  }
  for (const marker of expected.output_contains ?? [])
    assert.ok(
      observation.output.some((line) => line.includes(marker)),
      `missing output ${marker}`,
    );
}
