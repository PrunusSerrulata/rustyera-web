import type { PreparedStatement, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { SqlValue } from "@/core/sqlProtocol";

/** Capture only the current SQLite row, never step ahead. Conversion failures and oversized
 * cells retain their ordinary on-demand ReaderGet behavior, including its error timing. */
export function projectReaderRow(
  sqlite: Sqlite3Static,
  statement: PreparedStatement,
  originalTypes: readonly (number | undefined)[],
  read: (column: number, mode: 0 | 1) => SqlValue,
): Map<number, unknown>[] {
  const cells: Map<number, unknown>[] = [];
  let bytes = 0;
  for (
    let column = 0;
    column < Math.min(statement.columnCount, originalTypes.length, 32);
    column += 1
  ) {
    bytes += 16;
    if (bytes > 64 * 1024) break;
    const cell = new Map<number, unknown>([
      [0, null],
      [1, null],
      [2, null],
    ]);
    const type = originalTypes[column];
    // Other SQLite types remain on-demand: ReaderIsNull's existing nativeValue rejects them.
    if (type === sqlite.capi.SQLITE_NULL) {
      cell.set(0, 0n);
      cell.set(1, "");
      cell.set(2, true);
    } else if (type === sqlite.capi.SQLITE_INTEGER || type === sqlite.capi.SQLITE_TEXT) {
      // Check the SQLite byte length before allocating a JS string. This is a row budget,
      // not a change to the existing per-cell protocol limit.
      const length = sqlite.capi.sqlite3_column_bytes(statement, column);
      if (length <= 64 * 1024 - bytes) {
        try {
          const text = read(column, 1);
          if (typeof text === "string") {
            const size = new TextEncoder().encode(text).byteLength;
            if (size <= 64 * 1024 - bytes) {
              cell.set(1, text);
              bytes += size;
            }
          }
          cell.set(2, false);
        } catch {
          /* Leave this conversion on demand. */
        }
        try {
          cell.set(0, read(column, 0));
        } catch {
          /* Leave this conversion on demand. */
        }
      }
    }
    cells.push(cell);
  }
  return cells;
}
