import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForRuntimeProgress } from "./tauri/runtime-progress.mjs";

const observationKey = "__RUSTYERA_TAURI_MONITOR_OBSERVATION__";

afterEach(() => {
  delete globalThis[observationKey];
  vi.useRealTimers();
});

describe("Tauri runtime progress", () => {
  it("consumes complete monitor observations without racing WebDriver snapshots", async () => {
    vi.useFakeTimers();
    const observation = { sequence: 0, runtime: undefined };
    globalThis[observationKey] = observation;
    const browser = { pause: vi.fn() };
    const snapshot = vi.fn();

    const waiting = waitForRuntimeProgress({
      browser,
      snapshot,
      label: "cache hit",
      accept: (state) => state?.startupTelemetry?.cacheHit === true,
      pollInterval: 10,
    });
    await vi.advanceTimersByTimeAsync(0);

    observation.sequence = 1;
    observation.runtime = { startupTelemetry: { cacheHit: true } };
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toEqual(observation.runtime);
    expect(snapshot).not.toHaveBeenCalled();
    expect(browser.pause).not.toHaveBeenCalled();
  });
});
