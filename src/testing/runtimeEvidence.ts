import type { ProjectionQueryContext, ServiceInteger } from "@/core/runtimeServiceProtocol";
import type { WebEvent } from "@/core/types";
import { blake3 } from "@noble/hashes/blake3.js";

const MAXIMUM_STATE_CHUNK_BYTES = 16 * 1024 * 1024;
const MAXIMUM_STORAGE_BYTES = 64 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

declare global {
  interface Window {
    /** Test-runner-owned, read-only DOM observation; never a source of runtime values. */
    __RUSTYERA_POINTER_OBSERVATION__?: () => unknown;
  }
}

/** Bounded observations only: capture failure must never change execution or invent a reply. */
export class RuntimeEvidence {
  private readonly records: string[] = [];
  private readonly messageTypes: Array<string | undefined> = [];
  private readonly pointerSamples: string[] = [];
  private bytes = 0;
  private failure: string | null = null;

  constructor(
    private readonly enabled: boolean,
    // A real TW failed compile report alone exceeds 16 MiB. Keep it lossless while
    // retaining a finite ledger bound; periodic snapshots use summary(), not this payload.
    private readonly maximumBytes = 64 * 1024 * 1024,
    private readonly maximumRecords = 8192,
  ) {}

  receive(event: WebEvent, sessionGeneration = 0): void {
    this.record({
      direction: "receive",
      ...event,
      message: this.prepareMessage(event.message),
      // Both real bridge hosts separate exported chunk bytes from the JSON message.
      dataBytes:
        event.message.type === "state_export_chunk"
          ? this.prepareBulkBytes(event.dataBytes)
          : event.dataBytes,
      sessionGeneration,
    });
  }

  /** Snapshot bulk transfers before Worker ownership detaches the source buffer. Service CBOR and
   * typed values remain complete; only file/snapshot chunks use an explicit length/hash observation. */
  prepareMessage(message: unknown): unknown {
    if (!this.enabled || this.failure !== null || message == null || typeof message !== "object")
      return message;
    const entry = message as { type?: string; value?: Record<string, unknown> };
    if (entry.type === "state_import_chunk" || entry.type === "state_export_chunk")
      return {
        ...entry,
        value: this.prepareDataContainer(entry.value, MAXIMUM_STATE_CHUNK_BYTES),
      };
    if (entry.type === "storage_request") {
      const operation = entry.value?.operation as Record<string, unknown> | undefined;
      if (operation?.type !== "write") return message;
      return {
        ...entry,
        value: {
          ...entry.value,
          operation: this.prepareDataContainer(operation, MAXIMUM_STORAGE_BYTES),
        },
      };
    }
    if (entry.type === "storage_response") {
      const result = entry.value?.result as Record<string, unknown> | undefined;
      if (result?.type !== "read" && result?.type !== "read_chunk") return message;
      return {
        ...entry,
        value: {
          ...entry.value,
          result: this.prepareDataContainer(result, MAXIMUM_STORAGE_BYTES),
        },
      };
    }
    return message;
  }

  private prepareDataContainer(
    container: Record<string, unknown> | undefined,
    maximumBytes: number,
  ): Record<string, unknown> | undefined {
    if (!container || !("data" in container)) return container;
    return { ...container, data: this.prepareBulkBytes(container.data, maximumBytes) };
  }

