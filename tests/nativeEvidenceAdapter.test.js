// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  coreTraceAction,
  validatePerformanceTraceAction,
  performanceCheckpointBehaviorHash,
  capturePerformanceCheckpoint,
} from "../scripts/tauri-performance-trace.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("native completion replay ownership", () => {
  it("restores a large native result outside the checkpoint through bounded binary pages", async () => {
    const bytes = Buffer.alloc(700_001, 239);
    const digest = Buffer.from(blake3(bytes)).toString("hex");
    const raw = {
      phase: "running",
      coreProjection: {
        protocolCursor: 3,
        protocolActions: [
          {
            kind: "service_response",
            nativeCompletion: true,
            service: { kind: "sql", operation: "scalar" },
            result: {
              type: "ready",
              payload: { nativeReplayBytes: 7, byteLength: bytes.length, blake3: digest },
            },
          },
        ],
      },
    };
    const performanceCheckpoint = vi.fn(async () => raw);
    const takeNativeReplayBytes = vi.fn((id, offset) => {
      expect(id).toBe(7);
      const chunk = {
        offset,
        totalBytes: bytes.length,
        hex: bytes.subarray(offset, offset + 250_000).toString("hex"),
      };
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(512 * 1024);
      return chunk;
    });
    vi.stubGlobal("window", {
      __RUSTYERA_TEST__: { performanceCheckpoint, takeNativeReplayBytes },
    });
    const browser = {
      execute: vi.fn(async (callback, ...args) => {
        const wire = await callback(...args);
        // Even the chunk envelope crosses native WebDriver as a scalar. The
        // restored byte array exists only on Node, never as a returned JS array.
        expect(typeof wire).toBe("string");
        expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(512 * 1024);
        return wire;
      }),
    };
    expect(JSON.stringify(raw).length).toBeLessThan(1024);
    const captured = await capturePerformanceCheckpoint(browser, ["FLAG:0"], 0);
    expect(performanceCheckpoint).toHaveBeenCalledExactlyOnceWith(["FLAG:0"], 0);
    expect(takeNativeReplayBytes.mock.calls).toEqual([
      [7, 0],
      [7, 250_000],
      [7, 500_000],
    ]);
    expect(browser.execute).toHaveBeenCalledTimes(4);
    expect(Buffer.from(captured.value.coreProjection.protocolActions[0].result.payload)).toEqual(
      bytes,
    );
    expect(raw.coreProjection.protocolActions[0].result.payload.nativeReplayBytes).toBe(7);
    const full = structuredClone(raw);
    full.coreProjection.protocolActions[0].result.payload = Array.from(bytes);
    expect(captured.hash).toBe(performanceCheckpointBehaviorHash(full));
  });

  it("rejects corrupted native replay pages rather than hashing a partial result", async () => {
    const raw = {
      coreProjection: {
        protocolActions: [
          {
            nativeCompletion: true,
            kind: "service_response",
            result: {
              type: "ready",
              payload: {
                nativeReplayBytes: 1,
                byteLength: 1,
                blake3: Buffer.from(blake3(new Uint8Array([1]))).toString("hex"),
              },
            },
          },
        ],
      },
    };
    const browser = {
      execute: async (_callback, id) =>
        JSON.stringify(Array.isArray(id) ? raw : { offset: 0, totalBytes: 1, hex: "02" }),
    };
    await expect(capturePerformanceCheckpoint(browser, ["FLAG:0"], 0)).rejects.toThrow(
      "digest mismatch",
    );
  });

  it.each([
    ["non-string", { offset: 0, totalBytes: 1, hex: "01" }, "JSON string"],
    ["malformed JSON", "{bad", "invalid JSON"],
    ["null", "null", "object"],
    ["gap", JSON.stringify({ offset: 1, totalBytes: 1, hex: "01" }), "gap"],
    ["length", JSON.stringify({ offset: 0, totalBytes: 2, hex: "01" }), "length changed"],
    [
      "hex",
      JSON.stringify({ offset: 0, totalBytes: 1, hex: "zz" }),
      "invalid native replay byte page",
    ],
    ["truncated", JSON.stringify({ offset: 0, totalBytes: 1, hex: "" }), "truncation"],
    ["overrun", JSON.stringify({ offset: 0, totalBytes: 1, hex: "0102" }), "truncation"],
    [
      "oversized",
      JSON.stringify({ offset: 0, totalBytes: 1, hex: "01", padding: "x".repeat(512 * 1024) }),
      "exceeds",
    ],
  ])("rejects %s replay page transport without retrying", async (_name, wire, error) => {
    const raw = {
      coreProjection: {
        protocolActions: [
          {
            nativeCompletion: true,
            kind: "service_response",
            result: {
              type: "ready",
              payload: {
                nativeReplayBytes: 1,
                byteLength: 1,
                blake3: Buffer.from(blake3(new Uint8Array([1]))).toString("hex"),
              },
            },
          },
        ],
      },
    };
    const execute = vi.fn().mockResolvedValueOnce(JSON.stringify(raw)).mockResolvedValueOnce(wire);
    await expect(capturePerformanceCheckpoint({ execute }, ["FLAG:0"], 0)).rejects.toThrow(error);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects replay bytes above the existing 64 MiB bound before requesting a page", async () => {
    const raw = {
      coreProjection: {
        protocolActions: [
          {
            nativeCompletion: true,
            result: {
              type: "ready",
              payload: {
                nativeReplayBytes: 1,
                byteLength: 64 * 1024 * 1024 + 1,
                blake3: "0".repeat(64),
              },
            },
          },
        ],
      },
    };
    const execute = vi.fn().mockResolvedValue(JSON.stringify(raw));
    await expect(capturePerformanceCheckpoint({ execute }, ["FLAG:0"], 0)).rejects.toThrow(
      "capture bound",
    );
    expect(execute).toHaveBeenCalledOnce();
  });
  it("retains canonical Core responses and strips only the frontend ownership marker", () => {
    const action = {
      kind: "service_response",
      service: { kind: "sql", operation: "scalar" },
      resultRef: "a".repeat(64),
      nativeCompletion: true,
    };
    expect(coreTraceAction(action)).toEqual({
      kind: action.kind,
      service: action.service,
      resultRef: action.resultRef,
    });
    expect(action.nativeCompletion).toBe(true);
  });
  it("does not accept native completions as injectable Tauri UI actions", () => {
    expect(() =>
      validatePerformanceTraceAction(
        { type: "service_response", nativeCompletion: true },
        "map-nf-sql",
      ),
    ).toThrow();
  });
});

