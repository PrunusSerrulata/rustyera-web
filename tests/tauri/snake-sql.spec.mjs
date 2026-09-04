import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";
import {
  assertSnakeSqlContractFollowupOutput,
  assertSnakeSqlContractOutput,
} from "../snakeSqlContract.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_SQL === "1" ? describe : describe.skip;

enabled("Tauri snake SQL integration", () => {
  it("publishes durable isolated SQLite revisions across title and project replacement", async () => {
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshot())),
      { timeout: 20_000, interval: 100 },
    );
    assert.equal(
      await browser.execute(() => window.__RUSTYERA_TEST__.snapshot().bridgeKind),
      "tauri",
    );
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    const snapshot = () => browser.execute(() => window.__RUSTYERA_TEST__.snapshot());
    const first = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "first persistent SQL title",
      accept: (state) =>
        state?.canInteract === true && state.output?.includes("SNAKE_SQL_PERSIST=1"),
    });
    assertSnakeSqlContractOutput(first.output, 1);

    await $("button=文件").click();
    await $("button=返回标题").click();
    const dialog = await $(".dialog-panel[aria-label='返回标题']");
    await dialog.waitForDisplayed();
    await dialog.$("button=返回标题").click();

    const reopened = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "reopened persistent SQL title",
      accept: (state) =>
        state?.canInteract === true && state.output?.includes("SNAKE_SQL_PERSIST=2"),
    });
    assert.equal(reopened.fault, null);
    assertSnakeSqlContractOutput(reopened.output, 2);
    await $(".prompt-bar input").setValue("0");
    await $(".prompt-bar button[type=submit]").click();
    const omitted = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "omitted SQL parameter after durable reopen",
      accept: (state) =>
        state?.canInteract === true && state.output?.includes("SNAKE_SQL_OMITTED=1"),
    });
    assert.equal(omitted.fault, null);
    const contractOutput = [...omitted.output];
    assert.equal(contractOutput.at(-3), "");
    contractOutput.splice(-3, 1);
    assertSnakeSqlContractFollowupOutput(contractOutput, 2);

    const originalProject = process.env.VITE_RUSTYERA_TEST_PROJECT;
    const replacementProject = process.env.RUSTYERA_SQL_REPLACEMENT_PROJECT;
    assert.ok(originalProject, "runner must supply the isolated SQL fixture");
    assert.ok(replacementProject, "runner must supply an independent SQL successor fixture");

    const replaceProject = async (selected, persist, label) => {
      await browser.execute(
        (projectPath) =>
          window.__RUSTYERA_TEST__.configureServiceLifecycle({ projectPaths: [projectPath] }),
        selected,
      );
      await $("button=文件").click();
      await $("button=打开项目…").click();
      const dialog = await $(".dialog-panel[aria-label='打开新项目']");
      await dialog.waitForDisplayed();
      await dialog.$("button=打开新项目").click();
      return waitForRuntimeProgress({
        browser,
        snapshot,
        label,
        accept: (state) =>
          state?.canInteract === true && state.output?.includes(`SNAKE_SQL_PERSIST=${persist}`),
      });
    };

    const successor = await replaceProject(
      replacementProject,
      1,
      "independent successor SQL title",
    );
    assert.equal(successor.fault, null);
    assertSnakeSqlContractOutput(successor.output, 1);
    const returned = await replaceProject(
      originalProject,
      3,
      "original SQL title after replacement",
    );
    assert.equal(returned.fault, null);
    assertSnakeSqlContractOutput(returned.output, 3, 0);
    console.log(
      JSON.stringify({
        project: originalProject,
        replacementProject,
        bridgeKind: returned.bridgeKind,
        verified: [
          "scalar",
          "reader",
          "parameter omission and Unicode",
          "MAP XML duplicate-key and inner-XML normalization",
          "write reader EOF/close",
          "transaction commit/rollback",
          "durable reopen",
          "project lifecycle reset",
          "independent project Data isolation",
          "A-B-A project replacement",
        ],
        outputs: {
          originalFirst: first.output,
          originalReopened: reopened.output,
          originalOmittedParameter: omitted.output,
          successor: successor.output,
          originalReturned: returned.output,
        },
      }),
    );
  });
});
