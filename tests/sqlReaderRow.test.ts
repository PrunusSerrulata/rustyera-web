import { describe, expect, it, vi } from "vitest";
import { projectReaderRow } from "@/platform/sqlReaderRow";

function fixture(types: number[], lengths = types.map(() => 2)) {
  const sqlite = {
    capi: {
      SQLITE_NULL: 5,
      SQLITE_INTEGER: 1,
      SQLITE_TEXT: 3,
      sqlite3_column_type: (_statement: unknown, column: number) => types[column],
      sqlite3_column_bytes: (_statement: unknown, column: number) => lengths[column],
    },
  };
  const statement = { columnCount: types.length, step: vi.fn() };
  return {
    sqlite,
    statement,
    project: (read: (column: number, mode: 0 | 1) => any) =>
      projectReaderRow(sqlite as never, statement as never, types, read),
  };
}

describe("bounded current SQL row projection", () => {
  it("captures both conversions and null without stepping the reader", () => {
    const f = fixture([1, 3, 5, 4, 2]);
    const read = vi.fn((_column, mode) => (mode === 0 ? 42n : "42"));
    const cells = f.project(read);
    expect(cells[0]).toEqual(
      new Map<number, unknown>([
        [0, 42n],
        [1, "42"],
        [2, false],
      ]),
    );
    expect(cells[1]).toEqual(cells[0]);
    expect(cells[2]).toEqual(
      new Map<number, unknown>([
        [0, 0n],
        [1, ""],
        [2, true],
      ]),
    );
    expect(cells[3]).toEqual(
      new Map<number, unknown>([
        [0, null],
        [1, null],
        [2, null],
      ]),
    );
    expect(cells[4]).toEqual(cells[3]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(f.statement.step).not.toHaveBeenCalled();
  });
  it("defers failed conversions and oversized cells without moving the error earlier", () => {
    const f = fixture([3, 3], [4, 1048577]);
    const read = vi.fn((_column, mode) => {
      if (mode === 1) throw new Error("conversion");
      return 7n;
    });
    const cells = f.project(read);
    expect(cells[0]).toEqual(
      new Map<number, unknown>([
        [0, 7n],
        [1, null],
        [2, null],
      ]),
    );
    expect(cells[1]).toEqual(
      new Map<number, unknown>([
        [0, null],
        [1, null],
        [2, null],
      ]),
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("bounds columns and total UTF-8 text plus per-cell overhead", () => {
    expect(fixture(Array(100).fill(5)).project(() => null)).toHaveLength(32);
    const cells = fixture([3, 3, 3], [32750, 32750, 32750]).project((_column, mode) =>
      mode === 0 ? 0n : "x".repeat(32750),
    );
    const size = cells.reduce(
      (sum, cell) => sum + 16 + new TextEncoder().encode(String(cell.get(1) ?? "")).length,
      0,
    );
    expect(size).toBeLessThanOrEqual(65536);
    expect(cells[2]?.get(1) ?? null).toBeNull();
  });
});
