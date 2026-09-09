import { decodeServicePayload } from "@/core/serviceCodec";
import { validateProjectionCbor } from "@/core/serviceCborValidation";
import { blake3 } from "@noble/hashes/blake3.js";

/** Only imported by test control; collection/decoding runs outside timed actions. */
type WireRecord = {
  direction: string;
  channel: string;
  epoch?: unknown;
  sequence?: unknown;
  messageId: unknown;
  correlationId?: unknown;
  message: { type: string; value?: Record<string, any> };
  nativeCompletion?: true;
};
export interface NativeEvidenceChunk {
  sequence: number;
  offset: number;
  totalBytes: number;
  cborHex: string;
}
export interface NativeEvidencePage {
  epoch: number;
  nextSequence: number;
  remainingRecords: number;
  cumulativeBytes: number;
  failure: string | null;
  records: NativeEvidenceChunk[];
}
const MAXIMUM_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PAGE_BYTES = 512 * 1024;
const U64_MAX = (1n << 64n) - 1n;

function integer(value: unknown): bigint {
  let result: bigint;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) result = BigInt(value);
  else throw new Error("native evidence has an inexact integer");
  if (result < 0n || result > U64_MAX) throw new Error("native evidence integer out of u64 range");
  return result;
}
function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("native evidence invalid counter");
  return value;
}
export function compareProtocolIdentity(a: unknown, b: unknown): number {
  const left = integer(a),
    right = integer(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A record cursor and a byte cursor: pages do not impose a logical record size cap. */
export class NativeEvidenceCollector {
  private epoch: number | undefined;
  private next = 0;
  private bytes = 0;
  private allocation = 0;
  private frontier = 0;
  private partial: { data: Uint8Array; offset: number } | undefined;
  private pending: ReturnType<typeof parseCompletion>[] = [];
  private exports: NativeEvidencePage[] = [];
  private failure: string | undefined;
  private replayNext = 0;
  private replay = new Map<number, { bytes: Uint8Array; offset: number }>();

  /** Called only while constructing an explicit checkpoint, never while recording an action. */
  projectReplayActions(actions: unknown[]): unknown[] {
    if (this.failure) throw new Error(this.failure);
    if (this.replay.size) {
      this.failure = "native replay bytes were not consumed before the next checkpoint";
      throw new Error(this.failure);
    }
    const project = (value: any): any => {
      if (value instanceof Uint8Array) {
        const id = this.replayNext++;
        this.replay.set(id, { bytes: value, offset: 0 });
        return {
          nativeReplayBytes: id,
          byteLength: value.length,
          blake3: Array.from(blake3(value), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        };
      }
      if (Array.isArray(value)) return value.map(project);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)]));
      return value;
    };
    return actions.map((action: any) => (action.nativeCompletion ? project(action) : action));
  }

  takeReplayBytes(id: number, offset: number): { offset: number; totalBytes: number; hex: string } {
    if (this.failure) throw new Error(this.failure);
    counter(id);
    counter(offset);
    const entry = this.replay.get(id);
    if (!entry || entry.offset !== offset) {
      this.failure = "native replay byte cursor mismatch";
      throw new Error(this.failure);
    }
    const end = Math.min(offset + 250_000, entry.bytes.length);
    let hex = "";
    for (let index = offset; index < end; index++)
      hex += entry.bytes[index]!.toString(16).padStart(2, "0");
    entry.offset = end;
    if (end === entry.bytes.length) this.replay.delete(id);
    return { offset, totalBytes: entry.bytes.length, hex };
  }

  accept(page: NativeEvidencePage): void {
    if (this.failure) throw new Error(this.failure);
    try {
      if (!page || page.failure !== null)
        throw new Error(`native evidence truncated: ${page?.failure}`);
      for (const value of [
        page.epoch,
        page.nextSequence,
        page.remainingRecords,
        page.cumulativeBytes,
      ])
        counter(value);
      if (this.epoch !== undefined && page.epoch !== this.epoch)
        throw new Error("native evidence epoch changed without reset");
      if (!Array.isArray(page.records) || page.records.length > 1024)
        throw new Error("native evidence record page limit exceeded");
      if (
        new TextEncoder().encode(JSON.stringify(page)).length > MAXIMUM_PAGE_BYTES ||
        page.cumulativeBytes > MAXIMUM_BYTES ||
        page.cumulativeBytes < this.allocation ||
        page.nextSequence < this.frontier
      )
        throw new Error("native evidence byte limit or frontier regression");
      for (const chunk of page.records) {
        counter(chunk.sequence);
        counter(chunk.offset);
        counter(chunk.totalBytes);
        if (chunk.sequence !== this.next)
          throw new Error("native evidence duplicate or sequence gap");
        if (
          typeof chunk.cborHex !== "string" ||
          !/^(?:[0-9a-f]{2})+$/.test(chunk.cborHex) ||
          chunk.totalBytes === 0 ||
          chunk.totalBytes > MAXIMUM_BYTES
        )
          throw new Error("native evidence invalid CBOR chunk");
        if (!this.partial) {
          if (chunk.offset !== 0 || this.bytes + chunk.totalBytes > MAXIMUM_BYTES)
            throw new Error("native evidence truncated or oversized record");
          this.partial = { data: new Uint8Array(chunk.totalBytes), offset: 0 };
        }
        const partial = this.partial;
        const length = chunk.cborHex.length / 2;
        if (
          partial.offset !== chunk.offset ||
          partial.data.length !== chunk.totalBytes ||
          length > partial.data.length - partial.offset
        )
          throw new Error("native evidence chunk gap or size mismatch");
        for (let index = 0; index < length; index++)
          partial.data[partial.offset + index] = Number.parseInt(
            chunk.cborHex.slice(index * 2, index * 2 + 2),
            16,
          );
        partial.offset += length;
        if (partial.offset === partial.data.length) {
          const completion = parseCompletion(partial.data);
          if (completion.sequence !== this.next)
            throw new Error("native evidence encoded sequence mismatch");
          this.pending.push(completion);
          this.next++;
          this.bytes += partial.data.length;
          this.partial = undefined;
        }
      }
      if (
        page.nextSequence !== this.next + page.remainingRecords ||
        this.bytes + (this.partial?.data.length ?? 0) > page.cumulativeBytes ||
        (this.partial && page.remainingRecords === 0)
      )
        throw new Error("native evidence truncated frontier");
      this.epoch = page.epoch;
      this.frontier = page.nextSequence;
      this.allocation = page.cumulativeBytes;
      if (page.records.length) this.exports.push(page);
    } catch (error) {
      this.failure = String(error);
      throw error;
    }
  }
  exportPage(fallback: NativeEvidencePage): { page: NativeEvidencePage; remainingPages: number } {
    if (this.failure) throw new Error(this.failure);
    return { page: this.exports.shift() ?? fallback, remainingPages: this.exports.length };
  }
  take(): WireRecord[] {
    if (this.failure) throw new Error(this.failure);
    if (this.partial) {
      this.failure = "native evidence incomplete record at checkpoint";
      throw new Error(this.failure);
    }
    const records = this.pending.flatMap((entry) => [
      { ...entry.request, direction: "receive", nativeCompletion: true as const },
      {
        direction: "send",
        channel: "runtime",
        epoch: entry.request.epoch,
        messageId: entry.responseMessageId,
        correlationId: entry.request.correlationId,
        message: entry.response,
        nativeCompletion: true as const,
      },
    ]);
    this.pending = [];
    return records;
  }
}

