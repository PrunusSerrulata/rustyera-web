import assert from "node:assert/strict";
import { createLifecycleImageGate } from "../../scripts/snake-service-lifecycle-gate.mjs";
import { runSnakeServiceLifecycleClient } from "../../scripts/snake-service-lifecycle-test-support.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_SNAKE_SERVICE_LIFECYCLE === "1" ? describe : describe.skip;
enabled("Tauri snake service lifecycle", () => {
  it("observes real blur, pending cancellation and independent project replacement during image decoding", async () => {
    assert.ok(
      process.env.VITE_RUSTYERA_TEST_PROJECT,
      "runner must supply the isolated lifecycle fixture",
    );
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
    const replacement = process.env.RUSTYERA_LIFECYCLE_REPLACEMENT_PROJECT;
    assert.ok(replacement, "runner must copy the independent successor project");
    const gate = await createLifecycleImageGate(process.env.VITE_RUSTYERA_TEST_PROJECT);
    try {
      const result = await runSnakeServiceLifecycleClient(browser, "tauri", {
        gate,
        prepareReplacement: () =>
          browser.execute(
            (selected) =>
              window.__RUSTYERA_TEST__.configureServiceLifecycle({ projectPaths: [selected] }),
            replacement,
          ),
      });
      console.log(
        JSON.stringify({ project: process.env.VITE_RUSTYERA_TEST_PROJECT, replacement, ...result }),
      );
    } finally {
      console.log(JSON.stringify({ type: "lifecycle-image-stream", ...gate.status() }));
      await gate.close();
    }
  });
});
