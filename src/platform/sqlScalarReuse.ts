import type { Database, PreparedStatement, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

export interface SqlScalarReuseState {
  ordinaryTables?: Set<string>;
  reuseAuthorizerInstalled?: boolean;
  reuseCandidate?: { ordinaryTables: Set<string>; reusable: boolean };
}

/**
 * Prepare a scalar statement while asking SQLite which semantic features it references.
 * Reuse is deliberately limited to direct reads from ordinary main-database tables and
 * constant expressions. Functions, views, virtual/temp/attached tables, pragmas and writes
 * remain uncached even when SQLite labels the statement read-only.
 */
export function prepareReusableScalar(
  sqlite: Sqlite3Static,
  db: Database,
  state: SqlScalarReuseState,
  sql: string,
): {
  statement: PreparedStatement;
  reusable: () => boolean;
  finish: () => void;
} {
  installReuseAuthorizer(sqlite, db, state);
  const ordinaryTables = (state.ordinaryTables ??= new Set(
    db
      .selectValues("SELECT name FROM sqlite_schema WHERE type = 'table' AND rootpage > 0")
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase()),
  ));
  const candidate = { ordinaryTables, reusable: true };
  state.reuseCandidate = candidate;
  try {
    const statement = db.prepare(sql);
    return {
      statement,
      reusable: () => candidate.reusable && sqlite.capi.sqlite3_stmt_readonly(statement) !== 0,
      finish: () => {
        if (state.reuseCandidate === candidate) state.reuseCandidate = undefined;
      },
    };
  } catch (error) {
    state.reuseCandidate = undefined;
    throw error;
  }
}

function installReuseAuthorizer(
  sqlite: Sqlite3Static,
  db: Database,
  state: SqlScalarReuseState,
): void {
  if (state.reuseAuthorizerInstalled) return;
  const installed = sqlite.capi.sqlite3_set_authorizer(
    db.pointer!,
    (_context, action, table, _column, database, source) => {
      const candidate = state.reuseCandidate;
      if (!candidate) return sqlite.capi.SQLITE_OK;
      if (action === sqlite.capi.SQLITE_SELECT) return sqlite.capi.SQLITE_OK;
      if (
        action === sqlite.capi.SQLITE_READ &&
        typeof table === "string" &&
        table !== "" &&
        database === "main" &&
        !source &&
        candidate.ordinaryTables.has(table.toLowerCase())
      )
        return sqlite.capi.SQLITE_OK;
      candidate.reusable = false;
      return sqlite.capi.SQLITE_OK;
    },
    0,
  );
  if (installed !== sqlite.capi.SQLITE_OK) throw new Error("failed to install SQL authorizer");
  state.reuseAuthorizerInstalled = true;
}
