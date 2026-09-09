import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPerformanceTimingCollector as createCollector,
  parsePerformanceObservationJson,
  readPerformanceAuditTelemetry,
} from "../scripts/tauri-performance-timing-evidence.mjs";

const io = { write: undefined, append: undefined };
function createPerformanceTimingCollector(browser, target) {
  return createCollector(browser, target, {
    writeFile: (...args) => io.write?.(...args) ?? writeFile(...args),
    appendFile: (...args) => io.append?.(...args) ?? appendFile(...args),
  });
}

const directories = [];
afterEach(async () => {
  io.write = undefined;
  io.append = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "rustyera-timing-evidence-"));
  directories.push(root);
  return join(root, "timings");
}
function chunk(from, count, remaining = 0) {
  return {
    atomic: false,
    frontend: {
      schemaVersion: 2,
      epoch: 1,
      nextSequence: from + count + remaining,
      nextLongTaskSequence: 0,
      timingSamplesDropped: 0,
      longTasksDropped: 0,
      remainingSamples: remaining,
      remainingLongTasks: 0,
      longTasks: [],
      timings: Array.from({ length: count }, (_, index) => ({
        epoch: 1,
        sequence: from + index,
        phase: "invoke",
        operation: "pump",
        elapsedMs: 6,
        startedAtMs: from + index,
      })),
    },
    native: {
      schemaVersion: 2,
      epoch: 1,
      nextSequence: from + count + remaining,
      dropped: 0,
      remainingSamples: remaining,
      coreClient: { features: [] },
      setupMessages: [],
      pumps: Array.from({ length: count }, (_, index) => ({
        epoch: 1,
        sequence: from + index,
        operation: "pump",
        requestDecodeMs: 1,
        nativeDriveMs: 2,
        jsonSerializeMs: 1,
        responseBytes: 32,
        events: 1,
        vmInstructions: 10,
        runtimeTransitions: 1,
      })),
    },
  };
}

