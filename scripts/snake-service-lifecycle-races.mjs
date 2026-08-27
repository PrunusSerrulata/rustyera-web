/* global window */

export function lifecycleRecords(state) {
  if (
    !state?.serviceEvidence?.enabled ||
    state.serviceEvidence.overflow ||
    state.serviceEvidence.failure ||
    !state.serviceLifecycle?.enabled ||
    state.serviceLifecycle.failure
  )
    throw new Error("complete real lifecycle/transport evidence is required");
  return { wire: state.serviceEvidence.records, decode: state.serviceLifecycle.records };
}

export function observePendingCanvas(state, sourceUrl, afterIndex) {
  const { wire, decode } = lifecycleRecords(state);
  const starts = decode.filter((row) => row.sourceUrl === sourceUrl && row.phase === "start");
  if (!starts.length) return null;
  if (
    starts.length !== 1 ||
    decode.some(
      (row) => row.sourceUrl === sourceUrl && ["settled", "cancelled"].includes(row.phase),
    )
  )
    throw new Error("image decode is not physically and logically pending");
  const requests = wire.filter(
    (row) =>
      row.index > afterIndex &&
      row.direction === "receive" &&
      row.message?.type === "service_request" &&
      row.message.value?.kind === "canvas" &&
      row.message.value?.operation === "sample_canvas_pixel",
  );
  if (requests.length !== 1)
    throw new Error("pending image needs exactly one actual canvas service request");
  const request = requests[0];
  const authorization = decode.find(
    (row) =>
      row.phase === "resource_authorized" &&
      row.sourceUrl === sourceUrl &&
      row.index < starts[0].index &&
      row.resourceGeneration === starts[0].resourceGeneration &&
      /^[a-f0-9]{64}$/.test(row.sha256) &&
      row.byteLength >= 34 &&
      row.byteLength <= 1024 * 1024,
  );
  if (!authorization) throw new Error("real decode has no preceding authorized source hash");
  if (
    wire.some(
      (row) =>
        row.direction === "send" &&
        row.message?.type === "service_response" &&
        String(row.epoch) === String(request.epoch) &&
        String(row.message.value?.request_id) === String(request.message.value.request_id),
    )
  )
    throw new Error("canvas service already replied before the race action");
  return {
    request,
    authorization,
    decodeStart: starts[0],
    sourceUrl,
    epoch: String(request.epoch),
  };
}

export function assertCancelledLifecycle(
  pending,
  beforeRelease,
  completed,
  requireResourceGeneration,
) {
  const held = lifecycleRecords(beforeRelease);
  const after = lifecycleRecords(completed);
  const old = (row) => row.sourceUrl === pending.sourceUrl;
  const cancelled = held.decode.filter((row) => old(row) && row.phase === "cancelled");
  if (
    cancelled.length !== 1 ||
    cancelled[0].index <= pending.decodeStart.index ||
    held.decode.some((row) => old(row) && row.phase === "settled")
  )
    throw new Error("old image must be actually cancelled while physical decode is still pending");
  if (String(beforeRelease.runtimeEpoch) === pending.epoch || beforeRelease.fault)
    throw new Error(
      "replacement must reach a healthy new runtime epoch before old bytes are released",
    );
  const late = after.wire.filter(
    (row) =>
      row.direction === "send" &&
      row.message?.type === "service_response" &&
      String(row.epoch) === pending.epoch &&
      String(row.message.value?.request_id) === String(pending.request.message.value.request_id),
  );
  if (late.length) throw new Error("retired service produced a stale reply");
  const settled = after.decode.filter((row) => old(row) && row.phase === "settled");
  if (settled.length !== 1 || settled[0].index <= cancelled[0].index)
    throw new Error("old physical decode has no unique late settlement");
  const freshRequest = held.wire.find(
    (row) =>
      row.index > pending.request.index &&
      row.direction === "receive" &&
      String(row.epoch) === String(beforeRelease.runtimeEpoch) &&
      row.message?.type === "service_request" &&
      row.message.value?.kind === "canvas" &&
      row.message.value?.operation === "sample_canvas_pixel",
  );
  if (
    !freshRequest ||
    !held.wire.some(
      (row) =>
        row.direction === "send" &&
        row.message?.type === "service_response" &&
        String(row.epoch) === String(freshRequest.epoch) &&
        String(row.message.value?.request_id) === String(freshRequest.message.value.request_id) &&
        row.message.value?.result?.type === "ready",
    )
  )
    throw new Error("new epoch canvas request did not complete while old decode was held");
  const freshDecode = held.decode.find(
    (row) =>
      row.phase === "settled" &&
      row.resourceId === "resources/lifecycle-next.png" &&
      row.resourceGeneration > pending.decodeStart.resourceGeneration &&
      row.outcome === "resolved",
  );
  if (requireResourceGeneration && !freshDecode)
    throw new Error("independent project did not observe a newer real resource generation");
  return {
    pending,
    cancelled: cancelled[0],
    settled: settled[0],
    freshRequest,
    freshDecode,
    beforeReleaseEpoch: beforeRelease.runtimeEpoch,
    afterReleaseEpoch: completed.runtimeEpoch,
  };
}

