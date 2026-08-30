import sqlite3InitModule, {
  type Database,
  type PreparedStatement,
  type Sqlite3Static,
  type SqlValue as NativeSqlValue,
} from "@sqlite.org/sqlite-wasm";

import {
  SQL_LIMITS,
  SQL_SQLITE_VERSION,
  SqlErrorCode,
  bytesHex,
  encodeSqlResponse,
  encodeSqlValue,
  handleKey,
  operationKind,
  sha256Bytes,
  sqlErrorResult,
  checkedSqlI64,
  type SqlHandle,
  type SqlErrorCodeValue,
  type SqlRequest,
  type SqlValue,
} from "@/core/sqlProtocol";
import {
  decodeSqlWorkerCommand,
  type SqlWorkerCommand,
  type SqlWorkerDatabaseState,
  type SqlWorkerExecuteCommand,
  type SqlWorkerExecuteResult,
  type SqlWorkerPublication,
  type SqlWorkerReply,
} from "@/platform/sqlWorkerProtocol";

interface Connection {
  handle: SqlHandle;
  db: Database;
  persistent: boolean;
  durableRevision?: Uint8Array;
  durableBytes?: Uint8Array;
}

interface Reader {
  handle: SqlHandle;
  connection: Connection;
  statement?: PreparedStatement;
  readonly: boolean;
  status: 0 | 1 | 2 | 3;
  rowsRead: bigint;
}

interface PendingPublication extends Omit<SqlWorkerPublication, "connection" | "expectedRevision"> {
  connection: Connection;
}

const sqlitePromise = sqlite3InitModule();
const connections = new Map<string, Connection>();
const readers = new Map<string, Reader>();
let publication: PendingPublication | undefined;
let nextPublicationToken = 1;