  private prepareBulkBytes(data: unknown, maximumBytes = MAXIMUM_STATE_CHUNK_BYTES): unknown {
    if (!this.enabled || this.failure !== null) return data;
    if (
      data != null &&
      typeof data === "object" &&
      (data as { observation?: unknown }).observation === "bulk_bytes_digest"
    )
      return data;
    if (!(data instanceof Uint8Array) && !Array.isArray(data)) return data;
    try {
      if (data.length > maximumBytes) throw new Error("bulk observation exceeds its byte limit");
      const hash = blake3.create();
      if (data instanceof Uint8Array) {
        hash.update(data);
      } else {
        for (let offset = 0; offset < data.length; offset += HASH_CHUNK_BYTES) {
          const length = Math.min(HASH_CHUNK_BYTES, data.length - offset);
          const chunk = new Uint8Array(length);
          for (let index = 0; index < length; index += 1) {
            const value = data[offset + index];
            if (typeof value !== "number" && typeof value !== "bigint")
              throw new Error("invalid bulk byte type");
            const byte = Number(value);
            if (!Number.isInteger(byte) || byte < 0 || byte > 255)
              throw new Error("invalid bulk byte");
            chunk[index] = byte;
          }
          hash.update(chunk);
        }
      }
      return {
        observation: "bulk_bytes_digest",
        byteLength: data.length,
        blake3: [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      };
    } catch {
      this.failure = "unserializable_observation";
      return null;
    }
  }

  sent(
    channel: "runtime" | "debug",
    message: unknown,
    messageId: number | bigint,
    epoch: number | bigint,
    correlationId?: number | bigint,
    sessionGeneration = 0,
  ): void {
    this.record({
      direction: "send",
      channel,
      message: this.prepareMessage(message),
      messageId,
      epoch,
      correlationId,
      sessionGeneration,
    });
  }

  /** Called synchronously immediately before the real pointer provider samples, after projection
   * preparation. Keep these DOM observations separate from the immutable wire-record sequence. */
  pointerSample(identity: {
    requestId: ServiceInteger;
    epoch: ServiceInteger;
    sessionGeneration: number;
    context: ProjectionQueryContext;
  }): void {
    if (!this.enabled || this.failure !== null) return;
    try {
      const observe = window.__RUSTYERA_POINTER_OBSERVATION__;
      if (!observe) return;
      this.record(
        { ...identity, wireIndex: this.records.length, observation: observe() },
        this.pointerSamples,
      );
    } catch {
      this.failure = "unserializable_observation";
    }
  }

  snapshot(sessionGeneration = 0, messageTypes?: ReadonlySet<string>): Record<string, unknown> {
    return {
      ...this.summary(sessionGeneration),
      bytes: this.bytes,
      ...(messageTypes ? { selectedMessageTypes: [...messageTypes] } : {}),
      records: this.records
        .filter((_, index) => !messageTypes || messageTypes.has(this.messageTypes[index] ?? ""))
        .map((record) => JSON.parse(record)),
      pointerSamples: messageTypes ? [] : this.pointerSamples.map((record) => JSON.parse(record)),
    };
  }

  /** Lightweight state for animation-frame polling and the five-second watchdog. The immutable
   * append-only ledgers remain available from snapshot(), but repeatedly cloning them would make
   * observation cost grow with the session and can starve the game being observed. */
  summary(sessionGeneration = 0): Record<string, unknown> {
    return {
      version: 1,
      sessionGeneration,
      enabled: this.enabled,
      overflow: this.failure !== null,
      failure: this.failure,
    };
  }

  private record(value: unknown, destination = this.records): void {
    if (!this.enabled || this.failure !== null) return;
    try {
      const record = JSON.stringify(
        { index: destination.length, ...(value as object) },
        (_key, item) => {
          if (typeof item === "bigint") return item.toString();
          if (item instanceof Uint8Array) return [...item];
          return item;
        },
      );
      const length = new TextEncoder().encode(record).length;
      if (
        this.records.length + this.pointerSamples.length >= this.maximumRecords ||
        this.bytes + length > this.maximumBytes
      ) {
        this.failure = "observation_limit";
        return;
      }
      destination.push(record);
      if (destination === this.records)
        this.messageTypes.push((value as { message?: { type?: string } }).message?.type);
      this.bytes += length;
    } catch {
      this.failure = "unserializable_observation";
    }
  }
}

/** Read the actual typed debug value; do not parse the UI's formatted value string. */
function parseTypedWatches(watches: string[]) {
  if (watches.length > 256 || new Set(watches).size !== watches.length)
    throw new Error("typed watch list exceeds its limit or contains duplicates");
  return watches.map((watch) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:@([0-9]+))?(?::([0-9]+(?:,[0-9]+)*))?$/.exec(watch);
    if (!match) throw new Error(`invalid typed watch: ${watch}`);
    const character = match[2] === undefined ? undefined : Number(match[2]);
    const indices = match[3]?.split(",").map(Number);
    if (
      (character !== undefined && !Number.isSafeInteger(character)) ||
      indices?.some((index) => !Number.isSafeInteger(index))
    )
      throw new Error(`typed watch index is not exact: ${watch}`);
    return { watch, name: match[1], character, indices };
  });
}