function fail(): never {
  throw new Error("native evidence protocol schema mismatch");
}
function array(value: unknown, length?: number): any[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) return fail();
  return value;
}
function optionalTail(args: unknown[], required: number): void {
  if (args.length < required || args.length > required + 1) fail();
}
function fields(value: unknown, required: number[], optional: number[] = []): Map<number, any> {
  if (
    !(value instanceof Map) ||
    required.some((key) => !value.has(key)) ||
    [...value.keys()].some((key) => ![...required, ...optional].includes(key))
  )
    return fail();
  return value;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : fail();
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}
function bytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : fail();
}
function uint(value: unknown, maximum = U64_MAX): number | string {
  // Protocol CBOR integers must really be integers, not decimal text or floats.
  if (typeof value !== "number" && typeof value !== "bigint") return fail();
  const n = integer(value);
  if (n > maximum) return fail();
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value == null ? null : parse(value);
}
function variant(value: unknown): [number, any[]] {
  const pair = array(value, 2);
  return [counter(pair[0]), array(pair[1])];
}
function enumName(value: unknown, names: string[]): string {
  return names[counter(value)] ?? fail();
}
const namespaces = ["project", "save", "global_save", "data", "log", "resource"];
function precondition(value: unknown): object {
  const [tag, args] = variant(value);
  if (tag === 0 || tag === 1) {
    array(args, 0);
    return { type: tag === 0 ? "any" : "missing" };
  }
  if (tag === 2) {
    array(args, 1);
    return { type: "revision", revision: str(args[0]) };
  }
  return fail();
}
function storageOperation(value: unknown): object {
  const [tag, args] = variant(value);
  switch (tag) {
    case 0:
    case 4:
      array(args, 0);
      return { type: tag === 0 ? "read" : "stat" };
    case 1:
      array(args, 3);
      return {
        type: "write",
        data: bytes(args[0]),
        atomic_replace: bool(args[1]),
        precondition: precondition(args[2]),
      };
    case 2:
      array(args, 2);
      return { type: "list", pattern: nullable(args[0], str), recursive: bool(args[1]) };
    case 3:
      array(args, 1);
      return { type: "delete", precondition: precondition(args[0]) };
    case 5:
      optionalTail(args, 2);
      return {
        type: "read_range",
        offset: uint(args[0]),
        maximum_bytes: uint(args[1], 0xffffffffn),
        change_token: nullable(args[2], str),
      };
    default:
      return fail();
  }
}
function storageResult(value: unknown): object {
  const [tag, args] = variant(value);
  switch (tag) {
    case 0:
      optionalTail(args, 1);
      return { type: "read", data: bytes(args[0]), revision: nullable(args[1], str) };
    case 1:
      optionalTail(args, 0);
      return { type: "written", revision: nullable(args[0], str) };
    case 2:
      array(args, 1);
      return {
        type: "listed",
        entries: array(args[0]).map((entry) => {
          const m = fields(entry, [0, 1], [2, 3]);
          return {
            relative_path: str(m.get(0)),
            byte_length: uint(m.get(1)),
            revision: nullable(m.get(2), str),
            change_token: nullable(m.get(3), str),
          };
        }),
      };
    case 3:
      array(args, 0);
      return { type: "deleted" };
    case 4: {
      array(args, 1);
      const m = fields(args[0], [0, 1], [2]);
      const code = m.get(2);
      if (
        code != null &&
        ((typeof code !== "number" && typeof code !== "bigint") ||
          (typeof code === "number" && !Number.isSafeInteger(code)) ||
          BigInt(code) < -(1n << 63n) ||
          BigInt(code) > (1n << 63n) - 1n)
      )
        return fail();
      return {
        type: "error",
        error: {
          kind: enumName(m.get(0), [
            "not_found",
            "permission_denied",
            "invalid_data",
            "interrupted",
            "read_only",
            "already_exists",
            "other",
            "conflict",
          ]),
          message: str(m.get(1)),
          platform_code: code == null ? null : typeof code === "bigint" ? code.toString() : code,
        },
      };
    }
    case 5: {
      array(args, 1);
      const m = fields(args[0], [0], [1]);
      return { type: "metadata", byte_length: uint(m.get(0)), revision: nullable(m.get(1), str) };
    }
    case 6:
      array(args, 4);
      return {
        type: "read_chunk",
        data: bytes(args[0]),
        offset: uint(args[1]),
        complete: bool(args[2]),
        change_token: str(args[3]),
      };
    default:
      return fail();
  }
}
function serviceResult(value: unknown): object {
  const [tag, args] = variant(value);
  array(args, 1);
  if (tag === 0) return { type: "ready", payload: bytes(args[0]) };
  if (tag === 1) {
    const m = fields(args[0], [0, 1]);
    return { type: "error", error: { code: str(m.get(0)), message: str(m.get(1)) } };
  }
  return fail();
}
/** Strictly decode the existing Service/Storage ABI, without a JSON numeric roundtrip. */
function parseCompletion(data: Uint8Array) {
  validateProjectionCbor(data);
  const entry = array(decodeServicePayload(data), 10);
  if (entry[0] !== 1 || (entry[7] !== 0 && entry[7] !== 1)) return fail();
  const service = entry[7] === 0;
  const request = fields(entry[8], [0, 1, 2, 3, 4], [5]);
  const response = fields(entry[9], [0, 1]);
  const requestId = uint(request.get(0));
  if (integer(requestId) !== integer(uint(response.get(0)))) return fail();
  let requestValue: Record<string, any>;
  if (service) {
    const version = fields(request.get(3), [0, 1]);
    requestValue = {
      request_id: requestId,
      kind: enumName(request.get(1), [
        "font_metrics",
        "image",
        "canvas",
        "audio",
        "network",
        "open_url",
        "extension",
        "input_state",
        "clock",
        "entropy",
        "presentation_query",
        "sql",
      ]),
      operation: str(request.get(2)),
      operation_version: {
        major: uint(version.get(0), 65535n),
        minor: uint(version.get(1), 65535n),
      },
      payload: bytes(request.get(4)),
      deadline_ns: nullable(request.get(5), uint),
    };
  } else {
    requestValue = {
      request_id: requestId,
      namespace: enumName(request.get(1), namespaces),
      relative_path: str(request.get(2)),
      operation: storageOperation(request.get(3)),
      idempotency_key: str(request.get(4)),
      deadline_ns: nullable(request.get(5), uint),
    };
  }
  return {
    sequence: counter(entry[1]),
    request: {
      channel: "runtime",
      sequence: String(uint(entry[2])),
      messageId: String(uint(entry[3])),
      correlationId: nullable(entry[4], (value) => String(uint(value))),
      epoch: String(uint(entry[5])),
      message: { type: service ? "service_request" : "storage_request", value: requestValue },
    },
    responseMessageId: String(uint(entry[6])),
    response: {
      type: service ? "service_response" : "storage_response",
      value: {
        request_id: requestId,
        result: service ? serviceResult(response.get(1)) : storageResult(response.get(1)),
      },
    },
  };
}

