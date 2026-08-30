import assert from "node:assert/strict";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";

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
    assert.ok(first.output.includes("SNAKE_SQL_SCALAR=1/alpha"));
    assert.ok(first.output.includes("SNAKE_SQL_READER=1/1"));
    assert.ok(first.output.includes("SNAKE_SQL_WRITE_READER=1/7/0/0/1/1/1"));

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
    const returned = await replaceProject(
      originalProject,
      3,
      "original SQL title after replacement",
    );
    assert.equal(returned.fault, null);
    console.log(
      JSON.stringify({
        project: originalProject,
        replacementProject,
        bridgeKind: returned.bridgeKind,
        verified: [
          "scalar",
          "reader",
          "write reader EOF/close",
          "transaction rollback",
          "durable reopen",
          "project lifecycle reset",
          "independent project Data isolation",
          "A-B-A project replacement",
        ],
        outputs: {
          originalFirst: first.output,
          originalReopened: reopened.output,
          successor: successor.output,
          originalReturned: returned.output,
        },
      }),
    );
  });
});
