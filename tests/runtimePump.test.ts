import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PumpBatch } from "@/core/types";
import { RuntimePumpCoordinator } from "@/stores/runtimePump";

function batch(state: PumpBatch["state"] = "idle"): PumpBatch {
  return { state, vmInstructions: 0, runtimeTransitions: 0, events: [] };
}

describe("runtime pump coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("schedules work only for a ready, stable session", () => {
    const coordinator = createCoordinator();

    coordinator.schedule(0);
    expect(vi.getTimerCount()).toBe(0);

    coordinator.setReady(true);
    coordinator.setTransitioning(true);
    coordinator.schedule(0);
    expect(vi.getTimerCount()).toBe(0);

    coordinator.setTransitioning(false);
    coordinator.schedule(0);
    coordinator.schedule(0);
    expect(vi.getTimerCount()).toBe(1);

    coordinator.clearTimer();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("samples timed waits at the next drive boundary before projecting its batch", async () => {
    const order: string[] = [];
    const handleBatch = vi.fn(async () => {
      order.push("batch");
    });
    const advanceTimedWait = vi.fn(async () => {
      order.push("time");
    });
    const pump = vi.fn(async () => {
      order.push("pump");
      return batch();
    });
    const coordinator = createCoordinator({ pump, handleBatch, advanceTimedWait });
    coordinator.setReady(true);

    coordinator.schedule(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(pump).toHaveBeenCalledOnce();
    expect(handleBatch).toHaveBeenCalledWith(batch());
    expect(advanceTimedWait).toHaveBeenCalledOnce();
    expect(order).toEqual(["time", "pump", "batch"]);
    expect(coordinator.pumping).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    coordinator.clearTimer();
  });

  it("reports bridge failures without leaving a pump in flight", async () => {
    const failure = new Error("pump failed");
    const handleError = vi.fn();
    const coordinator = createCoordinator({
      pump: vi.fn(async () => {
        throw failure;
      }),
      handleError,
    });
    coordinator.setReady(true);

    coordinator.schedule(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(handleError).toHaveBeenCalledWith(failure);
    expect(coordinator.pumping).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createCoordinator(
  overrides: Partial<{
    pump: () => Promise<PumpBatch>;
    handleBatch: (batch: PumpBatch) => Promise<void>;
    advanceTimedWait: () => Promise<void>;
    handleError: (error: unknown) => void;
  }> = {},
): RuntimePumpCoordinator {
  return new RuntimePumpCoordinator(
    { pump: overrides.pump ?? vi.fn(async () => batch()) },
    {
      handleBatch: overrides.handleBatch ?? vi.fn(async () => {}),
      advanceTimedWait: overrides.advanceTimedWait ?? vi.fn(async () => {}),
      handleError: overrides.handleError ?? vi.fn(),
    },
  );
}
