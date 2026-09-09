import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PumpBatch, SubmittedPumpBatch } from "@/core/types";
import {
  RuntimePumpCoordinator,
  RuntimePumpResponseCancelled,
  RuntimePumpSubmissionError,
} from "@/stores/runtimePump";

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

  it.each([false, true, undefined])(
    "uses the core continuation hint for output batches (%s)",
    async (immediateWork) => {
      const pump = vi.fn(async () => batch());
      const coordinator = createCoordinator({ pump });
      coordinator.setReady(true);
      await coordinator.submitAndHandle(async () => ({
        ...submittedBatch("output_ready"),
        immediateWork,
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(pump).toHaveBeenCalledTimes(immediateWork === false ? 0 : 1);
      if (immediateWork === false) {
        await vi.advanceTimersByTimeAsync(16);
        expect(pump).toHaveBeenCalledOnce();
      }
      coordinator.clearTimer();
    },
  );

  it("lets a service response cancel the deferred idle poll", async () => {
    const pump = vi.fn(async () => batch());
    const advanceTimedWait = vi.fn(async () => {});
    const coordinator = createCoordinator({ pump, advanceTimedWait });
    coordinator.setReady(true);
    await coordinator.submitAndHandle(async () => ({
      ...submittedBatch("output_ready"),
      immediateWork: false,
    }));
    await vi.advanceTimersByTimeAsync(4);
    await coordinator.submitResponseAndHandle(
      async () => submittedBatch(),
      () => true,
    );
    await vi.advanceTimersByTimeAsync(12);
    expect(pump).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4);
    expect(pump).toHaveBeenCalledOnce();
    expect(advanceTimedWait).toHaveBeenCalledOnce();
    coordinator.clearTimer();
  });

  it("continues cooperative work even when the VM is blocked", async () => {
    const pump = vi.fn(async () => batch());
    const coordinator = createCoordinator({ pump });
    coordinator.setReady(true);
    await coordinator.submitAndHandle(async () => ({
      ...submittedBatch("output_ready"),
      immediateWork: false,
      cooperativeBackgroundWork: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pump).toHaveBeenCalledOnce();
    coordinator.clearTimer();
  });

  it.each(["compute", "cooperative"])(
    "continues bounded %s work without an idle timer",
    async (kind) => {
      const work =
        kind === "compute" ? batch("more_work") : { ...batch(), cooperativeBackgroundWork: true };
      const pump = vi
        .fn<() => Promise<PumpBatch>>()
        .mockResolvedValueOnce(work)
        .mockResolvedValueOnce(work)
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
    },
  );

  it("reports only completed cooperative slices as background progress", async () => {
    const cooperative = { ...batch("more_work"), cooperativeBackgroundWork: true };
    const pump = vi
      .fn<() => Promise<PumpBatch>>()
      .mockResolvedValueOnce(cooperative)
      .mockResolvedValue(batch());
    const coordinator = createCoordinator({ pump });
    coordinator.setReady(true);

    coordinator.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.backgroundWorkRevision).toBe(1);

    await coordinator.submitAndHandle(async () => ({
      ...submittedBatch(),
      cooperativeBackgroundWork: true,
    }));
    expect(coordinator.backgroundWorkRevision).toBe(2);
    coordinator.clearTimer();
  });

  it.each(["compute", "cooperative"])(
    "yields %s work at the contiguous fairness boundary",
    async (kind) => {
      const work =
        kind === "compute" ? batch("more_work") : { ...batch(), cooperativeBackgroundWork: true };
      const pump = vi.fn(async () => work);
      const coordinator = createCoordinator({ pump });
      coordinator.setReady(true);

      coordinator.schedule(0);
      await vi.runOnlyPendingTimersAsync();

      expect(pump).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(1);
      coordinator.clearTimer();
    },
  );

  it("continues cooperative work from a submission without the idle polling delay", async () => {
    const pump = vi.fn(async () => batch());
    const coordinator = createCoordinator({ pump });
    coordinator.setReady(true);
    await coordinator.submitAndHandle(async () => ({
      ...submittedBatch(),
      cooperativeBackgroundWork: true,
    }));

    await vi.advanceTimersByTimeAsync(0);

    expect(pump).toHaveBeenCalledOnce();
    expect(coordinator.backgroundWorkRevision).toBe(1);
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

  it("fuses a detached service response after the current batch finishes", async () => {
    const response = vi.fn(async () => submittedBatch());
    let serviceSubmission!: Promise<SubmittedPumpBatch>;
    let serviceRequested = false;
    const holder: { coordinator?: RuntimePumpCoordinator } = {};
    const coordinator = createCoordinator({
      handleBatch: async () => {
        if (serviceRequested) return;
        serviceRequested = true;
        serviceSubmission = holder.coordinator!.submitResponseAndHandle(response, () => true);
      },
    });
    holder.coordinator = coordinator;
    coordinator.setReady(true);

    await coordinator.submitAndHandle(async () => submittedBatch());
    await expect(serviceSubmission).resolves.toEqual(submittedBatch());

    expect(response).toHaveBeenCalledOnce();
    coordinator.clearTimer();
  });

  it("serializes multiple detached service responses in arrival order", async () => {
    const order: string[] = [];
    let first!: Promise<SubmittedPumpBatch>;
    let second!: Promise<SubmittedPumpBatch>;
    let servicesRequested = false;
    const holder: { coordinator?: RuntimePumpCoordinator } = {};
    const coordinator = createCoordinator({
      handleBatch: async () => {
        if (servicesRequested) return;
        servicesRequested = true;
        first = holder.coordinator!.submitResponseAndHandle(
          async () => {
            order.push("first");
            return submittedBatch();
          },
          () => true,
        );
        second = holder.coordinator!.submitResponseAndHandle(
          async () => {
            order.push("second");
            return submittedBatch();
          },
          () => true,
        );
      },
    });
    holder.coordinator = coordinator;
    coordinator.setReady(true);

    await coordinator.submitAndHandle(async () => submittedBatch());
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
    coordinator.clearTimer();
  });

  it("cancels a detached response retired while the current batch is finishing", async () => {
    let current = true;
    const response = vi.fn(async () => submittedBatch());
    let serviceSubmission!: Promise<SubmittedPumpBatch>;
    const holder: { coordinator?: RuntimePumpCoordinator } = {};
    const coordinator = createCoordinator({
      handleBatch: async () => {
        serviceSubmission = holder.coordinator!.submitResponseAndHandle(response, () => current);
        current = false;
      },
    });
    holder.coordinator = coordinator;
    coordinator.setReady(true);

    await coordinator.submitAndHandle(async () => submittedBatch());

    await expect(serviceSubmission).rejects.toBeInstanceOf(RuntimePumpResponseCancelled);
    expect(response).not.toHaveBeenCalled();
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