self.onmessage = async (event: MessageEvent) => {
  let message: SqlWorkerCommand | undefined;
  try {
    message = decodeSqlWorkerCommand(event.data);
    let reply: SqlWorkerReply;
    if (message.type === "execute") {
      if (publication) throw new Error("SQL publication acknowledgement is pending");
      reply = { id: message.id, type: "executed", result: await execute(message.value) };
    } else if (message.type === "validate") {
      const sqlite = await sqlitePromise;
      const database = openDatabase(sqlite, message.value);
      database.close();
      reply = { id: message.id, type: "validated", result: null };
    } else if (message.type === "settle")
      reply = { id: message.id, type: "settled", result: await settle(message.value) };
    else if (message.type === "reset") {
      reset();
      reply = { id: message.id, type: "reset", result: null };
    } else throw new Error("unknown SQL Worker command");
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({
      id: message?.id ?? readMessageId(event.data),
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies SqlWorkerReply);
  }
};

async function execute(command: SqlWorkerExecuteCommand): Promise<SqlWorkerExecuteResult> {
  const sqlite = await sqlitePromise;
  if (sqlite.version.libVersion !== SQL_SQLITE_VERSION)
    throw new Error(`SQLite version mismatch: ${sqlite.version.libVersion}`);
  const request = command.request;
  try {
    const response = runOperation(sqlite, command);
    return { response, publication: publicationWire() };
  } catch (error) {
    const connection = operationConnection(request.operation);
    const reader = operationReader(request.operation);
    if (
      connection?.persistent &&
      !transactionActive(sqlite, connection) &&
      !publication &&
      connection.durableBytes
    ) {
      const live = sqlite.capi.sqlite3_js_db_export(connection.db);
      if (
        !connection.durableRevision ||
        bytesHex(sha256Bytes(live)) !== bytesHex(connection.durableRevision)
      )
        replaceDatabase(sqlite, connection, connection.durableBytes);
    }
    const sqliteError = error instanceof sqlite.SQLite3Error ? error : undefined;
    return {
      response: encodeSqlResponse({
        provider: request.provider,
        database: connection ? databaseState(sqlite, connection) : undefined,
        reader: reader ? readerState(reader) : undefined,
        result: sqlErrorResult(
          errorCode(sqlite, error, request),
          operationKind(request.operation),
          {},
          sqliteError?.resultCode ?? null,
          error instanceof Error ? error.message : String(error),
        ),
      }),
    };
  }
}

function runOperation(sqlite: Sqlite3Static, command: SqlWorkerExecuteCommand) {
  const { request } = command;
  const operation = request.operation;
  switch (operation.kind) {
    case "open": {
      if (connections.size >= SQL_LIMITS.maximumConnections)
        return failure(sqlite, request, SqlErrorCode.ConnectionLimit);
      if (connections.has(handleKey(operation.connection)))
        return failure(sqlite, request, SqlErrorCode.ConnectionConflict);
      const db = openDatabase(sqlite, command.initialBytes);
      const connection: Connection = {
        handle: operation.connection,
        db,
        persistent: command.persistent,
        durableRevision: command.durableRevision,
        durableBytes: command.initialBytes?.slice(),
      };
      connections.set(handleKey(operation.connection), connection);
      return encodeSqlResponse({
        provider: request.provider,
        database: databaseState(sqlite, connection),
        result: [0, [SQL_SQLITE_VERSION, limitsMap()]],
      });
    }
    case "execute": {
      const connection = requiredConnection(operation.connection);
      if (operation.mode === 3) {
        if (readers.size >= SQL_LIMITS.maximumReaders)
          return failure(sqlite, request, SqlErrorCode.ReaderLimit, connection);
        const statement = connection.db.prepare(operation.sql);
        bind(statement, operation.parameters);
        const handle: SqlHandle = {
          serviceEpoch: request.provider.serviceEpoch,
          id: nextReaderId(),
        };
        const reader: Reader = {
          handle,
          connection,
          statement,
          readonly: sqlite.capi.sqlite3_stmt_readonly(statement) !== 0,
          status: 0,
          rowsRead: 0n,
        };
        readers.set(handleKey(handle), reader);
        return encodeSqlResponse({
          provider: request.provider,
          database: databaseState(sqlite, connection),
          reader: readerState(reader),
          result: [3, [handleMap(handle)]],
        });
      }
      const result = withBudget(sqlite, connection, () =>
        executeImmediate(sqlite, connection, operation),
      );
      preparePublication(sqlite, connection);
      return encodeSqlResponse({
        provider: request.provider,
        database: databaseState(sqlite, connection),
        result,
      });
    }
    case "reader_read": {
      const reader = readers.get(handleKey(operation.reader));
      if (!reader) return encodeSqlResponse({ provider: request.provider, result: [4, [false]] });
      if (reader.status === 2)
        return encodeSqlResponse({
          provider: request.provider,
          database: databaseState(sqlite, reader.connection),
          reader: readerState(reader),
          result: [4, [false]],
        });
      const statement = requiredReaderStatement(reader);
      const hasRow = withBudget(sqlite, reader.connection, () => statement.step());
      if (hasRow) {
        reader.rowsRead += 1n;
        if (reader.rowsRead > BigInt(SQL_LIMITS.maximumReaderRows))
          throw new ProviderError(SqlErrorCode.ReaderRowLimit, "SQL reader row limit exceeded");
        reader.status = 1;
      } else {
        reader.status = 2;
        finalizeReaderStatement(reader);
        if (!reader.readonly) preparePublication(sqlite, reader.connection);
      }
      return encodeSqlResponse({
        provider: request.provider,
        database: databaseState(sqlite, reader.connection),
        reader: readerState(reader),
        result: [4, [hasRow]],
      });
    }
    case "reader_get":
    case "reader_is_null": {
      const reader = readers.get(handleKey(operation.reader));
      if (!reader || reader.status !== 1)
        return failure(sqlite, request, SqlErrorCode.ReaderNotFound, reader?.connection, reader);
      const statement = requiredReaderStatement(reader);
      if (operation.column >= statement.columnCount)
        return failure(sqlite, request, SqlErrorCode.ColumnOutOfRange, reader.connection, reader);
      const value =
        operation.kind === "reader_get"
          ? readerValue(sqlite, statement, operation.column, operation.mode)
          : nativeValue(sqlite, statement, operation.column);
      return encodeSqlResponse({
        provider: request.provider,
        database: databaseState(sqlite, reader.connection),
        reader: readerState(reader),
        result:
          operation.kind === "reader_is_null"
            ? [6, [value === null]]
            : [5, [encodeSqlValue(value)]],
      });
    }
    case "reader_close": {
      const reader = readers.get(handleKey(operation.reader));
      if (reader) {
        closeReader(reader);
        if (!reader.readonly) preparePublication(sqlite, reader.connection);
      }
      return encodeSqlResponse({
        provider: request.provider,
        database: reader ? databaseState(sqlite, reader.connection) : undefined,
        reader: reader ? readerState(reader) : undefined,
        result: [7, []],
      });
    }
    case "import_map_rows": {
      const connection = requiredConnection(operation.connection);
      withBudget(sqlite, connection, () => importRows(connection, operation.table, operation.rows));
      preparePublication(sqlite, connection);
      return encodeSqlResponse({
        provider: request.provider,
        database: databaseState(sqlite, connection),
        result: [8, [operation.rows.length]],
      });
    }
    case "disconnect": {
      const connection = connections.get(handleKey(operation.connection));
      const durableRevision = connection?.durableRevision;
      if (connection) closeConnection(connection);
      return encodeSqlResponse({
        provider: request.provider,
        database: {
          connection: operation.connection,
          connected: false,
          transactionActive: false,
          durableRevision,
        },
        result: [9, []],
      });
    }
  }
}

function executeImmediate(
  sqlite: Sqlite3Static,
  connection: Connection,
  operation: Extract<SqlRequest["operation"], { kind: "execute" }>,
): unknown[] {
  if (operation.mode === 0) {
    const before = connection.db.changes(true, true);
    connection.db.exec({ sql: operation.sql, bind: binding(operation.parameters) });
    return [1, [checkedSqlI64(connection.db.changes(true, true) - before, "affected rows")]];
  }
  const statement = connection.db.prepare(operation.sql);
  try {
    bind(statement, operation.parameters);
    if (!statement.step() || statement.columnCount === 0) return [2, [[0, []]]];
    if (operation.mode === 3)
      throw new ProviderError(SqlErrorCode.InvalidState, "reader execution reached scalar path");
    const value = scalarValue(sqlite, statement, operation.mode);
    return [2, [encodeSqlValue(value)]];
  } finally {
    statement.finalize();
  }
}

function importRows(connection: Connection, table: string, rows: [string, string][]): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
    throw new ProviderError(SqlErrorCode.InvalidTableName, "invalid SQL MAP table name");
  // The grammar above makes direct interpolation safe and preserves the reference schema text.
  const quoted = table;
  connection.db.exec("SAVEPOINT rustyera_map_import");
  try {
    connection.db.exec(`CREATE TABLE IF NOT EXISTS ${quoted} (k TEXT PRIMARY KEY, v TEXT)`);
    connection.db.exec(`DELETE FROM ${quoted}`);
    const statement = connection.db.prepare(
      `INSERT OR REPLACE INTO ${quoted}(k, v) VALUES(?1, ?2)`,
    );
    try {
      for (const row of rows) statement.bind(row).stepReset().clearBindings();
    } finally {
      statement.finalize();
    }
    connection.db.exec("RELEASE rustyera_map_import");
  } catch (error) {
    connection.db.exec("ROLLBACK TO rustyera_map_import; RELEASE rustyera_map_import");
    throw error;
  }
}

