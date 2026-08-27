/* global window */
import { runSnakeDataClient } from "./snake-data-test-support.mjs";

export const SNAKE_SERVICE_MARKERS = Object.freeze([
  "SNAKE_HTML=0/0/0/1/1/1/1",
  "SNAKE_CANVAS=4294901760/4278190335/2/2",
  "SNAKE_CANVAS_REPLACE=2164195328/4278255360/0/4278255360",
]);

export function assertSnakeServiceState(state, expectedBridge, combined = false) {
  if (state?.bridgeKind !== expectedBridge)
    throw new Error(`snake services require ${expectedBridge}`);
  if (state.fault) throw new Error(`snake service fault: ${JSON.stringify(state.fault)}`);
  if (!state.canInteract || state.wait?.kind !== "integer_value")
    throw new Error("snake services require a final input wait");
  const markers = [
    ...SNAKE_SERVICE_MARKERS,
    combined ? "SNAKE_BATCH1_READY" : "SNAKE_SERVICES_READY",
  ];
  for (const marker of markers)
    if (!state.output?.includes(marker)) throw new Error(`missing service marker: ${marker}`);
  if (!combined) {
    const pointers = state.output.filter((line) => line.startsWith("SNAKE_POINTER="));
    if (pointers.length !== 1 || !/^SNAKE_POINTER=-?\d+\/-?\d+\/41$/.test(pointers[0]))
      throw new Error(`hovered button must preserve script value 41: ${JSON.stringify(pointers)}`);
  }
  return state;
}

async function waitStage(browser, bridgeKind, marker, previousWait) {
  let state;
  await browser.waitUntil(
    async () => {
      state = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
      if (state?.fault) throw new Error(`snake service fault: ${JSON.stringify(state.fault)}`);
      if (state?.bridgeKind && state.bridgeKind !== bridgeKind)
        throw new Error(`expected ${bridgeKind}`);
      return (
        state?.canInteract &&
        state.wait?.kind === "integer_value" &&
        state.wait.wait_id !== previousWait &&
        state.output?.includes(marker)
      );
    },
    { timeout: 60_000, interval: 100, timeoutMsg: `service stage did not complete: ${marker}` },
  );
  return state;
}

// The wrapper owns the independent complete five-second DOM/runtime monitor.
export async function runSnakeServicesClient(browser, bridgeKind) {
  const initial = await waitStage(browser, bridgeKind, "SNAKE_SERVICES_START");
  const input = await browser.$(".prompt-bar input");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.waitForEnabled({ timeout: 5_000 });
  await input.setValue("1");
  await (await browser.$(".prompt-bar button[type=submit]")).click();
  const pointer = await waitStage(browser, bridgeKind, "SNAKE_POINTER_READY", initial.wait.wait_id);
  const target = await browser.$("button=SNAKE_POINTER_TARGET");
  await target.waitForDisplayed({ timeout: 5_000 });
  await target.waitForEnabled({ timeout: 5_000 });
  await target.moveTo();
  await target.click();
  return assertSnakeServiceState(
    await waitStage(browser, bridgeKind, "SNAKE_SERVICES_READY", pointer.wait.wait_id),
    bridgeKind,
  );
}

export async function runSnakeBatch1Client(browser, bridgeKind) {
  return assertSnakeServiceState(await runSnakeDataClient(browser, bridgeKind), bridgeKind, true);
}