type TypedDescriptors = Map<string, Map<string, any>>;

/** Reuse only symbol metadata in the same loaded program. Every value is read again
 * with the current stop; a restart, replacement, hot reload, or watch change discards it. */
export function createTypedWatchReader() {
  let identity: string | undefined;
  let descriptors: TypedDescriptors = new Map();
  return (
    watches: string[],
    stop: any,
    request: (command: any) => Promise<any>,
    assertCurrent: () => void,
    lifecycle: number,
  ) => {
    const current = JSON.stringify(
      [lifecycle, stop.session_epoch, stop.program_generation, watches],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    if (identity !== current) {
      identity = current;
      descriptors = new Map();
    }
    return readTypedWatches(watches, stop, request, assertCurrent, descriptors);
  };
}

export async function readTypedWatches(
  watches: string[],
  stop: any,
  request: (command: any) => Promise<any>,
  assertCurrent: () => void,
  candidates: TypedDescriptors = new Map(),
): Promise<Record<string, unknown>> {
  const parsed = parseTypedWatches(watches);
  const names = new Set(parsed.map((watch) => watch.name));
  const cursors = new Set<string>();
  let cursor = null;
  // Large projects resolve each descriptor against their symbol table. Bound each
  // synchronous request while preserving the same total enumeration allowance.
  const pageLimit = 256;
  const maximumPages = (256 * 1024) / pageLimit;
  for (let page = 0; candidates.size < names.size; page += 1) {
    if (page >= maximumPages) throw new Error("typed variable enumeration exceeds its limit");
    assertCurrent();
    const response = await request({ type: "list_variables", stop, cursor, limit: pageLimit });
    assertCurrent();
    if (response.type !== "variable_page" || !Array.isArray(response.value?.variables))
      throw new Error("typed variable enumeration returned an unexpected response");
    for (const variable of response.value.variables) {
      if (names.has(variable.name)) {
        const entries = candidates.get(variable.name) ?? new Map<string, any>();
        const key = JSON.stringify(
          [
            variable.symbol_key,
            variable.storage,
            variable.value_kind,
            variable.dimensions,
            variable.mutable,
          ],
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        );
        entries.set(key, variable);
        candidates.set(variable.name, entries);
      }
    }
    if (candidates.size === names.size) break;
    cursor = response.value.next_cursor ?? null;
    if (cursor === null) break;
    const key = JSON.stringify(cursor, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    if (cursors.has(key)) throw new Error("typed variable enumeration repeated a cursor");
    cursors.add(key);
  }
  const values: Record<string, unknown> = {};
  for (const { watch, name, character, indices } of parsed) {
    const found = [...(candidates.get(name)?.values() ?? [])];
    if (found.length !== 1) {
      values[watch] = { present: false, error: found.length ? "ambiguous" : "not_found" };
      continue;
    }
    const variable = found[0];
    if (variable.storage === "character" && character === undefined) {
      values[watch] = { present: false, error: "character_required" };
      continue;
    }
    if (variable.storage !== "character" && character !== undefined) {
      values[watch] = { present: false, error: "not_character" };
      continue;
    }
    const command = {
      type: "read_variable",
      stop,
      value: {
        symbol_key: variable.symbol_key,
        storage: variable.storage,
        fiber_id: null,
        frame_id: null,
        generation: stop.program_generation,
        character: character ?? null,
        indices: indices ?? (variable.dimensions ?? []).map(() => 0),
      },
    };
    assertCurrent();
    const response = await request(command);
    assertCurrent();
    const value = response.value?.value;
    if (
      value?.type === "integer" &&
      typeof value.value === "number" &&
      !Number.isSafeInteger(value.value)
    )
      throw new Error("typed integer observation lost precision");
    values[watch] =
      response.type === "variable_value" && value != null
        ? { present: true, value, command, response }
        : { present: false, error: "unexpected_response", command, response };
  }
  return { version: 1, stop, values };
}
