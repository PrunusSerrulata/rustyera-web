/* global window */
import { applyBackgroundDomAction } from "./dom-test-input.mjs";

// Serialized by WebDriver along with the existing semantic DOM dispatcher. No
// store mutation or second telemetry stream: this locates the action clock in
// the WebView so command transport/result polling cannot inflate game latency.
export async function measureBackgroundDomAction(element, action, previousIdentity, dispatch) {
  const control = window.__RUSTYERA_TEST__;
  const identity = (wait) =>
    `${wait?.kind ?? ""}:${String(wait?.generation ?? "")}:${String(wait?.waitId ?? wait?.wait_id ?? "")}`;
  let startedAt = null;
  const inputEvidence = dispatch(element, action, null, () => {
    startedAt = performance.now();
  });
  if (startedAt === null) throw new Error("background action did not dispatch");
  const dispatchedAt = performance.now();
  const deadline = startedAt + 30_000;
  let acknowledged = action !== "secondary-click";
  let channel;
  let timer;
  // Preserve the 20ms polling delay but resume from a message task. A chain of
  // timer continuations propagates WebKit's nesting level into the two stable
  // frame timers and can clamp each to 1s. One private channel is reused and closed.
  const waitForProgress = () =>
    new Promise((resolve, reject) => {
      channel ??= new MessageChannel();
      channel.port1.onmessage = () => resolve();
      timer = window.setTimeout(() => {
        timer = undefined;
        try {
          channel.port2.postMessage(null);
        } catch (error) {
          reject(error);
        }
      }, 20);
    });
  try {
    for (;;) {
      const current = control.performanceProgress();
      if (current?.fault) throw new Error(JSON.stringify(current.fault));
      const changed = current?.wait && identity(current.wait) !== previousIdentity;
      const hasIdentity =
        typeof current?.wait?.kind === "string" &&
        (current.wait.waitId != null || current.wait.wait_id != null);
      if (!acknowledged && performance.now() - startedAt >= 1_000)
        throw new Error("right click produced no pending input or wait transition");
      acknowledged ||= current?.canInteract === false || (hasIdentity && Boolean(changed));
      if (acknowledged && current?.canInteract && changed) break;
      if (performance.now() >= deadline) throw new Error("trace action did not settle");
      await waitForProgress();
    }
    const changedAt = performance.now();
    const remaining = deadline - changedAt;
    if (remaining <= 0) throw new Error("trace action did not settle");
    // Preserve the existing consecutive-stable-frame endpoint, including its
    // suppressed-WebView fallback. Full checkpoints remain outside this clock.
    await control.waitForStableObservation(remaining, true, true);
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > 30_000) throw new Error("trace action did not settle");
    return {
      elapsedMs,
      inputEvidence,
      phases: {
        dispatchMs: dispatchedAt - startedAt,
        waitChangeMs: changedAt - dispatchedAt,
        stableMs: elapsedMs - (changedAt - startedAt),
      },
    };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (channel) {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    }
  }
}

export const backgroundDomClockScript = `return (${measureBackgroundDomAction.toString()})(arguments[0], arguments[1], arguments[2], (${applyBackgroundDomAction.toString()}));`;
