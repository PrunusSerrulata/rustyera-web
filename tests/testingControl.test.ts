import { afterEach, describe, expect, it, vi } from "vitest";

import { inputReplaySummary, isStableObservationCandidate } from "@/testing/control";
import {
  configureServiceLifecycle,
  takeServiceLifecycleDiagnosisExportPath,
} from "@/testing/serviceLifecycle";
import { RuntimeEvidence, readTypedWatches } from "@/testing/runtimeEvidence";
import { blake3 } from "@noble/hashes/blake3.js";

describe("runtime evidence observations", () => {
  afterEach(() => {
    delete window.__RUSTYERA_POINTER_OBSERVATION__;
  });

  it("freezes independent DOM samples at the query boundary without changing wire indices", () => {
    const evidence = new RuntimeEvidence(true);
    const context = {
      presentationRevision: 3n,
      environmentRevision: 4n,
      projectionSpaceRevision: 5n,
    };
    const observation = { sequence: 1, focused: false, visible: true, pointer: null as unknown };
    window.__RUSTYERA_POINTER_OBSERVATION__ = () => observation;
    evidence.receive(
      {
        channel: "runtime",
        epoch: 2n,
        sequence: 1n,
        messageId: 11n,
        message: { type: "service_request", value: { request_id: 9n } },
      },
      7,
    );
    evidence.pointerSample({ requestId: 9n, epoch: 2n, sessionGeneration: 7, context });
    observation.sequence = 2;
    observation.focused = true;
    observation.pointer = { x: 30, y: 50 };
    evidence.sent(
      "runtime",
      { type: "service_response", value: { request_id: 9n } },
      12n,
      2n,
      11n,
      7,
    );
    evidence.pointerSample({ requestId: 10n, epoch: 2n, sessionGeneration: 7, context });
    context.presentationRevision = 99n;
    const snapshot = evidence.snapshot(7) as any;
    expect(snapshot.records.map((row: any) => row.index)).toEqual([0, 1]);
    expect(snapshot.pointerSamples).toEqual([
      {
        index: 0,
        wireIndex: 1,
        requestId: "9",
        epoch: "2",
        sessionGeneration: 7,
        context: {
          presentationRevision: "3",
          environmentRevision: "4",
          projectionSpaceRevision: "5",
        },
        observation: { sequence: 1, focused: false, visible: true, pointer: null },
      },
      {
        index: 1,
        wireIndex: 2,
        requestId: "10",
        epoch: "2",
        sessionGeneration: 7,
        context: {
          presentationRevision: "3",
          environmentRevision: "4",
          projectionSpaceRevision: "5",
        },
        observation: { sequence: 2, focused: true, visible: true, pointer: { x: 30, y: 50 } },
      },
    ]);
    snapshot.pointerSamples[0].observation.focused = true;
    expect((evidence.snapshot() as any).pointerSamples[0].observation.focused).toBe(false);
  });

  it("bounds pointer observations and never lets observer failure affect execution", () => {
    const identity = {
      requestId: 1,
      epoch: 2,
      sessionGeneration: 3,
      context: { presentationRevision: 1, environmentRevision: 1, projectionSpaceRevision: 1 },
    };
    const observer = vi.fn(() => ({ pointer: null }));
    window.__RUSTYERA_POINTER_OBSERVATION__ = observer;
    new RuntimeEvidence(false).pointerSample(identity);
    expect(observer).not.toHaveBeenCalled();
    const bounded = new RuntimeEvidence(true, 4096, 1);
    bounded.pointerSample(identity);
    bounded.sent("runtime", { type: "service_response" }, 1, 2);
    expect(bounded.snapshot()).toMatchObject({
      overflow: true,
      failure: "observation_limit",
      records: [],
    });
    expect((bounded.snapshot() as any).pointerSamples).toHaveLength(1);
    const failed = new RuntimeEvidence(true);
    window.__RUSTYERA_POINTER_OBSERVATION__ = () => {
      throw new Error("DOM unavailable");
    };
    expect(() => failed.pointerSample(identity)).not.toThrow();
    expect(failed.snapshot()).toMatchObject({
      overflow: true,
      failure: "unserializable_observation",
      pointerSamples: [],
    });
  });
  it("preserves exact service integers and bytes without exposing mutable records", () => {
    const evidence = new RuntimeEvidence(true);
    const payload = Uint8Array.of(0xa1, 0, 1);
    evidence.receive({
      channel: "runtime",
      epoch: 2n,
      sequence: 3n,
      messageId: 4n,
      message: { type: "service_request", value: { request_id: 9223372036854775807n, payload } },
    });
    payload[0] = 0;
    const observed = evidence.snapshot() as any;
    expect(observed.records[0]).toMatchObject({
      index: 0,
      direction: "receive",
      epoch: "2",
      message: { value: { request_id: "9223372036854775807", payload: [0xa1, 0, 1] } },
    });
    observed.records[0].message.value.request_id = "changed";
    expect((evidence.snapshot() as any).records[0].message.value.request_id).toBe(
      "9223372036854775807",
    );
  });

  it("discloses overflow instead of truncating a successful-looking capture", () => {
    const evidence = new RuntimeEvidence(true, 1024, 1);
    evidence.sent("runtime", { type: "start" }, 1n, 2n);
    evidence.sent("runtime", { type: "service_response" }, 2n, 2n);
    expect(evidence.snapshot()).toMatchObject({ overflow: true, failure: "observation_limit" });
    expect((evidence.snapshot() as any).records).toHaveLength(1);
    const disabled = new RuntimeEvidence(false, 1, 1);
    disabled.sent("runtime", { type: "start" }, 1n, 2n);
    expect(disabled.snapshot()).toMatchObject({ enabled: false, overflow: false, records: [] });
  });

  it("retains bounded bulk-byte identity after Worker transfer without altering service bytes", () => {
    const evidence = new RuntimeEvidence(true, 4096);
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(19);
    const digest = [...blake3(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const prepared = evidence.prepareMessage({
      type: "state_import_chunk",
      value: { transfer_id: 7n, offset: 0, data: bytes },
    });
    // Node's structuredClone creates its own realm's view; a received browser message uses the
    // receiving realm's Uint8Array. Preserve the transfer while modeling that actual boundary.
    const transferred = new Uint8Array(structuredClone(bytes, { transfer: [bytes.buffer] }).buffer);
    evidence.sent("runtime", prepared, 8n, 2n);
    evidence.receive({
      channel: "runtime",
      epoch: 2n,
      sequence: 4n,
      messageId: 9n,
      message: {
        type: "state_export_chunk",
        value: { transfer_id: 7n, offset: 0, data: transferred },
      },
    });
    evidence.receive({
      channel: "runtime",
      epoch: 2n,
      sequence: 5n,
      messageId: 10n,
      message: {
        type: "state_export_chunk",
        value: { transfer_id: 7n, offset: 0, data: [] },
      },
      dataBytes: transferred,
    });
    const snapshot = evidence.snapshot() as any;
    expect(snapshot.overflow).toBe(false);
    for (const row of snapshot.records)
      expect(row.dataBytes ?? row.message.value.data).toEqual({
        observation: "bulk_bytes_digest",
        byteLength: transferred.byteLength,
        blake3: digest,
      });
    expect(bytes.byteLength).toBe(0);
  });

  it("digests only storage bulk leaves while preserving their typed envelopes", () => {
    const evidence = new RuntimeEvidence(true, 16 * 1024 * 1024);
    const writeBytes = Uint8Array.of(1, 2, 3);
    const readBytes = [4, 5, 6];
    const chunkBytes = Uint8Array.of(7, 8);
    const write = {
      type: "storage_request",
      value: {
        request_id: 10n,
        namespace: "data",
        relative_path: "sql/current",
        idempotency_key: "write-10",
        deadline_ns: 99n,
        operation: {
          type: "write",
          data: writeBytes,
          atomic_replace: true,
          precondition: { type: "revision", revision: "old" },
        },
      },
    };
    const read = {
      type: "storage_response",
      value: {
        request_id: 11n,
        result: { type: "read", data: readBytes, revision: "new" },
      },
    };
    const readChunk = {
      type: "storage_response",
      value: {
        request_id: 12n,
        result: {
          type: "read_chunk",
          data: chunkBytes,
          offset: 64n,
          complete: true,
          change_token: "token",
        },
      },
    };

    evidence.receive({
      channel: "runtime",
      epoch: 2n,
      sequence: 1n,
      messageId: 1n,
      message: write,
    });
    evidence.sent("runtime", read, 2n, 2n);
    evidence.sent("runtime", readChunk, 3n, 2n);

    const snapshot = evidence.snapshot() as any;
    const expectedDigest = (bytes: Uint8Array) => ({
      observation: "bulk_bytes_digest",
      byteLength: bytes.byteLength,
      blake3: [...blake3(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
    expect(snapshot.records[0].message.value).toMatchObject({
      request_id: "10",
      namespace: "data",
      relative_path: "sql/current",
      idempotency_key: "write-10",
      deadline_ns: "99",
      operation: {
        type: "write",
        data: expectedDigest(writeBytes),
        atomic_replace: true,
        precondition: { type: "revision", revision: "old" },
      },
    });
    expect(snapshot.records[1].message.value.result).toEqual({
      type: "read",
      data: expectedDigest(Uint8Array.from(readBytes)),
      revision: "new",
    });
    expect(snapshot.records[2].message.value.result).toEqual({
      type: "read_chunk",
      data: expectedDigest(chunkBytes),
      offset: "64",
      complete: true,
      change_token: "token",
    });
    expect(write.value.operation.data).toBe(writeBytes);
    expect(read.value.result.data).toBe(readBytes);
    expect(readChunk.value.result.data).toBe(chunkBytes);
    const prepared = evidence.prepareMessage(readChunk);
    expect(evidence.prepareMessage(prepared)).toEqual(prepared);
  });

  it("leaves non-bulk storage variants and service payloads intact", () => {
    const evidence = new RuntimeEvidence(true);
    const variants = [
      { type: "storage_request", value: { operation: { type: "read", data: [1, 2] } } },
      { type: "storage_request", value: { operation: { type: "list", data: [1, 2] } } },
      { type: "storage_request", value: { operation: { type: "delete", data: [1, 2] } } },
      { type: "storage_request", value: { operation: { type: "stat", data: [1, 2] } } },
      { type: "storage_request", value: { operation: { type: "read_range", data: [1, 2] } } },
      { type: "storage_response", value: { result: { type: "written", data: [1, 2] } } },
      { type: "storage_response", value: { result: { type: "listed", data: [1, 2] } } },
      { type: "storage_response", value: { result: { type: "deleted", data: [1, 2] } } },
      { type: "storage_response", value: { result: { type: "metadata", data: [1, 2] } } },
      {
        type: "storage_response",
        value: { result: { type: "error", error: { kind: "io", data: [1, 2] } } },
      },
      { type: "service_response", value: { payload: Uint8Array.of(1, 2) } },
    ];
    for (const variant of variants) expect(evidence.prepareMessage(variant)).toBe(variant);
  });

  it("fails storage evidence explicitly for invalid or oversized bulk bytes", () => {
    const invalid = new RuntimeEvidence(true);
    invalid.prepareMessage({
      type: "storage_response",
      value: { result: { type: "read", data: [0, 256] } },
    });
    expect(invalid.snapshot()).toMatchObject({
      overflow: true,
      failure: "unserializable_observation",
    });

    const oversizedState = new RuntimeEvidence(true);
    oversizedState.prepareMessage({
      type: "state_import_chunk",
      value: { data: new Uint8Array(16 * 1024 * 1024 + 1) },
    });
    expect(oversizedState.snapshot()).toMatchObject({
      overflow: true,
      failure: "unserializable_observation",
    });

    const oversizedStorage = new RuntimeEvidence(true);
    oversizedStorage.prepareMessage({
      type: "storage_response",
      value: { result: { type: "read", data: new Uint8Array(64 * 1024 * 1024 + 1) } },
    });
    expect(oversizedStorage.snapshot()).toMatchObject({
      overflow: true,
      failure: "unserializable_observation",
    });
  });

  it("keeps a snake TW sized storage read as a bounded digest record", () => {
    const evidence = new RuntimeEvidence(true);
    const data = new Uint8Array(1_368_064).fill(19);
    evidence.sent(
      "runtime",
      {
        type: "storage_response",
        value: { request_id: 1, result: { type: "read", data, revision: "seed" } },
      },
      1,
      2,
    );

    const snapshot = evidence.snapshot() as any;
    expect(snapshot).toMatchObject({ overflow: false, failure: null });
    expect(snapshot.bytes).toBeLessThan(1024);
    expect(snapshot.records[0].message.value.result.data).toMatchObject({
      observation: "bulk_bytes_digest",
      byteLength: 1_368_064,
    });
  });

  it("distinguishes reused wire identities across actual frontend session generations", () => {
    const evidence = new RuntimeEvidence(true);
    const message = { type: "service_response", value: { request_id: 2 } };
    evidence.sent("runtime", message, 5, 2, undefined, 3);
    evidence.sent("runtime", message, 5, 2, undefined, 4);
    evidence.receive(
      {
        channel: "runtime",
        epoch: 2,
        sequence: 1,
        messageId: 6,
        message: { type: "status", value: {} },
      },
      4,
    );
    const snapshot = evidence.snapshot(4) as any;
    expect(snapshot.sessionGeneration).toBe(4);
    expect(snapshot.records.map((row: any) => row.sessionGeneration)).toEqual([3, 4, 4]);
  });

  it("records serialization failure without changing runtime control flow", () => {
    const evidence = new RuntimeEvidence(true);
    const message: any = { type: "cycle" };
    message.self = message;
    expect(() => evidence.sent("runtime", message, 1, 1)).not.toThrow();
    expect(evidence.snapshot()).toMatchObject({
      overflow: true,
      failure: "unserializable_observation",
    });
  });

  it("paginates typed watches and distinguishes integer values from numeric strings", async () => {
    const commands: any[] = [];
    const stop = { program_generation: 7n };
    const result: any = await readTypedWatches(
      ["RESULT:0", "RESULTS:1", "MISSING"],
      stop,
      async (command) => {
        commands.push(command);
        if (command.type === "list_variables")
          return {
            type: "variable_page",
            value: {
              variables: [
                {
                  name: command.cursor === null ? "RESULT" : "RESULTS",
                  symbol_key: [1],
                  storage: "global",
                  dimensions: [100],
                },
              ],
              next_cursor: command.cursor === null ? 1n : null,
            },
          };
        return {
          type: "variable_value",
          value: {
            value:
              command.value.indices[0] === 0
                ? { type: "integer", value: -9223372036854775808n }
                : { type: "string", value: "-9223372036854775808" },
          },
        };
      },
      () => {},
    );
    expect(result.values["RESULT:0"]).toMatchObject({
      present: true,
      value: { type: "integer", value: -9223372036854775808n },
    });
    expect(result.values["RESULTS:1"]).toMatchObject({
      present: true,
      value: { type: "string", value: "-9223372036854775808" },
    });
    expect(result.values.MISSING).toEqual({ present: false, error: "not_found" });
    expect(commands.filter((command) => command.type === "list_variables")).toHaveLength(2);
    expect(commands.at(-1).value.generation).toBe(7n);
  });

  it("rejects repeated cursors and a changed stop before reading stale values", async () => {
    await expect(
      readTypedWatches(
        ["RESULT"],
        {},
        async () => ({ type: "variable_page", value: { variables: [], next_cursor: 1 } }),
        () => {},
      ),
    ).rejects.toThrow("repeated a cursor");
    await expect(
      readTypedWatches(
        ["RESULT"],
        {},
        async () => undefined,
        () => {
          throw new Error("changed stop");
        },
      ),
    ).rejects.toThrow("changed stop");
  });
});

describe("Web test observation boundaries", () => {
  it("keeps waiting while the runtime is running without an input boundary", () => {
    expect(isStableObservationCandidate("running", false, null)).toBe(false);
    expect(isStableObservationCandidate("waiting_external", false, null)).toBe(false);
  });

  it("accepts interactive, paused, terminal, and fault boundaries", () => {
    expect(isStableObservationCandidate("waiting_input", true, null)).toBe(true);
    expect(isStableObservationCandidate("debug_paused", false, null)).toBe(true);
    expect(isStableObservationCandidate("stopped", false, null)).toBe(true);
    expect(isStableObservationCandidate("running", false, { message: "fault" })).toBe(true);
    expect(isStableObservationCandidate("waiting_input", false, null, true)).toBe(true);
  });

  it("keeps waiting for diagnosis export even at a fault boundary", () => {
    expect(isStableObservationCandidate("faulted", false, { message: "fault" }, false, true)).toBe(
      false,
    );
  });

  it("reports malformed operation-sequence downloads without breaking snapshots", () => {
    expect(inputReplaySummary(new TextEncoder().encode("not-json\n"))).toEqual({
      replayParseError: "input replay line 1 is not valid JSON",
    });
    expect(inputReplaySummary(Uint8Array.of(0xff))).toEqual({
      replayParseError: "input replay is not valid UTF-8",
    });
  });
});

describe("test-only diagnosis export destination", () => {
  afterEach(() => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({});
    vi.unstubAllEnvs();
  });

  it("consumes once and clears unused destinations on the next session configuration", () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ diagnosisExportPath: "/isolated/first/diagnosis.tar.zst" });
    expect(takeServiceLifecycleDiagnosisExportPath()).toBe("/isolated/first/diagnosis.tar.zst");
    expect(takeServiceLifecycleDiagnosisExportPath()).toBeUndefined();
    configureServiceLifecycle({ diagnosisExportPath: "/isolated/old/diagnosis.tar.zst" });
    configureServiceLifecycle({ projectPaths: ["/isolated/new/project"] });
    expect(takeServiceLifecycleDiagnosisExportPath()).toBeUndefined();
  });

  it("rejects non-test configuration and never exposes a path outside test builds", () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ diagnosisExportPath: "/isolated/diagnosis.tar.zst" });
    vi.stubEnv("VITE_RUSTYERA_TEST", "");
    expect(() =>
      configureServiceLifecycle({ diagnosisExportPath: "/isolated/other.tar.zst" }),
    ).toThrow("requires a test build");
    expect(takeServiceLifecycleDiagnosisExportPath()).toBeUndefined();
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    expect(takeServiceLifecycleDiagnosisExportPath()).toBeUndefined();
  });

  it.each([
    "",
    "relative.tar.zst",
    "/",
    "/isolated/",
    "/isolated//file",
    "/isolated/./file",
    "/isolated/../file",
    "/isolated/\0file",
    "/" + "a".repeat(32768),
    null,
    4,
  ])("rejects invalid destination %# without keeping the previous session path", (invalid) => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ diagnosisExportPath: "/isolated/old.tar.zst" });
    expect(() => configureServiceLifecycle({ diagnosisExportPath: invalid as string })).toThrow(
      "absolute normalized isolated file path",
    );
    expect(takeServiceLifecycleDiagnosisExportPath()).toBeUndefined();
  });
});