describe("route independent completion behavior hash", () => {
  function checkpoint(native, data = [1, 2, 3], revision = "rev1") {
    const bulk = native
      ? data
      : {
          observation: "bulk_bytes_digest",
          byteLength: data.length,
          blake3: Buffer.from(blake3(Uint8Array.from(data))).toString("hex"),
        };
    const records = [
      {
        direction: "receive",
        message: {
          type: "storage_request",
          value: {
            request_id: native ? "18446744073709551615" : 7,
            namespace: "save",
            relative_path: "save.dat",
            operation: { type: "read" },
            deadline_ns: native ? "1000" : 500,
            idempotency_key: native ? "a" : "b",
          },
        },
      },
      {
        direction: "send",
        message: {
          type: "storage_response",
          value: {
            request_id: native ? "18446744073709551615" : 7,
            result: { type: "read", data: bulk, revision },
          },
        },
      },
    ].map((record, index) => ({
      ...record,
      channel: "runtime",
      epoch: native ? "2" : "4",
      sequence: native ? 80 + index : 90 + index,
      index,
      messageId: native ? "18446744073709551614" : "20",
      correlationId: "10",
      ...(native ? { nativeCompletion: true } : { sessionGeneration: 3 }),
    }));
    return {
      phase: "running",
      storage: { version: 1, enabled: true, failure: null, overflow: false, records },
      coreProjection: {
        protocolCursor: native ? 12 : 18,
        protocolActions: [
          {
            kind: "service_response",
            service: { kind: "sql", operation: "scalar" },
            result: { type: "ready", payload: [1, 2, 3] },
            ...(native ? { nativeCompletion: true } : {}),
          },
          {
            kind: "storage_response",
            storage: { namespace: "save", relativePath: "save.dat" },
            result: { type: "read", data: bulk, revision },
            ...(native ? { nativeCompletion: true } : {}),
          },
        ],
      },
    };
  }
  it("hashes the same completion identically through split pump/frontend and native routes", () => {
    const native = checkpoint(true);
    const retained = structuredClone(native);
    expect(performanceCheckpointBehaviorHash(native)).toBe(
      performanceCheckpointBehaviorHash(checkpoint(false)),
    );
    expect(native).toEqual(retained); // The raw evidence still contains exact transport identities.
  });
  it("retains changed bytes and storage revision semantics", () => {
    const baseline = performanceCheckpointBehaviorHash(checkpoint(true));
    expect(performanceCheckpointBehaviorHash(checkpoint(true, [1, 2, 4]))).not.toBe(baseline);
    expect(performanceCheckpointBehaviorHash(checkpoint(true, [1, 2, 3], "rev2"))).not.toBe(
      baseline,
    );
  });
  it("retains SQL payload and error changes", () => {
    const baseline = performanceCheckpointBehaviorHash(checkpoint(true));
    const changed = checkpoint(true);
    changed.coreProjection.protocolActions[0].result.payload = [4];
    expect(performanceCheckpointBehaviorHash(changed)).not.toBe(baseline);
    changed.coreProjection.protocolActions[0].result = {
      type: "error",
      error: { code: "sqlite_error", message: "busy" },
    };
    const errorHash = performanceCheckpointBehaviorHash(changed);
    expect(errorHash).not.toBe(baseline);
    changed.coreProjection.protocolActions[0].result.error.message = "constraint";
    expect(performanceCheckpointBehaviorHash(changed)).not.toBe(errorHash);
  });
});