const snapshot = (browser) => browser.execute(() => window.__RUSTYERA_TEST__.snapshot());
async function wait(browser, label, accept) {
  let state;
  await browser.waitUntil(
    async () => {
      state = await snapshot(browser);
      if (state.fault) throw new Error(JSON.stringify(state.fault));
      return accept(state);
    },
    { timeout: 15_000, interval: 50, timeoutMsg: label },
  );
  return state;
}
async function submit(browser, value) {
  await (await browser.$(".prompt-bar input")).setValue(value);
  await browser.keys("Enter");
}
async function restart(browser) {
  await (await browser.$("#menu-file")).click();
  await (await (await browser.$(".menu-popup")).$("button=重新开始")).click();
  const confirm = await browser.$("[role=dialog][aria-label='重新开始游戏'] .danger");
  await confirm.waitForDisplayed({ timeout: 3_000 });
  await confirm.click();
  return wait(
    browser,
    "restart did not create a fresh lifecycle session",
    (state) => state.canInteract && state.output.includes("SNAKE_LIFECYCLE_START"),
  );
}

/** Both races use real UI, an actual image.decode() and an unchanged fixture byte stream. */
export async function runLifecycleRaces(browser, bridgeKind, options) {
  if (!options?.gate || !options.prepareReplacement)
    throw new Error("lifecycle races require a real image gate and independent project picker");
  const evidence = [];
  for (const mode of ["cancel-by-restart", "switch-independent-project"]) {
    await restart(browser);
    if (mode === "switch-independent-project") await options.prepareReplacement();
    const gate = options.gate.arm(mode);
    await browser.execute(
      (value) => window.__RUSTYERA_TEST__.configureServiceLifecycle({ gate: value }),
      gate,
    );
    const before = await snapshot(browser);
    const afterIndex = lifecycleRecords(before).wire.at(-1)?.index ?? -1;
    await submit(browser, "90");
    let pending;
    await wait(browser, "no real decode/service pending window was observed", (state) => {
      const stream = options.gate.status();
      if (stream.closed || stream.timedOut)
        throw new Error("real PNG stream ended before the race action");
      pending = observePendingCanvas(state, gate.url, afterIndex);
      return pending && stream.requested && !stream.released;
    });
    const actionStart = await snapshot(browser);
    // Recheck immediately before the visible action; a resource prefix alone is not service evidence.
    observePendingCanvas(actionStart, gate.url, afterIndex);
    if (mode === "cancel-by-restart") {
      await restart(browser);
      await submit(browser, "1");
    } else {
      await (await browser.$("#menu-file")).click();
      await (await (await browser.$(".menu-popup")).$("button=打开项目…")).click();
      const dialog = await browser.$(".dialog-panel[aria-label='打开新项目']");
      await dialog.waitForDisplayed({ timeout: 3_000 });
      await (await dialog.$("button=打开新项目")).click();
    }
    const marker =
      mode === "cancel-by-restart"
        ? "SNAKE_LIFECYCLE_POINTER_READY"
        : "SNAKE_LIFECYCLE_NEW_PROJECT=4278255360/4294901760";
    const beforeRelease = await wait(
      browser,
      "new services remained blocked behind cancelled decode",
      (state) =>
        state.bridgeKind === bridgeKind &&
        state.canInteract &&
        state.output.includes(marker) &&
        String(state.runtimeEpoch) !== pending.epoch &&
        lifecycleRecords(state).decode.some(
          (row) => row.sourceUrl === pending.sourceUrl && row.phase === "cancelled",
        ) &&
        lifecycleRecords(state).wire.some(
          (row) =>
            row.direction === "send" &&
            row.message?.type === "service_response" &&
            String(row.epoch) === String(state.runtimeEpoch) &&
            row.message.value?.result?.type === "ready",
        ),
    );
    const heldStream = options.gate.status();
    if (!heldStream.requested || heldStream.released || heldStream.closed || heldStream.timedOut)
      throw new Error("old PNG must remain physically incomplete until new services finish");
    options.gate.release();
    const completed = await wait(
      browser,
      "old decoder did not settle after real PNG bytes were released",
      (state) =>
        lifecycleRecords(state).decode.some(
          (row) => row.sourceUrl === gate.url && row.phase === "settled",
        ),
    );
    evidence.push({
      mode,
      ...assertCancelledLifecycle(
        pending,
        beforeRelease,
        completed,
        mode === "switch-independent-project",
      ),
      actionStart,
      beforeRelease,
      completed,
      stream: options.gate.status(),
    });
  }
  return evidence;
}