/** Checkpoint storage is compact; the unmodified lossless bytes remain in CBOR export pages. */
export function compactStorageRecords(records: WireRecord[]): WireRecord[] {
  const compact = (value: Record<string, any> | undefined) => {
    if (!(value?.data instanceof Uint8Array)) return value;
    return {
      ...value,
      data: {
        observation: "bulk_bytes_digest",
        byteLength: value.data.length,
        blake3: Array.from(blake3(value.data), (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        ),
      },
    };
  };
  return records
    .filter((record) => ["storage_request", "storage_response"].includes(record.message.type))
    .map((record) => ({
      ...record,
      message: {
        ...record.message,
        value: {
          ...record.message.value,
          ...(record.message.type === "storage_request"
            ? { operation: compact(record.message.value?.operation) }
            : { result: compact(record.message.value?.result) }),
        },
      },
    }));
}

function scope(record: WireRecord): string {
  return `${record.channel}/${record.epoch == null ? "none" : integer(record.epoch)}`;
}

/** Interleave native request/completion pairs at actual outbound sequence positions.
 * Frontend observation indexes and wall clocks are deliberately not ordering authorities.
 * Core actions separately use the bridge's actual submitted message IDs (fused IPC can log
 * a frontend send after its effects). Independent channels are never numerically compared. */
export function mergeNativeEvidence(frontend: unknown[], native: WireRecord[]): WireRecord[] {
  if (!native.length) return frontend as WireRecord[];
  const pairs = new Map<string, WireRecord[][]>();
  const identities = new Set<string>();
  for (const record of [...(frontend as WireRecord[]), ...native]) {
    const key = `${scope(record)}/${record.direction}/${integer(record.messageId)}`;
    if (identities.has(key)) throw new Error("duplicate native/frontend protocol envelope");
    identities.add(key);
  }
  for (let index = 0; index < native.length; index += 2) {
    const request = native[index]!;
    const response = native[index + 1]!;
    const key = scope(request);
    const list = pairs.get(key) ?? [];
    list.push([request, response]);
    pairs.set(key, list);
  }
  for (const list of pairs.values()) {
    list.sort((a, b) => compareProtocolIdentity(a[0]!.sequence, b[0]!.sequence));
    for (let index = 1; index < list.length; index++)
      if (compareProtocolIdentity(list[index - 1]![0]!.sequence, list[index]![0]!.sequence) === 0)
        throw new Error("duplicate native outbound sequence");
  }
  const cursors = new Map<string, number>();
  const output: WireRecord[] = [];
  for (const record of frontend as WireRecord[]) {
    const key = scope(record);
    const list = pairs.get(key) ?? [];
    let cursor = cursors.get(key) ?? 0;
    if (record.direction === "receive") {
      while (cursor < list.length) {
        const pair = list[cursor]!;
        const order = compareProtocolIdentity(pair[0]!.sequence, record.sequence);
        if (order === 0) throw new Error("duplicate native/frontend outbound sequence");
        if (order > 0) break;
        output.push(...pair);
        cursor++;
      }
    }
    cursors.set(key, cursor);
    output.push(record);
  }
  for (const [key, list] of pairs)
    for (let cursor = cursors.get(key) ?? 0; cursor < list.length; cursor++)
      output.push(...list[cursor]!);
  return output;
}
