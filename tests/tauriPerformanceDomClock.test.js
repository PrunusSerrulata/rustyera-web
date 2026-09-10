import { runInThisContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { applyBackgroundDomAction } from "../scripts/dom-test-input.mjs";
import {
  backgroundDomClockScript,
  measureBackgroundDomAction,
} from "../scripts/tauri-performance-dom-clock.mjs";

const channels = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port2.close).toHaveBeenCalledOnce();
    expect(channel.port1.onmessage).toBeNull();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.__RUSTYERA_TEST__;
  document.body.replaceChildren();
});

function fixture() {
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = { onmessage: null, close: vi.fn() };
      port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage?.()), close: vi.fn() };
      constructor() {
        channels.push(this);
      }
    },
  );
  const element = document.createElement("button");
  document.body.append(element);
  element.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 20 });
  const progress = {
    canInteract: true,
    fault: null,
    wait: { kind: "integer_value", generation: 1, waitId: 1 },
  };
  const control = {
    performanceProgress: vi.fn(() => progress),
    waitForStableObservation: vi.fn(async () => {}),
  };
  window.__RUSTYERA_TEST__ = control;
  return { element, progress, control };
}

it.each(["click", "secondary-click"])(
  "times real %s handlers and the original stable endpoint, excluding setup",
  async (action) => {
    const { element, progress, control } = fixture();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    element.getBoundingClientRect = () => {
      now += 400;
      return { left: 10, top: 20, width: 100, height: 20 };
    };
    const events = [];
    for (const type of ["click", "mousedown", "mouseup", "contextmenu"])
      element.addEventListener(type, (event) => {
        events.push([event.type, event.button, event.buttons]);
        now += 3;
        progress.wait.waitId = 2;
      });
    control.waitForStableObservation.mockImplementation(async (timeout, summary, lightweight) => {
      expect(timeout).toBe(30_000 - (action === "click" ? 3 : 9));
      expect([summary, lightweight]).toEqual([true, true]);
      now += 32;
    });
    // Execute the exact complete request body and arguments sent to WebDriver.
    const request = runInThisContext(`(function () { ${backgroundDomClockScript} })`);
    now += 5_000; // inbound transport
    const measured = await request(element, action, "integer_value:1:1");
    now += 10_000; // outbound transport
    expect(measured.elapsedMs).toBe(action === "click" ? 35 : 41);
    expect(measured.phases).toEqual({
      dispatchMs: action === "click" ? 3 : 9,
      waitChangeMs: 0,
      stableMs: 32,
    });
    expect(measured.inputEvidence.mode).toBe("background-dom");
    expect(events).toEqual(
      action === "click"
        ? [["click", 0, 0]]
        : [
            ["mousedown", 2, 2],
            ["mouseup", 2, 0],
            ["contextmenu", 2, 0],
          ],
    );
    expect(control.waitForStableObservation).toHaveBeenCalledOnce();
  },
);

it("does not complete before the existing stable-frame promise resolves", async () => {
  const { element, progress, control } = fixture();
  element.addEventListener("click", () => {
    progress.wait.waitId = 2;
  });
  let finish;
  control.waitForStableObservation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let completed = false;
  const pending = measureBackgroundDomAction(
    element,
    "click",
    "integer_value:1:1",
    applyBackgroundDomAction,
  ).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  finish();
  await pending;
  expect(completed).toBe(true);
});

it("reuses and closes one message channel over a long observer polling chain", async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { element, progress, control } = fixture();
  element.addEventListener("click", () => {
    progress.canInteract = false;
  });
  const pending = measureBackgroundDomAction(
    element,
    "click",
    "integer_value:1:1",
    applyBackgroundDomAction,
  );
  for (let i = 0; i < 12; i++) {
    now += 20;
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(channels).toHaveLength(1);
  expect(control.waitForStableObservation).not.toHaveBeenCalled();
  progress.canInteract = true;
  progress.wait.waitId = 2;
  now += 20;
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).phases.waitChangeMs).toBe(260);
  expect(control.waitForStableObservation).toHaveBeenCalledOnce();
});

it.each(["unacknowledged", "malformed", "pending", "fault", "stable-failure", "late-stable"])(
  "rejects %s rather than publishing a latency",
  async (failure) => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { element, progress, control } = fixture();
    element.addEventListener("contextmenu", () => {
      if (failure === "malformed") progress.wait = {};
      if (failure === "pending") progress.canInteract = false;
      if (failure === "fault") progress.fault = { code: "actual-fault" };
      if (failure.includes("stable")) progress.wait.waitId = 2;
    });
    if (failure === "stable-failure")
      control.waitForStableObservation.mockRejectedValue(new Error("stable failed"));
    if (failure === "late-stable")
      control.waitForStableObservation.mockImplementation(async () => {
        now = 30_001;
      });
    const pending = measureBackgroundDomAction(
      element,
      "secondary-click",
      "integer_value:1:1",
      applyBackgroundDomAction,
    );
    const expected =
      failure === "fault"
        ? "actual-fault"
        : failure === "stable-failure"
          ? "stable failed"
          : failure === "pending" || failure === "late-stable"
            ? "trace action did not settle"
            : "right click produced no pending input or wait transition";
    const assertion = expect(pending).rejects.toThrow(expected);
    if (["pending", "unacknowledged", "malformed"].includes(failure))
      now = failure === "pending" ? 30_001 : 1_001;
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  },
);

it("rejects an unavailable target before opening the action clock", async () => {
  const { element, control } = fixture();
  element.disabled = true;
  const now = vi.spyOn(performance, "now");
  const request = runInThisContext(`(function () { ${backgroundDomClockScript} })`);
  const publish = vi.fn();
  await expect(request(element, "click", "integer_value:1:1").then(publish)).rejects.toThrow(
    "rendered enabled",
  );
  expect(publish).not.toHaveBeenCalled();
  expect(now).not.toHaveBeenCalled();
  expect(control.performanceProgress).not.toHaveBeenCalled();
});

it.each([
  [999, true],
  [1001, true],
  [999, false],
])("enforces first acknowledgment at %sms and settle=%s", async (at, settled) => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { element, progress, control } = fixture();
  const pending = measureBackgroundDomAction(
    element,
    "secondary-click",
    "integer_value:1:1",
    applyBackgroundDomAction,
  );
  const assertion =
    at < 1000 && settled
      ? expect(pending).resolves.toMatchObject({ elapsedMs: 999 })
      : expect(pending).rejects.toThrow(
          settled
            ? "right click produced no pending input or wait transition"
            : "trace action did not settle",
        );
  now = at;
  if (settled) progress.wait.waitId = 2;
  else progress.canInteract = false;
  await vi.advanceTimersByTimeAsync(20);
  if (!settled) {
    now = 30_001;
    await vi.advanceTimersByTimeAsync(20);
  }
  await assertion;
  expect(control.waitForStableObservation).toHaveBeenCalledTimes(at < 1000 && settled ? 1 : 0);
});
