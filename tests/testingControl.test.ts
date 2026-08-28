import { afterEach, describe, expect, it, vi } from "vitest";

import { inputReplaySummary, isStableObservationCandidate } from "@/testing/control";
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
