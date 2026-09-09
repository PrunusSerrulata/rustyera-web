// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { SQL_SQLITE_VERSION, type SqlOperation } from "@/core/sqlProtocol";

const provider = { serviceEpoch: 1n, id: 1n };
const connection = { serviceEpoch: 1n, id: 1n };
let sequence = 0;
const pending = new Map<number, (reply: any) => void>();
const worker = {
  onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>),
  postMessage: (reply: any) => {
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  },
};

beforeAll(async () => {
  vi.stubGlobal("self", worker);
  await import("@/platform/sql.worker");
});
afterAll(async () => {
  await send({ type: "reset" });
  vi.unstubAllGlobals();
});

async function send(value: Record<string, unknown>) {
  const id = ++sequence;
  const response = new Promise<any>((resolve) => pending.set(id, resolve));
  await worker.onmessage!({ data: { id, ...value } });
  const reply = await response;
  if (reply.type === "error") throw new Error(reply.error);
  return reply;
}

async function execute(operation: SqlOperation, minor: number) {
  const reply = await send({
    type: "execute",
    value: {
      request: { provider, operation },
      persistent: false,
      reusableScalarResults: minor >= 1,
      readerRowResults: minor >= 2,
    },
  });
  return reply.result.response.get(3) as any[];
}

async function readCase(minor: number, order: readonly string[]) {
  await send({ type: "reset" });
  await execute(
    {
      kind: "open",
      connection,
      logicalName: "db",
      identity: {
        source: { kind: "memory" },
        sqliteVersion: SQL_SQLITE_VERSION,
        formatVersion: 1,
      },
      revision: { kind: "current" },
    },
    minor,
  );
  const opened = await execute(
    {
      kind: "execute",
      connection,
      mode: 3,
      parameters: [],
      sql: "SELECT -9223372036854775808, 9223372036854775807, '42', 'nonnumeric', NULL, 1.25, x'3132'",
    },
    minor,
  );
  const handle = opened[1][0] as Map<number, bigint>;
  const reader = { serviceEpoch: handle.get(0)!, id: handle.get(1)! };
  const row = await execute({ kind: "reader_read", reader }, minor);
  const results = [];
  for (let column = 0; column < 7; column += 1) {
    for (const mode of order) {
      results.push(
        await execute(
          mode === "null"
            ? { kind: "reader_is_null", reader, column }
            : { kind: "reader_get", reader, column, mode: mode === "integer" ? 0 : 1 },
          minor,
        ),
      );
    }
  }
  const eof = await execute({ kind: "reader_read", reader }, minor);
  expect(eof).toEqual([4, [false]]);
  await execute({ kind: "reader_close", reader }, minor);
  return { row, results };
}

describe("SQL reader projection against the actual SQLite Worker", () => {
  it("opens with the actual pinned 3.53.4 engine", async () => {
    await send({ type: "reset" });
    const result = await execute(
      {
        kind: "open",
        connection,
        logicalName: "db",
        identity: {
          source: { kind: "memory" },
          sqliteVersion: SQL_SQLITE_VERSION,
          formatVersion: 1,
        },
        revision: { kind: "current" },
      },
      0,
    );
    expect(SQL_SQLITE_VERSION).toBe("3.53.4");
    expect(result[0]).toBe(0);
    expect(result[1][0]).toBe("3.53.4");
  });

  it.each([
    ["integer", "string", "null"],
    ["string", "null", "integer"],
    ["null", "integer", "string"],
  ])("preserves original conversion and error behavior in order %s/%s/%s", async (...order) => {
    const baseline = await readCase(0, order);
    const scalarMinor = await readCase(1, order);
    const projected = await readCase(2, order);
    expect(baseline.row).toEqual([4, [true]]);
    expect(scalarMinor.row).toEqual(baseline.row);
    expect(projected.row[0]).toBe(12);
    expect(projected.results).toEqual(baseline.results);
    expect(scalarMinor.results).toEqual(baseline.results);
    const cells = projected.row[1][0] as Map<number, unknown>[];
    expect(cells).toHaveLength(7);
    expect(cells[0].get(0)).toBe(-9223372036854775808n);
    expect(cells[1].get(0)).toBe(9223372036854775807n);
    expect(cells[2].get(1)).toBe("42");
    expect(cells[3].get(1)).toBe("nonnumeric");
    expect(cells[4].get(2)).toBe(true);
    expect([...cells[5].values()]).toEqual([null, null, null]);
    expect([...cells[6].values()]).toEqual([null, null, null]);
  });
});
