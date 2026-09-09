import { describe, expect, it } from "vitest";
import { Encoder } from "cbor-x";
import { coreProtocolActions } from "@/testing/control";
import {
  NativeEvidenceCollector,
  mergeNativeEvidence,
  type NativeEvidencePage,
} from "@/testing/nativeEvidence";

const encoder = new Encoder({
  useRecords: false,
  mapsAsObjects: false,
  variableMapSize: true,
  tagUint8Array: false,
});
const map = (values: unknown[]) => new Map(values.map((value, index) => [index, value]));
function serviceWire(id: number | bigint = 7, result: unknown = [0, [new Uint8Array([42])]]) {
  return [
    1,
    0,
    4,
    9007199254740993n,
    10,
    2,
    12,
    0,
    map([id, 11, "scalar", map([1, 0]), new Uint8Array([1, 2, 3]), null]),
    map([id, result]),
  ];
}
function completion() {
  return encoder.encode(serviceWire());
}
function hex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function page(records: Uint8Array[] = [completion()]): NativeEvidencePage {
  return {
    epoch: 1,
    nextSequence: records.length,
    remainingRecords: 0,
    cumulativeBytes: records.reduce((sum, bytes) => sum + bytes.length + 4096, 0),
    failure: null,
    records: records.map((bytes, sequence) => ({
      sequence,
      offset: 0,
      totalBytes: bytes.length,
      cborHex: hex(bytes),
    })),
  };
}

