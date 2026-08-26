import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PumpBatch, SubmittedPumpBatch } from "@/core/types";
import { RuntimePumpCoordinator, RuntimePumpSubmissionError } from "@/stores/runtimePump";

function batch(state: PumpBatch["state"] = "idle"): PumpBatch {
  return { state, vmInstructions: 0, runtimeTransitions: 0, events: [] };
}

function submittedBatch(state: PumpBatch["state"] = "idle"): SubmittedPumpBatch {
  return { ...batch(state), submittedMessageId: 7n };
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

  it("lets urgent input preempt an already scheduled idle pump", async () => {
    const pump = vi.fn(async () => batch());
    const coordinator = createCoordinator({ pump });
    coordinator.setReady(true);

    coordinator.schedule(16);
    coordinator.schedule(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(pump).toHaveBeenCalledOnce();
    coordinator.clearTimer();
  });

  it("continues bounded compute-only work without another timer", async () => {
    const pump = vi
      .fn<() => Promise<PumpBatch>>()
      .mockResolvedValueOnce(batch("more_work"))
      .mockResolvedValueOnce(batch("more_work"))
      .mockResolvedValueOnce(batch("idle"));
    const advanceTimedWait = vi.fn(async () => {});
    const coordinator = createCoordinator({ pump, advanceTimedWait });
    coordinator.setReady(true);

    coordinator.schedule(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(pump).toHaveBeenCalledTimes(3);
    expect(advanceTimedWait).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    coordinator.clearTimer();
  });

  it("yields compute-only work at the contiguous fairness boundary", async () => {
    const pump = vi.fn(async () => batch("more_work"));
    const coordinator = createCoordinator({ pump });
    coordinator.setReady(true);

    coordinator.schedule(0);
    await vi.runOnlyPendingTimersAsync();

    expect(pump).toHaveBeenCalledTimes(8);
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

  it("owns fast submission, projects its batch, and replaces a scheduled pump", async () => {
    const order: string[] = [];
    const pump = vi.fn(async () => batch());
    const handleBatch = vi.fn(async () => {
      order.push("batch");
    });
    const coordinator = createCoordinator({ pump, handleBatch });
    coordinator.setReady(true);
    coordinator.schedule(16);

    const result = await coordinator.submitAndHandle(async () => {
      order.push("submit");
      return submittedBatch("output_ready");
    });

    expect(result).toEqual(submittedBatch("output_ready"));
    expect(order).toEqual(["submit", "batch"]);
    expect(pump).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    coordinator.clearTimer();
  });

  it("falls back instead of deadlocking on a reentrant fast submission", async () => {
    const nestedOperation = vi.fn(async () => submittedBatch());
    let nestedResult: SubmittedPumpBatch | undefined;
    const holder: { coordinator?: RuntimePumpCoordinator } = {};
    const coordinator = createCoordinator({
      handleBatch: async () => {
        nestedResult = await holder.coordinator!.submitAndHandle(nestedOperation);
      },
    });
    holder.coordinator = coordinator;
    coordinator.setReady(true);

    await coordinator.submitAndHandle(async () => submittedBatch());

    expect(nestedResult).toBeUndefined();
    expect(nestedOperation).not.toHaveBeenCalled();
    coordinator.clearTimer();
  });

  it("waits for an in-flight pump before starting fast submission", async () => {
    let releasePump!: (value: PumpBatch) => void;
    const inFlight = new Promise<PumpBatch>((resolve) => {
      releasePump = resolve;
    });
    const order: string[] = [];
    const coordinator = createCoordinator({
      pump: vi.fn(async () => {
        order.push("pump");
        return inFlight;
      }),
      handleBatch: vi.fn(async () => {
        order.push("batch");
      }),
    });
    coordinator.setReady(true);
    coordinator.schedule(0);
    vi.advanceTimersByTime(0);
    await Promise.resolve();

    const submission = coordinator.submitAndHandle(async () => {
      order.push("submit");
      return submittedBatch();
    });
    await Promise.resolve();
    expect(order).toEqual(["pump"]);

    releasePump(batch());
    await vi.advanceTimersByTimeAsync(16);
    await submission;

    expect(order).toEqual(["pump", "batch", "submit", "batch"]);
    coordinator.clearTimer();
  });

  it("routes fast submission failures through fail-closed pump handling", async () => {
    const failure = new Error("submission failed after acceptance became uncertain");
    const handleError = vi.fn();
    const coordinator = createCoordinator({ handleError });
    coordinator.setReady(true);

    await expect(
      coordinator.submitAndHandle(async () => {
        throw failure;
      }),
    ).rejects.toMatchObject({
      name: "RuntimePumpSubmissionError",
      inputMayHaveBeenAccepted: true,
    } satisfies Partial<RuntimePumpSubmissionError>);

    expect(handleError).toHaveBeenCalledWith(failure);
    expect(coordinator.pumping).toBe(false);
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
