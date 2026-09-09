import { describe, expect, it } from "vitest";

import { prepareReusableScalar } from "@/platform/sqlScalarReuse";

const SELECT = 21;
const READ = 20;
const FUNCTION = 31;

function harness(actions: Array<[number, string | 0, string | 0, string | 0]>) {
  let authorizer: ((...args: any[]) => number) | undefined;
  const statement = {};
  const sqlite = {
    capi: {
      SQLITE_OK: 0,
      SQLITE_SELECT: SELECT,
      SQLITE_READ: READ,
      sqlite3_stmt_readonly: () => 1,
      sqlite3_set_authorizer: (_db: number, callback: unknown) => {
        authorizer =
          typeof callback === "function" ? (callback as (...args: any[]) => number) : undefined;
        return 0;
      },
    },
  };
  const db = {
    pointer: 1,
    selectValues: () => ["items"],
    prepare: () => {
      for (const [action, table, database, source] of actions)
        authorizer?.(0, action, table, 0, database, source);
      return statement;
    },
  };
  const prepared = prepareReusableScalar(
    sqlite as never,
    db as never,
    {},
    "SELECT value FROM items",
  );
  const reusable = prepared.reusable();
  prepared.finish();
  return reusable;
}

describe("SQL scalar reuse classification", () => {
  it("accepts only direct reads from ordinary main-database tables", () => {
    expect(
      harness([
        [SELECT, 0, 0, 0],
        [READ, "items", "main", 0],
      ]),
    ).toBe(true);
    expect(
      harness([
        [SELECT, 0, 0, 0],
        [READ, "items", "main", "view_name"],
      ]),
    ).toBe(false);
    expect(harness([[READ, "items", "temp", 0]])).toBe(false);
    expect(harness([[READ, "virtual_items", "main", 0]])).toBe(false);
  });

  it("rejects functions and every non-read authorization action", () => {
    expect(harness([[FUNCTION, "random", 0, 0]])).toBe(false);
    expect(harness([[18, "items", "main", 0]])).toBe(false);
  });
});
