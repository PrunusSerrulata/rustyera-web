import assert from "node:assert/strict";
import {
  captureConfiguration,
  prepareCaptureInputs,
} from "../../scripts/snake-service-capture-io.mjs";
import {
  runServiceOracleCapture,
  webdriverCaptureClient,
} from "../../scripts/snake-service-capture-client.mjs";
import { focusCurrentTauriWindow } from "../../scripts/tauri-test-support.mjs";

const enabled =
  process.env.VITE_RUSTYERA_TAURI_SNAKE_SERVICE_ORACLE === "1" ? describe : describe.skip;
enabled("real Tauri exact service oracle capture", () => {
  it("captures actual service transport and typed observations without comparison substitution", async () => {
    const config = await captureConfiguration(
      process.argv,
      process.env.RUSTYERA_SERVICE_CAPTURE_SOURCE_PROJECT,
      "tauri",
      process.env.RUSTYERA_SERVICE_CAPTURE_NATIVE_BINARY,
    );
    const inputs = await prepareCaptureInputs(config);
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshot())),
      { timeout: 20000, interval: 50 },
    );
    await browser.execute(
      (seed) =>
        window.__RUSTYERA_TEST__.configure({
          start: { type: "new_game", seed: String(seed) },
          clock: "2026-01-01T00:00:00Z",
        }),
      config.fixtureManifest.seed,
    );
    await $(".welcome .primary").click();
    const client = webdriverCaptureClient(browser);
    const geometry = async (stage) => {
      const value = await browser.execute(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        nodes: [
          "html",
          "body",
          "#app",
          ".app-shell",
          ".game-area",
          ".game-viewport",
          ".prompt-bar",
          ".prompt-bar input",
          ".status-bar",
          ".menu-row",
        ].map((selector) => {
          const node = document.querySelector(selector);
          if (!node) return { selector, missing: true };
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            selector,
            width: box.width,
            height: box.height,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            minWidth: style.minWidth,
            columns: style.gridTemplateColumns,
            display: style.display,
            text: node === document.querySelector(".prompt-bar") ? node.textContent : undefined,
          };
        }),
      }));
      console.log(JSON.stringify({ type: "tauri-oracle-geometry", stage, ...value }));
      for (const selector of [".game-area", ".game-viewport"]) {
        const node = value.nodes.find((entry) => entry.selector === selector);
        assert.ok(node && !node.missing, `${stage}: missing ${selector}`);
        assert.ok(
          node.width <= value.innerWidth + 0.5,
          `${stage}: ${selector} overflows the window`,
        );
      }
      return value.nodes.find((entry) => entry.selector === ".game-viewport").clientWidth;
    };
    client.submit = async (value) => {
      // Native archive export is a separate foreground boundary from initial project opening.
      // Restore the session window explicitly; the provider still rejects unfocused input.
      await focusCurrentTauriWindow(browser);
      const input = await browser.$(".prompt-bar input");
      await input.waitForDisplayed({ timeout: 5000 });
      await input.waitForEnabled({ timeout: 5000 });
      const width = await geometry("before-input");
      await input.setValue(value);
      assert.equal(await geometry("after-fill"), width, "typing changed the viewport width");
      await browser.keys("Enter");
      assert.equal(await geometry("after-submit"), width, "submitting changed the viewport width");
    };
    const capture = await runServiceOracleCapture(client, config, inputs);
    console.log(JSON.stringify({ type: "snake-service-oracle-capture", ...capture }));
    if (capture.status === "captured_with_observation_blocks")
      throw new Error(`capture retained blocked typed observations: ${capture.manifestPath}`);
  });
});
