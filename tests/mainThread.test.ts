import { afterEach, expect, it, vi } from "vitest";

import { yieldToPaint } from "@/platform/mainThread";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits across two animation frames before continuing startup", async () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });

  let completed = false;
  const pending = yieldToPaint().then(() => {
    completed = true;
  });
  expect(callbacks).toHaveLength(1);
  callbacks.shift()?.(0);
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(callbacks).toHaveLength(1);
  callbacks.shift()?.(16);
  await pending;
  expect(completed).toBe(true);
});

it("falls back to a main-thread turn when animation frames stop", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );

  const pending = yieldToPaint();
  await vi.advanceTimersByTimeAsync(250);
  await pending;

  expect(requestAnimationFrame).toHaveBeenCalledOnce();
});

it("does not wait for animation frames in a hidden document", async () => {
  const frame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

  await yieldToPaint();

  expect(frame).not.toHaveBeenCalled();
});