describe("canonical native service evidence", () => {
  it.each([
    ["8a0100040506020801a5000701010268736c6f742e7361760382058200100460a2000701820081412a", "read"],
    ["8a0100040506020801a5000701010268736c6f742e7361760382058200100460a2000701820180", "written"],
  ])("accepts actual Rust-derived omitted optional fields %s", (wire, resultType) => {
    // Captured by trailing_optional_fields_use_derived_protocol_encoding in the Rust ledger.
    const encoded = Uint8Array.from(wire.match(/../g)!, (pair) => Number.parseInt(pair, 16));
    const collector = new NativeEvidenceCollector();
    collector.accept(page([encoded]));
    const records = collector.take();
    expect(records[0]!.message.value?.operation).toEqual({
      type: "read_range",
      offset: 0,
      maximum_bytes: 16,
      change_token: null,
    });
    expect(records[1]!.message.value?.result).toEqual(
      resultType === "read"
        ? { type: "read", data: new Uint8Array([42]), revision: null }
        : { type: "written", revision: null },
    );
  });

  it("keeps giant response bytes out of checkpoints and restores them through bounded pages", () => {
    const collector = new NativeEvidenceCollector();
    const data = new Uint8Array(700_001).fill(231);
    const projected = collector.projectReplayActions([
      {
        kind: "service_response",
        nativeCompletion: true,
        result: { type: "ready", payload: data },
      },
    ]) as Array<{ result: { payload: { nativeReplayBytes: number; byteLength: number } } }>;
    expect(JSON.stringify(projected).length).toBeLessThan(1024);
    const ref = projected[0]!.result.payload;
    expect(ref.byteLength).toBe(data.length);
    const restored = new Uint8Array(data.length);
    let offset = 0;
    while (offset < data.length) {
      const chunk = collector.takeReplayBytes(ref.nativeReplayBytes, offset);
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(512 * 1024);
      expect(chunk.offset).toBe(offset);
      for (let index = 0; index < chunk.hex.length; index += 2)
        restored[offset++] = Number.parseInt(chunk.hex.slice(index, index + 2), 16);
    }
    expect(restored).toEqual(data);
    expect(collector.projectReplayActions([])).toEqual([]);
  });

  it("merges actual receive sequence and orders fused input before native completion by submit ID", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page());
    const frontend = [
      {
        direction: "receive",
        channel: "runtime",
        epoch: "2",
        sequence: "5",
        messageId: "99",
        message: { type: "presentation_delta" },
      },
      {
        direction: "send",
        channel: "runtime",
        epoch: "2",
        messageId: "10",
        message: { type: "input", value: { intent: { type: "enter" }, message_skip: false } },
      },
    ];
    const records = mergeNativeEvidence(frontend, collector.take());
    expect(records.map((record) => record.message.type)).toEqual([
      "service_request",
      "service_response",
      "presentation_delta",
      "input",
    ]);
    expect(records[0]?.messageId).toBe("9007199254740993");
    expect(records[1]?.correlationId).toBe("10");
    expect(coreProtocolActions(records)).toEqual([
      { kind: "input", intent: { type: "enter" }, messageSkip: false },
      {
        kind: "service_response",
        service: { kind: "sql", operation: "scalar" },
        result: { type: "ready", payload: new Uint8Array([42]) },
        nativeCompletion: true,
      },
    ]);
    expect(collector.take()).toEqual([]);
  });

  it("preserves checkpoint-only pages for export without repeating protocol actions", () => {
    const collector = new NativeEvidenceCollector();
    const captured = page();
    collector.accept(captured);
    collector.take();
    const empty = { ...captured, records: [] };
    collector.accept(empty);
    expect(collector.exportPage(empty)).toEqual({ page: captured, remainingPages: 0 });
    expect(collector.exportPage(empty).page.records).toEqual([]);
  });

  it("rejects duplicated pages and stays invalid", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page());
    expect(() => collector.accept(page())).toThrow("duplicate or sequence gap");
    expect(() => collector.take()).toThrow("duplicate or sequence gap");
  });

  it("rejects an oversized IPC page independently of its logical record size", () => {
    const captured = page();
    captured.records = [
      { sequence: 0, offset: 0, totalBytes: 300_000, cborHex: "ff".repeat(300_000) },
    ];
    captured.cumulativeBytes = 304_096;
    const collector = new NativeEvidenceCollector();
    expect(() => collector.accept(captured)).toThrow("byte limit");
    expect(() => collector.take()).toThrow();
  });

  it("rejects a record kind that does not match its typed protocol fields", () => {
    const wire = serviceWire();
    wire[7] = 1;
    const collector = new NativeEvidenceCollector();
    expect(() => collector.accept(page([encoder.encode(wire)]))).toThrow("schema mismatch");
  });

  it.each([
    { failure: "observation_limit" },
    { nextSequence: 2 },
    { cumulativeBytes: 64 * 1024 * 1024 + 1 },
    { cumulativeBytes: 0.5 },
    { nextSequence: "1" },
  ])("invalidates truncated or oversized capture %j", (invalid) => {
    const collector = new NativeEvidenceCollector();
    expect(() => collector.accept({ ...page(), ...invalid } as NativeEvidencePage)).toThrow();
    expect(() => collector.take()).toThrow();
  });

  it("rejects a native request also exposed by the frontend", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page());
    const native = collector.take();
    expect(() => mergeNativeEvidence([native[0]], native)).toThrow("duplicate");
  });

  it("does not compare independent channel sequences", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page());
    const debug = {
      direction: "receive",
      channel: "debug",
      epoch: "2",
      sequence: "4",
      messageId: "99",
      message: { type: "stopped" },
    };
    expect(mergeNativeEvidence([debug], collector.take())[0]).toBe(debug);
  });

  it("does not pair reused request IDs across runtime epochs", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page());
    const native = collector.take();
    native[1]!.epoch = "3";
    expect(() => coreProtocolActions(native)).toThrow("cannot resolve");
  });

  it.each([9007199254740993n, (1n << 64n) - 1n])("preserves internal request ID %s", (id) => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page([encoder.encode(serviceWire(id))]));
    const records = collector.take();
    expect(records[0]!.message.value!.request_id).toBe(id.toString());
    expect(records[1]!.message.value!.request_id).toBe(id.toString());
    expect(coreProtocolActions(records)).toHaveLength(1);
  });

  it.each([
    [2, [new Uint8Array()]], // There is no ServiceResult::Success or third variant.
    [0, ["fake bytes"]],
    [1, [map([12, "error"])]],
  ])("rejects wrong ServiceResult variants and payload schemas", (tag, args) => {
    const collector = new NativeEvidenceCollector();
    expect(() => collector.accept(page([encoder.encode(serviceWire(7, [tag, args]))]))).toThrow();
    expect(() => collector.take()).toThrow();
  });

  it("accepts actual ServiceResult::Error without masking its code/message", () => {
    const collector = new NativeEvidenceCollector();
    collector.accept(page([encoder.encode(serviceWire(7, [1, [map(["denied", "not allowed"])]]))]));
    expect(collector.take()[1]!.message.value!.result).toEqual({
      type: "error",
      error: { code: "denied", message: "not allowed" },
    });
  });

  it.each(["read", "write"])("reassembles a >512 KiB storage %s across bounded pages", (mode) => {
    const data = new Uint8Array(700_000).map((_, index) => index % 251);
    const wire = [
      1,
      0,
      4,
      9007199254740993n,
      10,
      2,
      12,
      1,
      map([
        (1n << 64n) - 1n,
        1,
        '"\\\n'.repeat(30_000),
        mode === "read" ? [0, []] : [1, [data, true, [0, []]]],
        "key",
        null,
      ]),
      map([(1n << 64n) - 1n, mode === "read" ? [0, [data, "revision"]] : [1, ["revision"]]]),
    ];
    const encoded = encoder.encode(wire);
    const collector = new NativeEvidenceCollector();
    let pages = 0;
    for (let offset = 0; offset < encoded.length; offset += 200_000) {
      const end = Math.min(offset + 200_000, encoded.length);
      const chunk = {
        ...page([]),
        nextSequence: 1,
        cumulativeBytes: encoded.length + 4096,
        remainingRecords: end === encoded.length ? 0 : 1,
        records: [
          {
            sequence: 0,
            offset,
            totalBytes: encoded.length,
            cborHex: hex(encoded.subarray(offset, end)),
          },
        ],
      };
      expect(new TextEncoder().encode(JSON.stringify(chunk)).length).toBeLessThanOrEqual(
        512 * 1024,
      );
      collector.accept(chunk);
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    const records = collector.take();
    expect(
      mode === "read"
        ? records[1]!.message.value!.result.data
        : records[0]!.message.value!.operation.data,
    ).toEqual(data);
    expect(records[0]!.message.value!.request_id).toBe("18446744073709551615");
  });

  it.each([-1, 1.5, 1n << 64n, "18446744073709551616"])("rejects illegal internal ID %s", (id) => {
    const wire = serviceWire();
    (wire[8] as Map<number, unknown>).set(0, id);
    (wire[9] as Map<number, unknown>).set(0, id);
    const collector = new NativeEvidenceCollector();
    expect(() => collector.accept(page([encoder.encode(wire)]))).toThrow();
  });
});
