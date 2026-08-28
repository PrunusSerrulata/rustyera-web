/* global window */

export const SNAKE_DATA_START = "SNAKE_DATA_START";
export const SNAKE_DATA_MARKERS = Object.freeze([
  "SNAKE_DATA_INDEX=2/main/42",
  "SNAKE_DATA_RESOURCE=1/1/0",
  "SNAKE_DATA_OVERLAY=1/1/1/2",
  "SNAKE_DATA_STRUCTURED=1/station/29/29/42/from-schema",
  "SNAKE_DATA_GLOBAL_MISSING=0/66/55",
  "SNAKE_DATA_GLOBAL=1/7/55/1/12/saved-map/saved-xml",
  "SNAKE_DATA_READY",
]);

export function assertSnakeDataState(state, expectedBridge) {
  if (state?.bridgeKind !== expectedBridge)
    throw new Error(`snake data fixture requires ${expectedBridge}, found ${state?.bridgeKind}`);
  if (state.fault != null)
    throw new Error(`snake data runtime fault: ${JSON.stringify(state.fault)}`);
  if (!state.canInteract || state.wait?.kind !== "integer_value")
    throw new Error("snake data fixture did not reach its final integer input wait");
  const missing = SNAKE_DATA_MARKERS.filter((marker) => !state.output?.includes(marker));
  if (missing.length > 0) throw new Error(`snake data stages are missing: ${missing.join(", ")}`);
  return state;
}

// Native Firefox/Safari and Tauri share WebdriverIO actions. Their runners own
// the independent five-second complete DOM/runtime monitor and stall rejection.
export async function runSnakeDataClient(activeBrowser, expectedBridge) {
  let initial;
  await activeBrowser.waitUntil(
    async () => {
      initial = await activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      if (initial?.fault)
        throw new Error(`snake data runtime fault: ${JSON.stringify(initial.fault)}`);
      return (
        initial?.canInteract &&
        initial.wait?.kind === "integer_value" &&
        initial.output?.includes(SNAKE_DATA_START)
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: "snake data initial input was not reached" },
  );
  if (initial.bridgeKind !== expectedBridge)
    throw new Error(`snake data fixture requires ${expectedBridge}, found ${initial.bridgeKind}`);
  await submitSnakePrompt(activeBrowser, "1");
  let final;
  await activeBrowser.waitUntil(
    async () => {
      final = await activeBrowser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      if (final?.fault) throw new Error(`snake data runtime fault: ${JSON.stringify(final.fault)}`);
      return (
        final?.canInteract &&
        final.wait?.kind === "integer_value" &&
        final.wait.wait_id !== initial.wait.wait_id &&
        final.output?.includes("SNAKE_DATA_READY")
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: "snake data pipeline did not complete" },
  );
  return assertSnakeDataState(final, expectedBridge);
}

export async function submitSnakePrompt(activeBrowser, value) {
  const input = await activeBrowser.$(".prompt-bar input");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.waitForEnabled({ timeout: 5_000 });
  await input.setValue(value);
  if (activeBrowser.capabilities?.browserName?.toLowerCase() === "safari") {
    // SafariDriver can acknowledge a pointer click without submitting the form. setValue leaves
    // the real prompt focused, so use its supported native Enter path, not a synthetic event.
    await activeBrowser.keys("Enter");
  } else await (await activeBrowser.$(".prompt-bar button[type=submit]")).click();
}
