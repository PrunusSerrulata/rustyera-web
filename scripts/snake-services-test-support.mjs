/* global window */
import { runSnakeDataClient, submitSnakePrompt } from "./snake-data-test-support.mjs";
import { installPointerObservation } from "./snake-service-lifecycle-test-support.mjs";

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
  await submitSnakePrompt(browser, "1");
  const pointer = await waitStage(browser, bridgeKind, "SNAKE_POINTER_READY", initial.wait.wait_id);
  const target = await browser.$("button=SNAKE_POINTER_TARGET");
  await target.waitForDisplayed({ timeout: 5_000 });
  await target.waitForEnabled({ timeout: 5_000 });
  await installPointerObservation(
    browser,
    '.game-viewport button[aria-label="SNAKE_POINTER_TARGET"]',
  );
  const evidence = {};
  try {
    await target.moveTo();
    evidence.beforeClick = await browser.execute(() => {
      const state = window.__RUSTYERA_TEST__?.snapshot();
      return {
        observation: window.__RUSTYERA_POINTER_OBSERVATION__(),
        runtimeEpoch: state?.runtimeEpoch,
        sessionGeneration: state?.serviceEvidence?.sessionGeneration,
        wireIndex: state?.serviceEvidence?.records.length,
        sampleIndex: state?.serviceEvidence?.pointerSamples.length,
      };
    });
    await target.click();
    evidence.afterClick = await browser.execute(() => window.__RUSTYERA_POINTER_OBSERVATION__());
    const state = await waitStage(
      browser,
      bridgeKind,
      "SNAKE_SERVICES_READY",
      pointer.wait.wait_id,
    );
    return assertSnakeServiceState(state, bridgeKind);
  } catch (error) {
    try {
      evidence.failure = await browser.execute(() => ({
        observation: window.__RUSTYERA_POINTER_OBSERVATION__(),
        state: window.__RUSTYERA_TEST__?.snapshot(),
      }));
    } catch (observationError) {
      evidence.observationError = String(observationError);
    }
    error.servicePointerEvidence = evidence;
    const failureState = evidence.failure?.state;
    const serviceEvidence = failureState?.serviceEvidence;
    const pointerRecords = serviceEvidence?.records?.filter(
      (row) =>
        row.message?.value?.kind === "input_state" &&
        row.message.value.operation === "pointer_state",
    );
    // The complete runtime snapshot can contain the full resource replay and overflow the runner's
    // retained output. Keep the independent DOM events and only the pointer request/reply slice.
    console.error(
      JSON.stringify({
        type: "snake-services-pointer-failure",
        error: String(error),
        evidence: {
          beforeClick: evidence.beforeClick,
          afterClick: evidence.afterClick,
          failure: evidence.failure
            ? {
                observation: evidence.failure.observation,
                state: {
                  runtimeEpoch: failureState?.runtimeEpoch,
                  output: failureState?.output,
                  serviceEvidence: serviceEvidence
                    ? {
                        sessionGeneration: serviceEvidence.sessionGeneration,
                        pointerSamples: serviceEvidence.pointerSamples,
                        records: pointerRecords,
                      }
                    : undefined,
                },
              }
            : undefined,
          observationError: evidence.observationError,
        },
      }),
    );
    throw error;
  } finally {
    await browser.execute(() => {
      window.__RUSTYERA_SERVICE_TRACE__?.dispose();
      delete window.__RUSTYERA_SERVICE_TRACE__;
    });
  }
}

export async function runSnakeBatch1Client(browser, bridgeKind) {
  return assertSnakeServiceState(await runSnakeDataClient(browser, bridgeKind), bridgeKind, true);
}
