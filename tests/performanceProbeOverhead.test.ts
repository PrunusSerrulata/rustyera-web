import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { capturePerformanceProgress } from "@/testing/control";
import {
  assertSnapshotProgress,
  capturePerformanceProgressSnapshot,
} from "../scripts/tauri-test-support.mjs";

const flush = vi.hoisted(() => ({
  callbacks: [] as Array<() => void>,
  rejects: [] as Array<(error: Error) => void>,
  calls: 0,
}));
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  nextTick: () => {
    flush.calls += 1;
    return new Promise<void>((resolve, reject) => {
      flush.callbacks.push(resolve);
      flush.rejects.push(reject);
    });
  },
}));

describe("performance probe overhead boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flush.callbacks.length = 0;
    flush.rejects.length = 0;
    flush.calls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("observes authoritative revisions without visiting output, resources, geometry or memory", () => {
    const forbidden = () => {
      throw new Error("heavy observation entered measured polling");
    };
    const presentation = {
      revision: 8,
      historyRevision: 7,
      scene: { revision: 6 },
      inputWait: { kind: "integer_value", wait_id: 5n, generation: 3n },
    };
    for (const field of ["lines", "resources", "htmlIsland", "audio"])
      Object.defineProperty(presentation, field, { get: forbidden });
    const store = {
      bridgeKind: "tauri",
      phase: "waiting_input",
      runtimeEpoch: 2n,
      status: "ready",
      projectOpen: true,
      projectLoading: false,
      canInteract: true,
      presentation,
      fault: null,
      logs: [],
      testRuntimeEvidenceSummary: () => ({ failure: null, overflow: false }),
      testTransferState: () => ({ export: null }),
      liveMemoryCounters: forbidden,
      testRuntimeEvidence: forbidden,
      clientWindowGeometrySnapshot: forbidden,
    };
    vi.spyOn(document, "querySelector").mockImplementation(forbidden);
    const before = capturePerformanceProgress(store as any);
    expect(before).toMatchObject({
      runtimeEpoch: "2",
      presentationRevision: 8,
      historyRevision: 7,
      sceneRevision: 6,
      wait: { wait_id: "5", generation: "3" },
      serviceEvidence: { failure: null },
    });
    presentation.revision += 1;
    expect(capturePerformanceProgress(store as any).presentationRevision).toBe(9);
  });

  it("does not silently fall back to a heavy snapshot in the performance watchdog", async () => {
    const previous = window.__RUSTYERA_TEST__;
    const progress = { phase: "running", presentationRevision: 4, fault: null };
    const performanceProgress = vi.fn(() => progress);
    const snapshotSummary = vi.fn(() => {
      throw new Error("full snapshot is forbidden");
    });
    window.__RUSTYERA_TEST__ = { performanceProgress, snapshotSummary } as any;
    const query = vi.spyOn(document, "querySelectorAll");
    try {
      const browser = { execute: async (operation: () => unknown) => operation() };
      expect(await capturePerformanceProgressSnapshot(browser)).toEqual({
        observationMode: "performance-progress",
        runtime: progress,
      });
      expect(performanceProgress).toHaveBeenCalledOnce();
      expect(snapshotSummary).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      window.__RUSTYERA_TEST__ = { snapshotSummary } as any;
      await expect(capturePerformanceProgressSnapshot(browser)).rejects.toThrow();
    } finally {
      window.__RUSTYERA_TEST__ = previous;
    }
  });

  it("keeps a progress request bounded at 30 seconds", async () => {
    const result = capturePerformanceProgressSnapshot({
      execute: () => new Promise(() => {}),
    });
    const assertion = expect(result).rejects.toThrow("exceeded 30000 ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a 30-second progress watchdog without relaxing ordinary E2E snapshots", () => {
    const progress = { observationMode: "performance-progress", runtime: { phase: "running" } };
    expect(() => assertSnapshotProgress(progress, progress, "audit", 5)).not.toThrow();
    expect(() => assertSnapshotProgress(progress, progress, "audit", 6)).toThrow("stalled");
    const complete = { document: [], runtime: { phase: "running" } };
    expect(() => assertSnapshotProgress(complete, complete, "E2E", 1)).toThrow("stalled");
  });

  it("coalesces flush/paint observers and cancels suppressed animation callbacks on timeout", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    audit.recordPublishedPresentationRevision(1);
    for (let index = 0; index < 1_000; index += 1) audit.scheduleDomFlushMeasurement(0, 1);
    expect(flush.calls).toBe(1);
    flush.callbacks.shift()?.();
    await Promise.resolve();
    expect(frames.size).toBe(1);
    for (let index = 0; index < 1_000; index += 1) audit.scheduleDomFlushMeasurement(0, 1);
    expect(flush.calls).toBe(1);
    audit.recordPublishedPresentationRevision(2);
    audit.scheduleDomFlushMeasurement(0, 1);
    flush.callbacks.shift()?.();
    await Promise.resolve();
    expect(frames.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames.size).toBe(0);
    const timings = audit.performanceAuditSnapshot().timings as Array<{ phase: string }>;
    expect(timings.filter((sample) => sample.phase === "dom_flush")).toHaveLength(2);
    expect(timings.filter((sample) => sample.phase === "next_paint")).toHaveLength(1);
  });

  it("does not hold an audit-build input submission behind a pending Vue flush", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    const { RuntimePumpCoordinator } = await import("@/stores/runtimePump");
    const batch = {
      state: "idle" as const,
      events: [],
      vmInstructions: 0,
      runtimeTransitions: 0,
      submittedMessageId: 1n,
    };
    const coordinator = new RuntimePumpCoordinator({ pump: async () => batch } as any, {
      handleBatch: async () => {
        audit.recordPublishedPresentationRevision(1);
      },
      advanceTimedWait: async () => {},
      handleError: (error) => {
        throw error;
      },
    });
    coordinator.setReady(true);
    try {
      await expect(coordinator.submitAndHandle(async () => batch)).resolves.toEqual(batch);
      expect(flush.calls).toBe(1);
      expect(flush.callbacks).toHaveLength(1);
      expect(coordinator.pumping).toBe(false);
    } finally {
      coordinator.clearTimer();
    }
  });

  it("takes only new bounded timing records without resetting authority counters", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    audit.recordPerformanceElapsed("loading", "first", 2);
    audit.recordPerformanceElapsed("decode", "second", 3);
    const first = audit.takePerformanceAudit(1) as any;
    expect(first.timings.map((sample: any) => sample.sequence)).toEqual([0]);
    expect(first.nextSequence).toBe(2);
    expect(first.remainingSamples).toBe(1);
    const second = audit.takePerformanceAudit(1) as any;
    expect(second.timings.map((sample: any) => sample.sequence)).toEqual([1]);
    expect(second.epoch).toBe(first.epoch);
    expect(second.nextSequence).toBe(2);
    expect(second.remainingSamples).toBe(0);
    expect(second.timingSamplesDropped).toBe(0);
    expect((audit.takePerformanceAudit(1) as any).timings).toEqual([]);
    const ring = new audit.PerformanceAuditRingBuffer<number>(2);
    ring.push(0);
    ring.push(1);
    ring.push(2);
    expect(ring.take(1)).toEqual([1]);
    expect(ring.dropped).toBe(1);
    expect(ring.take(1)).toEqual([2]);
    expect(ring.dropped).toBe(1);
    expect(() => ring.take(0)).toThrow("limit");
  });

  it("retires old flush callbacks without clearing the first new-epoch observer; SQL-only adds none", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    audit.scheduleDomFlushMeasurement(0, 1);
    expect(flush.calls).toBe(0);
    audit.recordPublishedPresentationRevision(1);
    audit.scheduleDomFlushMeasurement(0, 1);
    const old = flush.callbacks.shift()!;
    audit.resetPerformanceAudit();
    audit.recordPublishedPresentationRevision(1);
    audit.scheduleDomFlushMeasurement(0, 1);
    old();
    await Promise.resolve();
    audit.scheduleDomFlushMeasurement(0, 1);
    expect(flush.calls).toBe(2);
    flush.callbacks.shift()!();
    await Promise.resolve();
    expect((audit.performanceAuditSnapshot().timings as any[]).map((row) => row.operation)).toEqual(
      ["coalesced_vue_next_tick"],
    );
    audit.resetPerformanceAudit();
  });

  it("handles rejected nextTick with bounded diagnostics and no unhandled rejection", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    audit.recordPublishedPresentationRevision(1);
    audit.scheduleDomFlushMeasurement(0, 1);
    flush.rejects.shift()!(new Error("x".repeat(100_000)));
    await Promise.resolve();
    await Promise.resolve();
    await expect(audit.waitForPendingPerformanceObservations()).rejects.toThrow("incomplete");
    audit.scheduleDomFlushMeasurement(0, 1);
    expect(flush.calls).toBe(1);
    expect(JSON.stringify(audit.performanceAuditSnapshot())).not.toContain("xxx");
    expect((audit.performanceAuditSnapshot().timings as any[])[0].operation).toBe(
      "observer_rejected",
    );
    audit.resetPerformanceAudit();
  });

  it("cancels old paint ownership at reset and ignores a late frame after a new paint starts", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    audit.scheduleNextPaintMeasurement(0);
    const old = frames.shift()!;
    audit.resetPerformanceAudit();
    expect(cancel).toHaveBeenCalled();
    audit.scheduleNextPaintMeasurement(0);
    old(0);
    audit.scheduleNextPaintMeasurement(0);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    frames.shift()!(0);
    await expect(audit.waitForPendingPerformanceObservations()).resolves.toBeUndefined();
    expect(audit.performanceAuditSnapshot().timings as any[]).toHaveLength(1);
  });

  it("waits for the existing flush and its paint child, not newly scheduled background work", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    audit.recordPublishedPresentationRevision(1);
    audit.scheduleDomFlushMeasurement(0, 1);
    let settled = false;
    const waiting = audit.waitForPendingPerformanceObservations().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    flush.callbacks.shift()!();
    await Promise.resolve();
    expect(settled).toBe(false);
    frames.shift()!(0);
    frames.shift()!(0);
    audit.recordPublishedPresentationRevision(2);
    audit.scheduleDomFlushMeasurement(0, 1);
    await waiting;
    expect(flush.callbacks).toHaveLength(1);
    audit.resetPerformanceAudit();
  });

  it("retains a suppressed paint's terminal timeout without claiming an actual paint", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    audit.scheduleNextPaintMeasurement(0);
    const waiting = audit.waitForPendingPerformanceObservations();
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(audit.performanceAuditSnapshot().timings).toEqual([
      expect.objectContaining({
        phase: "next_paint",
        detail: expect.objectContaining({ timedOut: true }),
      }),
    ]);
    audit.resetPerformanceAudit();
  });

  it("marks a pending final observer timeout incomplete", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    const audit = await import("@/testing/performanceAudit");
    audit.recordPublishedPresentationRevision(1);
    audit.scheduleDomFlushMeasurement(0, 1);
    const rejection = expect(audit.waitForPendingPerformanceObservations(30_000)).rejects.toThrow(
      "incomplete",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    audit.resetPerformanceAudit();
  });

  it("exports independent long-task sequences with their authority epoch", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
    let deliver!: (list: {
      getEntries: () => Array<{ startTime: number; duration: number }>;
    }) => void;
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(callback: typeof deliver) {
          deliver = callback;
        }
        observe() {}
      },
    );
    const audit = await import("@/testing/performanceAudit");
    audit.installPerformanceAuditObservers();
    audit.recordPerformanceElapsed("decode", "first", 1);
    audit.recordPerformanceElapsed("decode", "second", 1);
    deliver({
      getEntries: () => [
        { startTime: 1, duration: 5 },
        { startTime: 6, duration: 7 },
      ],
    });
    const first = audit.takePerformanceAudit(1) as any;
    const second = audit.takePerformanceAudit(1) as any;
    expect(first.longTasks[0]).toMatchObject({ epoch: first.epoch, sequence: 0 });
    expect(second.longTasks[0]).toMatchObject({ epoch: first.epoch, sequence: 1 });
    expect(second.nextLongTaskSequence).toBe(2);
    audit.resetPerformanceAudit();
    deliver({ getEntries: () => [{ startTime: 9, duration: 3 }] });
    const reset = audit.takePerformanceAudit(1) as any;
    expect(reset.longTasks[0]).toMatchObject({ epoch: first.epoch + 1, sequence: 0 });
    expect(reset.longTasksDropped).toBe(0);
  });

  it.each([false, true])(
    "uses explicit progressOnly=%s in an audit build",
    async (progressOnly) => {
      vi.resetModules();
      vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", "1");
      const lines = vi.fn(() => []);
      const store = {
        phase: "waiting_input",
        canInteract: true,
        logs: [],
        presentation: {
          revision: 1,
          historyRevision: 1,
          scene: { revision: 1 },
          audio: [],
          get lines() {
            return lines();
          },
        },
        testRuntimeEvidenceSummary: () => ({}),
        testRuntimeEvidence: () => ({}),
        testBackgroundWorkRevision: () => 0,
        clientWindowGeometrySnapshot: () => ({}),
        liveMemoryCounters: () => ({}),
        testAudioPlaybackState: () => ({}),
        testAudioProviderState: () => ({}),
        testTransferState: () => ({}),
      };
      vi.doMock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));
      const previous = window.__RUSTYERA_TEST__;
      try {
        const { installWebTestControl } = await import("@/testing/control");
        installWebTestControl({} as any);
        const result = window.__RUSTYERA_TEST__!.waitForStableObservation(
          1000,
          false,
          progressOnly,
        );
        await vi.advanceTimersByTimeAsync(100);
        const observed = await result;
        if (progressOnly) {
          expect(lines).not.toHaveBeenCalled();
          expect(observed).not.toHaveProperty("output");
        } else {
          expect(lines.mock.calls.length).toBeGreaterThan(2);
          expect(observed).toHaveProperty("output");
        }
      } finally {
        vi.doUnmock("@/stores/runtime");
        window.__RUSTYERA_TEST__ = previous;
      }
    },
  );
});
