import type { WebEvent } from "@/core/types";

/** Bounded observations only: capture failure must never change execution or invent a reply. */
export class RuntimeEvidence {
  private readonly records: string[] = [];
  private bytes = 0;
  private failure: string | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly maximumBytes = 16 * 1024 * 1024,
    private readonly maximumRecords = 8192,
  ) {}

  receive(event: WebEvent): void {
    this.record({ direction: "receive", ...event });
  }

  sent(
    channel: "runtime" | "debug",
    message: unknown,
    messageId: number | bigint,
    epoch: number | bigint,
    correlationId?: number | bigint,
  ): void {
    this.record({ direction: "send", channel, message, messageId, epoch, correlationId });
  }

  snapshot(): Record<string, unknown> {
    return {
      version: 1,
      enabled: this.enabled,
      overflow: this.failure !== null,
      failure: this.failure,
      bytes: this.bytes,
      records: this.records.map((record) => JSON.parse(record)),
    };
  }

  private record(value: unknown): void {
    if (!this.enabled || this.failure !== null) return;
    try {
      const record = JSON.stringify(
        { index: this.records.length, ...(value as object) },
        (_key, item) => {
          if (typeof item === "bigint") return item.toString();
          if (item instanceof Uint8Array) return [...item];
          return item;
        },
      );
      const length = new TextEncoder().encode(record).length;
      if (this.records.length >= this.maximumRecords || this.bytes + length > this.maximumBytes) {
        this.failure = "observation_limit";
        return;
      }
      this.records.push(record);
      this.bytes += length;
    } catch {
      this.failure = "unserializable_observation";
    }
  }
}

/** Read the actual typed debug value; do not parse the UI's formatted value string. */
export async function readTypedWatches(
  watches: string[],
  stop: any,
  request: (command: any) => Promise<any>,
  assertCurrent: () => void,
): Promise<Record<string, unknown>> {
  if (watches.length > 256 || new Set(watches).size !== watches.length)
    throw new Error("typed watch list exceeds its limit or contains duplicates");
  const parsed = watches.map((watch) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::([0-9]+(?:,[0-9]+)*))?$/.exec(watch);
    if (!match) throw new Error(`invalid typed watch: ${watch}`);
    const indices = match[2]?.split(",").map(Number);
    if (indices?.some((index) => !Number.isSafeInteger(index)))
      throw new Error(`typed watch index is not exact: ${watch}`);
    return { watch, name: match[1], indices };
  });
  const names = new Set(parsed.map((watch) => watch.name));
  const candidates = new Map<string, any[]>();
  const cursors = new Set<string>();
  let cursor = null;
  for (let page = 0; ; page += 1) {
    if (page >= 256) throw new Error("typed variable enumeration exceeds its limit");
    assertCurrent();
    const response = await request({ type: "list_variables", stop, cursor, limit: 256 });
    assertCurrent();
    if (response.type !== "variable_page" || !Array.isArray(response.value?.variables))
      throw new Error("typed variable enumeration returned an unexpected response");
    for (const variable of response.value.variables) {
      if (names.has(variable.name)) {
        const entries = candidates.get(variable.name) ?? [];
        entries.push(variable);
        candidates.set(variable.name, entries);
      }
    }
    cursor = response.value.next_cursor ?? null;
    if (cursor === null) break;
    const key = JSON.stringify(cursor, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    if (cursors.has(key)) throw new Error("typed variable enumeration repeated a cursor");
    cursors.add(key);
  }
  const values: Record<string, unknown> = {};
  for (const { watch, name, indices } of parsed) {
    const found = candidates.get(name) ?? [];
    if (found.length !== 1) {
      values[watch] = { present: false, error: found.length ? "ambiguous" : "not_found" };
      continue;
    }
    const variable = found[0];
    const command = {
      type: "read_variable",
      stop,
      value: {
        symbol_key: variable.symbol_key,
        storage: variable.storage,
        fiber_id: null,
        frame_id: null,
        generation: stop.program_generation,
        character: null,
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