describe("final replay telemetry transport", () => {
  it("awaits the actual callback and preserves nested values through a scalar wire", async () => {
    const telemetry = chunk(0, 2);
    telemetry.optional = undefined;
    telemetry.native.setupMessages = [{ messageId: "18446744073709551615", text: "\u0000😀" }];
    const performanceAudit = vi.fn(async () => telemetry);
    vi.stubGlobal("window", { __RUSTYERA_TEST__: { performanceAudit } });
    const execute = vi.fn(async (callback) => {
      const wire = await callback();
      expect(typeof wire).toBe("string");
      return wire;
    });
    expect(await readPerformanceAuditTelemetry({ execute })).toEqual({
      ...telemetry,
      optional: null,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(performanceAudit).toHaveBeenCalledOnce();
  });

  it.each(["non-string", "malformed", "oversized", "rejected"])(
    "fails %s results without retrying the actual callback",
    async (failure) => {
      const performanceAudit = vi.fn(async () => {
        if (failure === "rejected") throw new Error("audit unavailable");
        return failure === "oversized" ? { text: "x".repeat(64 * 1024 * 1024) } : chunk(0, 1);
      });
      vi.stubGlobal("window", { __RUSTYERA_TEST__: { performanceAudit } });
      const execute = vi.fn(async (callback) => {
        const wire = await callback();
        if (failure === "non-string") return {};
        return failure === "malformed" ? "{broken" : wire;
      });
      await expect(readPerformanceAuditTelemetry({ execute })).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce();
      expect(performanceAudit).toHaveBeenCalledOnce();
    },
  );
});

describe("bounded authoritative timing evidence", () => {
  it("serializes the resolved audit page inside the WebView and preserves the raw artifact", async () => {
    const target = await directory();
    const page = chunk(0, 512);
    page.optional = undefined;
    const expected = { ...page, optional: null };
    page.native.setupMessages = [{ messageId: "18446744073709551615", text: '\u0000"\\😀\u2028' }];
    const takePerformanceAudit = vi.fn(async () => page);
    vi.stubGlobal("window", { __RUSTYERA_TEST__: { takePerformanceAudit } });
    const execute = vi.fn(async (callback, ...args) => {
      const wire = await callback(...args);
      expect(typeof wire).toBe("string");
      expect(JSON.parse(wire)).toEqual(expected);
      return wire;
    });
    const collector = await createPerformanceTimingCollector({ execute }, target);
    const result = await collector.collect({ kind: "startup" }, true);
    expect(takePerformanceAudit).toHaveBeenCalledExactlyOnceWith(512, true);
    expect(result.identity.setupMessages).toEqual(page.native.setupMessages);
    expect(JSON.parse(await readFile(join(target, "0000.page-000.json"), "utf8")).raw).toEqual(
      expected,
    );
    expect(result.streamEnd.frontend.next).toBe(512);
  });

  it.each([undefined, {}, "{broken", "null", "[]", '"already a string"'])(
    "rejects invalid JSON transport %j without retrying or losing earlier pages",
    async (wire) => {
      const target = await directory();
      const execute = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(chunk(0, 1)))
        .mockResolvedValueOnce(wire);
      const collector = await createPerformanceTimingCollector({ execute }, target);
      await collector.collect({ kind: "startup" });
      await expect(collector.collect({ kind: "action" })).rejects.toThrow(/JSON|object/);
      await expect(collector.collect({ kind: "action" })).rejects.toThrow("failed");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(join(target, "0000.page-000.json"), "utf8")).raw).toEqual(
        chunk(0, 1),
      );
      expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")).status).toBe(
        "failed",
      );
    },
  );

  it.each(["schema", "counter", "nativePage", "nativeTotal", "nativeSequence"])(
    "retains the %s validation after parsing the string transport",
    async (failure) => {
      const target = await directory();
      const page = chunk(0, 0);
      let message;
      if (failure === "schema") {
        page.native.schemaVersion = 3;
        message = "unsupported native timing schema";
      } else if (failure === "counter") {
        page.native.nextSequence = Number.MAX_SAFE_INTEGER + 1;
        message = "invalid counter";
      } else {
        page.native.nativeEvidence = {
          epoch: 1,
          nextSequence: 1,
          remainingRecords: 0,
          cumulativeBytes: 1,
          failure: null,
          records: [{ sequence: 0, offset: 0, totalBytes: 1, cborHex: "80" }],
        };
        if (failure === "nativePage") {
          page.native.nativeEvidence.padding = "x".repeat(512 * 1024);
          message = "page exceeds 512 KiB";
        } else if (failure === "nativeTotal") {
          page.native.nativeEvidence.cumulativeBytes = 64 * 1024 * 1024 + 1;
          message = "exceeds 64 MiB";
        } else {
          page.native.nativeEvidence.records[0].sequence = 1;
          message = "sequence gap";
        }
      }
      const execute = vi.fn().mockResolvedValue(JSON.stringify(page));
      const collector = await createPerformanceTimingCollector({ execute }, target);
      await expect(collector.collect({ kind: "action" })).rejects.toThrow(message);
      expect(JSON.parse(await readFile(join(target, "0000.page-000.json"), "utf8")).raw).toEqual(
        page,
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("persists each sequence once across pages/actions and keeps stage layers separate", async () => {
    const target = await directory();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(chunk(0, 2, 1)))
      .mockResolvedValueOnce(JSON.stringify(chunk(2, 1)))
      .mockResolvedValueOnce(JSON.stringify(chunk(3, 1)));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    const startup = await collector.collect({ kind: "startup" }, true);
    expect(startup.rawPages).toBe(2);
    expect(startup.identity.coreClient).toEqual({ features: [] });
    const action = await collector.collect({ kind: "action", command: 6, inputElapsedMs: 7 });
    expect(action.rawPages).toBe(1);
    expect(execute.mock.calls.map((call) => call.slice(1))).toEqual([
      [512, true],
      [512, false],
      [512, false],
    ]);
    const summary = JSON.parse(await readFile(join(target, startup.summaryFile), "utf8"));
    const sequences = [];
    for (const page of summary.rawPages) {
      expect(page.sha256).toMatch(/^[0-9a-f]{64}$/);
      const raw = JSON.parse(await readFile(join(target, page.file), "utf8"));
      sequences.push(...raw.raw.native.pumps.map((sample) => sample.sequence));
    }
    expect(sequences).toEqual([0, 1, 2]);
    expect(summary.frontendStages[0].durationMs).toEqual({
      count: 3,
      total: 18,
      minimum: 6,
      maximum: 6,
    });
    expect(summary.nativeStages[0].nativeDriveMs.total).toBe(6);
    expect(summary.nativeStages[0].nativeThreadCpuMs.count).toBe(0);
    expect(summary.nativeStages[0].nativeSetupMs.count).toBe(0);
    expect(summary.accounting).toContain("do not sum overlapping");
    expect(summary.probeOverhead).toBe("unmeasured");
    await collector.complete();
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("complete");
    expect(manifest.streams.native).toEqual({ epoch: 1, next: 4, dropped: 0 });
  });

  it("keeps optional CPU and setup attribution separate from wall time", async () => {
    const target = await directory();
    const page = chunk(0, 3);
    Object.assign(page.native.pumps[0], { nativeSetupMs: 0.25, nativeThreadCpuMs: 1.5 });
    Object.assign(page.native.pumps[1], { nativeSetupMs: 0.5, nativeThreadCpuMs: null });
    const collector = await createPerformanceTimingCollector(
      { execute: vi.fn().mockResolvedValue(JSON.stringify(page)) },
      target,
    );
    const result = await collector.collect({ kind: "startup" }, true);
    const summary = JSON.parse(await readFile(join(target, result.summaryFile), "utf8"));
    expect(summary.nativeStages[0].nativeDriveMs.total).toBe(6);
    expect(summary.nativeStages[0].nativeSetupMs).toEqual({
      count: 2,
      total: 0.75,
      minimum: 0.25,
      maximum: 0.5,
    });
    expect(summary.nativeStages[0].nativeThreadCpuMs).toEqual({
      count: 1,
      total: 1.5,
      minimum: 1.5,
      maximum: 1.5,
    });
    expect(summary.nativeCpuAccounting).toContain("excludes SQL owner work");
    expect(summary.probeOverhead).toBe("unmeasured");
    await collector.complete();
  });

  it.each([
    ["nativeThreadCpuMs", -1],
    ["nativeThreadCpuMs", "1"],
    ["nativeSetupMs", -1],
    ["nativeSetupMs", "1"],
  ])("rejects invalid optional %s attribution %s", async (field, value) => {
    const target = await directory();
    const page = chunk(0, 1);
    page.native.pumps[0][field] = value;
    const collector = await createPerformanceTimingCollector(
      { execute: vi.fn().mockResolvedValue(JSON.stringify(page)) },
      target,
    );
    await expect(collector.collect({ kind: "startup" }, true)).rejects.toThrow(
      "invalid timing metric",
    );
    await expect(collector.complete()).rejects.toThrow("failed");
  });

  it("persists a dropped/gapped frontier before rejecting incomplete evidence", async () => {
    const target = await directory();
    const page = chunk(1, 1);
    page.frontend.timingSamplesDropped = 1;
    page.native.dropped = 1;
    const execute = vi.fn().mockResolvedValue(JSON.stringify(page));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    await expect(collector.collect({ kind: "action", command: 6 })).rejects.toThrow("incomplete");
    expect(JSON.parse(await readFile(join(target, "0000.page-000.json"), "utf8")).raw).toEqual(
      page,
    );
    const summary = JSON.parse(await readFile(join(target, "0000.summary.json"), "utf8"));
    expect(summary.complete).toBe(false);
    expect(summary.issues.join(" ")).toContain("dropped changed");
    await expect(collector.complete()).rejects.toThrow("failed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps earlier actions on transfer failure and never retries a consumed page", async () => {
    const target = await directory();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(chunk(0, 1)))
      .mockRejectedValueOnce(new Error("transport lost"));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    await collector.collect({ kind: "action", command: 6 });
    await expect(collector.collect({ kind: "action", command: 7 })).rejects.toThrow(
      "transport lost",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await readdir(target)).toContain("0000.summary.json");
    expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")).status).toBe("failed");
  });

  it("rejects oversized pages before creating a giant artifact", async () => {
    const target = await directory();
    const page = chunk(0, 1);
    page.frontend.timings[0].detail = { text: "x".repeat(1024 * 1024) };
    const collector = await createPerformanceTimingCollector(
      { execute: vi.fn().mockResolvedValue(JSON.stringify(page)) },
      target,
    );
    await expect(collector.collect({ kind: "action" })).rejects.toThrow("page exceeds");
    expect(await readdir(target)).toEqual(["manifest.json"]);
  });

  it("refuses to reuse an existing evidence directory", async () => {
    const target = await directory();
    const browser = { execute: vi.fn() };
    await createPerformanceTimingCollector(browser, target);
    await expect(createPerformanceTimingCollector(browser, target)).rejects.toThrow();
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("accepts independent origin epochs and records the initial pair", async () => {
    const target = await directory();
    const page = chunk(0, 1);
    page.native.epoch = 7;
    page.native.pumps[0].epoch = 7;
    const collector = await createPerformanceTimingCollector(
      { execute: vi.fn().mockResolvedValue(JSON.stringify(page)) },
      target,
    );
    const result = await collector.collect({ kind: "action" });
    const summary = JSON.parse(await readFile(join(target, result.summaryFile), "utf8"));
    expect(summary.originEpochs).toEqual({ frontend: 1, native: 7 });
    expect(summary.complete).toBe(true);
  });

  it.each(["epoch", "sequence", "dropped"])(
    "rejects independent long-task %s corruption",
    async (field) => {
      const target = await directory();
      const page = chunk(0, 0);
      page.frontend.longTasks = [{ epoch: 1, sequence: 0, elapsedMs: 3 }];
      page.frontend.nextLongTaskSequence = 1;
      if (field === "dropped") page.frontend.longTasksDropped = 1;
      else page.frontend.longTasks[0][field] += 1;
      const collector = await createPerformanceTimingCollector(
        { execute: vi.fn().mockResolvedValue(JSON.stringify(page)) },
        target,
      );
      await expect(collector.collect({ kind: "action" })).rejects.toThrow("incomplete");
      expect(await readdir(target)).toContain("0000.page-000.json");
    },
  );

  it("keeps long-task sequences independent of timing sequences and rejects a later origin reset", async () => {
    const target = await directory();
    const first = chunk(0, 2);
    const second = chunk(2, 1);
    first.frontend.longTasks = [{ epoch: 1, sequence: 0, elapsedMs: 5 }];
    first.frontend.nextLongTaskSequence = 1;
    second.frontend.nextLongTaskSequence = 1;
    second.native.epoch = 2;
    second.native.pumps[0].epoch = 2;
    const execute = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(first))
      .mockResolvedValueOnce(JSON.stringify(second));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    const result = await collector.collect({ kind: "action" });
    expect(result.streamEnd.longTasks.next).toBe(1);
    expect(result.streamEnd.frontend.next).toBe(2);
    await expect(collector.collect({ kind: "action" })).rejects.toThrow("epoch changed");
  });

  it.each(["raw", "summary", "index", "success"])(
    "covers slow %s writes with the collection deadline",
    async (stage) => {
      const target = await directory();
      const collector = await createPerformanceTimingCollector(
        { execute: vi.fn().mockResolvedValue(JSON.stringify(chunk(0, 0))) },
        target,
      );
      let late;
      const intercept = (file, text) => {
        const matches =
          stage === "raw"
            ? file.includes(".page-")
            : stage === "summary"
              ? file.endsWith("summary.json")
              : stage === "success"
                ? file.endsWith("manifest.json") && JSON.parse(text).status === "complete"
                : false;
        if (matches)
          return new Promise((resolve) => {
            late = resolve;
          });
      };
      if (stage === "success") await collector.collect({ kind: "final" });
      io.write = intercept;
      if (stage === "index")
        io.append = () =>
          new Promise((resolve) => {
            late = resolve;
          });
      vi.useFakeTimers();
      // Suppress unrelated disk latency so the only outstanding operation is the selected write.
      const write = io.write;
      io.write = (...args) => write(...args) ?? Promise.resolve();
      const result =
        stage === "success" ? collector.complete() : collector.collect({ kind: "final" });
      const rejection = expect(result).rejects.toThrow("30000 ms");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(late).toBeTypeOf("function");
      late();
      await Promise.resolve();
      await Promise.resolve();
      await expect(collector.complete()).rejects.toThrow("failed");
    },
  );

  it("does not retry a timed-out destructive read", async () => {
    const target = await directory();
    const execute = vi.fn(() => new Promise(() => {}));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    vi.useFakeTimers();
    io.write = () => Promise.resolve();
    const rejection = expect(collector.collect({ kind: "action" })).rejects.toThrow("30000 ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    await expect(collector.collect({ kind: "action" })).rejects.toThrow("failed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves the destructive-read write error even if the failure manifest also fails", async () => {
    const target = await directory();
    const execute = vi.fn().mockResolvedValue(JSON.stringify(chunk(0, 1)));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    const original = new Error("raw disk failure");
    io.write = (file) =>
      Promise.reject(file.includes(".page-") ? original : new Error("manifest failure"));
    await expect(collector.collect({ kind: "action" })).rejects.toBe(original);
    expect(original.manifestError).toContain("manifest failure");
    expect(execute).toHaveBeenCalledOnce();
    await expect(collector.collect({ kind: "action" })).rejects.toThrow("failed");
  });

  it.each(["summary", "index"])("retains the raw page if the %s write fails", async (stage) => {
    const target = await directory();
    const execute = vi.fn().mockResolvedValue(JSON.stringify(chunk(0, 1)));
    const collector = await createPerformanceTimingCollector({ execute }, target);
    const error = new Error(`${stage} write failed`);
    if (stage === "summary")
      io.write = (file) => (file.endsWith("summary.json") ? Promise.reject(error) : undefined);
    else io.append = () => Promise.reject(error);
    await expect(collector.collect({ kind: "action" })).rejects.toBe(error);
    expect(await readdir(target)).toContain("0000.page-000.json");
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["collection", "totalPages", "bytes"])(
    "enforces the %s bound without giant disk files",
    async (limit) => {
      const target = await directory();
      let reads = 0;
      const execute = vi.fn(async () => {
        reads += 1;
        const page = chunk(0, 0, limit === "totalPages" && reads % 128 === 0 ? 0 : 1);
        if (limit === "bytes") page.padding = "x".repeat(900_000);
        return JSON.stringify(page);
      });
      const collector = await createPerformanceTimingCollector({ execute }, target);
      io.write = () => Promise.resolve();
      io.append = () => Promise.resolve();
      if (limit === "totalPages") {
        for (let index = 0; index < 16; index += 1) await collector.collect({ kind: "action" });
        await expect(collector.collect({ kind: "action" })).rejects.toThrow("page-count");
        expect(reads).toBe(2048);
      } else {
        await expect(collector.collect({ kind: "action" })).rejects.toThrow(
          limit === "bytes" ? "64 MiB" : "page budget",
        );
        expect(reads).toBeLessThanOrEqual(128);
        if (limit === "collection") expect(reads).toBe(128);
      }
    },
  );
});

describe("performance observation JSON boundary", () => {
  it("counts UTF-8 bytes before parsing and accepts the exact byte boundary", () => {
    const value = {
      text: '门😀\u0000"\\\u2028',
      id: "18446744073709551615",
      bytes: [0, 127, 128, 255],
    };
    const json = JSON.stringify(value);
    const size = Buffer.byteLength(json);
    expect(parsePerformanceObservationJson(json, "observation", size)).toEqual(value);
    expect(() => parsePerformanceObservationJson(json, "observation", size - 1)).toThrow("exceeds");
    // An oversized malformed string fails on size before JSON.parse allocates a tree.
    expect(() => parsePerformanceObservationJson("坏".repeat(5), "observation", 14)).toThrow(
      "exceeds",
    );
  });
});