function openDatabase(sqlite: Sqlite3Static, bytes?: Uint8Array): Database {
  const db = new sqlite.oo1.DB(":memory:", "c");
  try {
    if (bytes) deserialize(sqlite, db, bytes);
    db.exec("PRAGMA schema_version");
    db.exec("PRAGMA trusted_schema=OFF");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function deserialize(sqlite: Sqlite3Static, db: Database, bytes: Uint8Array): void {
  const pointer = sqlite.wasm.allocFromTypedArray(bytes);
  const flags =
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const result = sqlite.capi.sqlite3_deserialize(
    db,
    "main",
    pointer,
    bytes.length,
    bytes.length,
    flags,
  );
  if (result !== sqlite.capi.SQLITE_OK) {
    sqlite.wasm.dealloc(pointer);
    db.checkRc(result);
  }
}

function preparePublication(sqlite: Sqlite3Static, connection: Connection): void {
  if (!connection.persistent || transactionActive(sqlite, connection)) return;
  const bytes = sqlite.capi.sqlite3_js_db_export(connection.db);
  if (bytes.byteLength > SQL_LIMITS.maximumDatabaseBytes)
    throw new ProviderError(SqlErrorCode.DatabaseTooLarge, "SQL database exceeds its limit");
  const revision = sha256Bytes(bytes);
  if (connection.durableRevision && bytesHex(revision) === bytesHex(connection.durableRevision))
    return;
  publication = { token: nextPublicationToken++, connection, revision, bytes };
}

async function settle(value: {
  token: number;
  accepted: boolean;
}): Promise<SqlWorkerDatabaseState> {
  const pending = publication;
  if (!pending || pending.token !== value.token) throw new Error("stale SQL publication token");
  publication = undefined;
  if (value.accepted) {
    pending.connection.durableRevision = pending.revision;
    pending.connection.durableBytes = pending.bytes.slice();
  } else {
    const sqlite = await sqlitePromise;
    replaceDatabase(sqlite, pending.connection, pending.connection.durableBytes);
  }
  return databaseState(await sqlitePromise, pending.connection);
}

function publicationWire(): SqlWorkerPublication | undefined {
  if (!publication) return undefined;
  return {
    token: publication.token,
    connection: publication.connection.handle,
    expectedRevision: publication.connection.durableRevision,
    revision: publication.revision,
    bytes: publication.bytes,
  };
}

function replaceDatabase(sqlite: Sqlite3Static, connection: Connection, bytes?: Uint8Array): void {
  for (const reader of [...readers.values()])
    if (reader.connection === connection) closeReader(reader);
  connection.db.close();
  connection.db = openDatabase(sqlite, bytes);
}

function withBudget<T>(sqlite: Sqlite3Static, connection: Connection, operation: () => T): T {
  const deadline = performance.now() + SQL_LIMITS.executionBudgetMs;
  sqlite.capi.sqlite3_progress_handler(
    connection.db,
    1_000,
    () => (performance.now() >= deadline ? 1 : 0),
    0,
  );
  try {
    return operation();
  } catch (error) {
    if (error instanceof sqlite.SQLite3Error && error.resultCode === sqlite.capi.SQLITE_INTERRUPT)
      throw new ProviderError(SqlErrorCode.ExecutionTimeout, "SQL execution budget exceeded");
    throw error;
  } finally {
    sqlite.capi.sqlite3_progress_handler(connection.db, 0, 0, 0);
  }
}

function nativeValue(
  sqlite: Sqlite3Static,
  statement: PreparedStatement,
  column: number,
): SqlValue {
  const type = sqlite.capi.sqlite3_column_type(statement, column);
  if (type === sqlite.capi.SQLITE_NULL) return null;
  const value = statement.get(column);
  if (type === sqlite.capi.SQLITE_INTEGER) return checkedSqlI64(value, "SQL integer cell");
  if (type === sqlite.capi.SQLITE_TEXT) {
    const text = String(value);
    if (new TextEncoder().encode(text).byteLength > SQL_LIMITS.maximumCellBytes)
      throw new ProviderError(SqlErrorCode.CellTooLarge, "SQL cell exceeds its limit");
    return text;
  }
  throw new ProviderError(SqlErrorCode.TypeMismatch, "SQL value type is not supported by v1");
}

function scalarValue(sqlite: Sqlite3Static, statement: PreparedStatement, mode: 1 | 2): SqlValue {
  const value = nativeValue(sqlite, statement, 0);
  if (value === null || mode === 2 || typeof value === "bigint") return value;
  // The snake reference accepts integral TEXT for scalar-long, but faults on arbitrary text.
  // BigInt supplies the required checked decimal conversion without precision loss.
  if (!/^[+-]?\d+$/.test(value.trim()))
    throw new ProviderError(SqlErrorCode.TypeMismatch, "SQL scalar is not an integer");
  try {
    return checkedSqlI64(BigInt(value.trim()), "SQL scalar integer");
  } catch {
    throw new ProviderError(SqlErrorCode.TypeMismatch, "SQL scalar integer is out of range");
  }
}

function readerValue(
  sqlite: Sqlite3Static,
  statement: PreparedStatement,
  column: number,
  mode: 0 | 1,
): SqlValue {
  if (sqlite.capi.sqlite3_column_type(statement, column) === sqlite.capi.SQLITE_NULL) return null;
  if (mode === 0) {
    const value = statement.get(column, sqlite.capi.SQLITE_INTEGER);
    return checkedSqlI64(value, "SQL reader integer");
  }
  const value = statement.getString(column);
  if (value === null) return null;
  if (new TextEncoder().encode(value).byteLength > SQL_LIMITS.maximumCellBytes)
    throw new ProviderError(SqlErrorCode.CellTooLarge, "SQL cell exceeds its limit");
  return value;
}

function bind(statement: PreparedStatement, values: SqlValue[]): void {
  if (values.length) statement.bind(binding(values));
}

function binding(values: SqlValue[]): Record<string, NativeSqlValue> {
  return Object.fromEntries(values.map((value, index) => [`@${index}`, value]));
}

function transactionActive(sqlite: Sqlite3Static, connection: Connection): boolean {
  return sqlite.capi.sqlite3_get_autocommit(connection.db) === 0;
}

function databaseState(sqlite: Sqlite3Static, connection: Connection) {
  return {
    connection: connection.handle,
    connected: connection.db.isOpen(),
    transactionActive: transactionActive(sqlite, connection),
    durableRevision: connection.durableRevision,
  };
}

function readerState(reader: Reader) {
  return { reader: reader.handle, status: reader.status, rowsRead: reader.rowsRead };
}

function limitsMap(): Map<number, unknown> {
  return new Map<number, unknown>(
    Object.values(SQL_LIMITS).map((value, index): [number, unknown] => [index, value]),
  );
}

function handleMap(handle: SqlHandle): Map<number, unknown> {
  return new Map<number, unknown>([
    [0, handle.serviceEpoch],
    [1, handle.id],
  ]);
}

function requiredConnection(handle: SqlHandle): Connection {
  const connection = connections.get(handleKey(handle));
  if (!connection)
    throw new ProviderError(SqlErrorCode.ConnectionNotFound, "SQL connection is not open");
  return connection;
}

function operationConnection(operation: SqlRequest["operation"]): Connection | undefined {
  return "connection" in operation
    ? connections.get(handleKey(operation.connection))
    : operationReader(operation)?.connection;
}

function operationReader(operation: SqlRequest["operation"]): Reader | undefined {
  return "reader" in operation ? readers.get(handleKey(operation.reader)) : undefined;
}

function closeReader(reader: Reader): void {
  finalizeReaderStatement(reader);
  reader.status = 3;
  readers.delete(handleKey(reader.handle));
}

function requiredReaderStatement(reader: Reader): PreparedStatement {
  if (!reader.statement)
    throw new ProviderError(SqlErrorCode.InvalidState, "SQL reader statement is finalized");
  return reader.statement;
}

function finalizeReaderStatement(reader: Reader): void {
  const statement = reader.statement;
  reader.statement = undefined;
  statement?.finalize();
}

function closeConnection(connection: Connection): void {
  for (const reader of [...readers.values()])
    if (reader.connection === connection) closeReader(reader);
  if (connection.db.isOpen()) connection.db.close();
  connections.delete(handleKey(connection.handle));
}

function reset(): void {
  publication = undefined;
  for (const connection of [...connections.values()]) closeConnection(connection);
  readers.clear();
}

function nextReaderId(): bigint {
  for (let id = 1n; id <= BigInt(SQL_LIMITS.maximumReaders); id++)
    if (![...readers.values()].some((reader) => BigInt(reader.handle.id) === id)) return id;
  throw new ProviderError(SqlErrorCode.ReaderLimit, "SQL reader limit exceeded");
}

function failure(
  sqlite: Sqlite3Static,
  request: SqlRequest,
  code: SqlErrorCodeValue,
  connection?: Connection,
  reader?: Reader,
) {
  return encodeSqlResponse({
    provider: request.provider,
    database: connection
      ? {
          connection: connection.handle,
          connected: connection.db.isOpen(),
          transactionActive: transactionActive(sqlite, connection),
          durableRevision: connection.durableRevision,
        }
      : undefined,
    reader: reader ? readerState(reader) : undefined,
    result: sqlErrorResult(code, operationKind(request.operation)),
  });
}

function errorCode(sqlite: Sqlite3Static, error: unknown, request: SqlRequest): SqlErrorCodeValue {
  if (
    request.operation.kind === "open" &&
    request.operation.identity.source.kind === "resource" &&
    !(error instanceof ProviderError)
  )
    return SqlErrorCode.InvalidSource;
  return error instanceof ProviderError
    ? error.code
    : error instanceof sqlite.SQLite3Error
      ? SqlErrorCode.Sqlite
      : SqlErrorCode.InvalidState;
}

class ProviderError extends Error {
  constructor(
    readonly code: SqlErrorCodeValue,
    message: string,
  ) {
    super(message);
  }
}

function readMessageId(value: unknown): number {
  if (!value || typeof value !== "object" || !("id" in value)) return 1;
  const id = Reflect.get(value, "id");
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : 1;
}
