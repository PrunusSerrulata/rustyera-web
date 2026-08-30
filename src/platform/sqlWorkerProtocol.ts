import { serviceInteger } from "@/core/runtimeServiceProtocol";
import {
  checkedSqlI64,
  type SqlHandle,
  type SqlOperation,
  type SqlRequest,
} from "@/core/sqlProtocol";

export interface SqlWorkerExecuteCommand {
  request: SqlRequest;
  initialBytes?: Uint8Array;
  durableRevision?: Uint8Array;
  persistent: boolean;
}

export interface SqlWorkerPublication {
  token: number;
  connection: SqlHandle;
  expectedRevision?: Uint8Array;
  revision: Uint8Array;
  bytes: Uint8Array;
}

export interface SqlWorkerDatabaseState {
  connection: SqlHandle;
  connected: boolean;
  transactionActive: boolean;
  durableRevision?: Uint8Array;
}

export interface SqlWorkerExecuteResult {
  response: Map<number, unknown>;
  publication?: SqlWorkerPublication;
}

export type SqlWorkerCommand =
  | { id: number; type: "execute"; value: SqlWorkerExecuteCommand }
  | { id: number; type: "validate"; value: Uint8Array }
  | { id: number; type: "settle"; value: { token: number; accepted: boolean } }
  | { id: number; type: "reset" };

export type SqlWorkerReply =
  | { id: number; type: "executed"; result: SqlWorkerExecuteResult }
  | { id: number; type: "validated"; result: null }
  | { id: number; type: "settled"; result: SqlWorkerDatabaseState }
  | { id: number; type: "reset"; result: null }
  | { id: number; type: "error"; error: string };

export function decodeSqlWorkerCommand(value: unknown): SqlWorkerCommand {
  const record = object(value, "SQL Worker command");
  const id = safePositiveInteger(record.id, "SQL Worker command ID");
  if (record.type === "reset") return { id, type: "reset" };
  if (record.type === "validate")
    return { id, type: "validate", value: bytes(record.value, "SQL Worker seed database") };
  if (record.type === "settle") {
    const settlement = object(record.value, "SQL Worker settlement");
    if (typeof settlement.accepted !== "boolean") invalid("SQL Worker settlement acceptance");
    return {
      id,
      type: "settle",
      value: {
        token: safePositiveInteger(settlement.token, "SQL Worker publication token"),
        accepted: settlement.accepted,
      },
    };
  }
  if (record.type !== "execute") return invalid("SQL Worker command type");
  const command = object(record.value, "SQL Worker execute command");
  const request = decodeInternalRequest(command.request);
  if (typeof command.persistent !== "boolean") invalid("SQL Worker persistence flag");
  const initialBytes = optionalBytes(command.initialBytes, "SQL Worker initial database");
  const durableRevision = optionalDigest(command.durableRevision, "SQL Worker durable revision");
  if (command.persistent && (!initialBytes || !durableRevision))
    invalid("persistent SQL Worker database material");
  if (!command.persistent && (initialBytes || durableRevision))
    invalid("memory SQL Worker database material");
  return {
    id,
    type: "execute",
    value: { request, persistent: command.persistent, initialBytes, durableRevision },
  };
}

export function decodeSqlWorkerReply(value: unknown): SqlWorkerReply {
  const record = object(value, "SQL Worker reply");
  const id = safePositiveInteger(record.id, "SQL Worker reply ID");
  if (record.type === "error") {
    if (typeof record.error !== "string") invalid("SQL Worker error");
    return { id, type: "error", error: record.error };
  }
  if (record.type === "reset") {
    if (record.result !== null) invalid("SQL Worker reset result");
    return { id, type: "reset", result: null };
  }
  if (record.type === "validated") {
    if (record.result !== null) invalid("SQL Worker validation result");
    return { id, type: "validated", result: null };
  }
  if (record.type === "settled")
    return { id, type: "settled", result: decodeSqlWorkerDatabaseState(record.result) };
  if (record.type !== "executed") return invalid("SQL Worker reply type");
  const result = object(record.result, "SQL Worker execute result");
  if (!(result.response instanceof Map)) invalid("SQL Worker SQL response");
  return {
    id,
    type: "executed",
    result: {
      response: result.response,
      publication: result.publication == null ? undefined : decodePublication(result.publication),
    },
  };
}

export function decodeSqlWorkerDatabaseState(value: unknown): SqlWorkerDatabaseState {
  const record = object(value, "SQL Worker database state");
  if (typeof record.connected !== "boolean" || typeof record.transactionActive !== "boolean")
    invalid("SQL Worker database flags");
  return {
    connection: decodeInternalHandle(record.connection, "SQL Worker connection"),
    connected: record.connected,
    transactionActive: record.transactionActive,
    durableRevision: optionalDigest(record.durableRevision, "SQL Worker durable revision"),
  };
}

function decodePublication(value: unknown): SqlWorkerPublication {
  const record = object(value, "SQL Worker publication");
  return {
    token: safePositiveInteger(record.token, "SQL Worker publication token"),
    connection: decodeInternalHandle(record.connection, "SQL Worker publication connection"),
    expectedRevision: optionalDigest(record.expectedRevision, "SQL Worker expected revision"),
    revision: digest(record.revision, "SQL Worker publication revision"),
    bytes: bytes(record.bytes, "SQL Worker publication bytes"),
  };
}

function decodeInternalRequest(value: unknown): SqlRequest {
  const record = object(value, "SQL Worker request");
  return {
    provider: decodeInternalHandle(record.provider, "SQL Worker provider"),
    operation: decodeInternalOperation(record.operation),
  };
}

function decodeInternalOperation(value: unknown): SqlOperation {
  const operation = object(value, "SQL Worker operation");
  if (operation.kind === "open") {
    const identity = object(operation.identity, "SQL Worker database identity");
    const source = object(identity.source, "SQL Worker database source");
    const decodedSource: Extract<SqlOperation, { kind: "open" }>["identity"]["source"] =
      source.kind === "memory"
        ? { kind: "memory" }
        : source.kind === "resource" && typeof source.resourceId === "string"
          ? {
              kind: "resource",
              resourceId: source.resourceId,
              sha256: digest(source.sha256, "SQL Worker seed digest"),
            }
          : invalid("SQL Worker database source");
    const revision = object(operation.revision, "SQL Worker open revision");
    const decodedRevision: Extract<SqlOperation, { kind: "open" }>["revision"] =
      revision.kind === "current"
        ? { kind: "current" }
        : revision.kind === "exact"
          ? {
              kind: "exact",
              revision: {
                sha256: digest(
                  object(revision.revision, "SQL Worker exact revision").sha256,
                  "SQL Worker exact revision digest",
                ),
              },
            }
          : invalid("SQL Worker open revision");
    if (
      typeof operation.logicalName !== "string" ||
      typeof identity.sqliteVersion !== "string" ||
      typeof identity.formatVersion !== "number" ||
      !Number.isSafeInteger(identity.formatVersion)
    )
      invalid("SQL Worker open operation");
    return {
      kind: "open",
      connection: decodeInternalHandle(operation.connection, "SQL Worker connection"),
      logicalName: operation.logicalName,
      identity: {
        source: decodedSource,
        sqliteVersion: identity.sqliteVersion,
        formatVersion: identity.formatVersion,
      },
      revision: decodedRevision,
    };
  }
  if (operation.kind === "execute") {
    if (
      operation.mode !== 0 &&
      operation.mode !== 1 &&
      operation.mode !== 2 &&
      operation.mode !== 3
    )
      invalid("SQL Worker execute mode");
    if (typeof operation.sql !== "string" || !Array.isArray(operation.parameters))
      invalid("SQL Worker execute operation");
    return {
      kind: "execute",
      connection: decodeInternalHandle(operation.connection, "SQL Worker connection"),
      mode: operation.mode,
      sql: operation.sql,
      parameters: operation.parameters.map((parameter) => {
        if (parameter === null || typeof parameter === "string") return parameter;
        return checkedSqlI64(parameter, "SQL Worker parameter");
      }),
    };
  }
  if (operation.kind === "reader_read" || operation.kind === "reader_close")
    return {
      kind: operation.kind,
      reader: decodeInternalHandle(operation.reader, "SQL Worker reader"),
    };
  if (operation.kind === "reader_get") {
    if (operation.mode !== 0 && operation.mode !== 1) invalid("SQL Worker reader mode");
    return {
      kind: "reader_get",
      reader: decodeInternalHandle(operation.reader, "SQL Worker reader"),
      column: safeUnsignedInteger(operation.column, "SQL Worker reader column"),
      mode: operation.mode,
    };
  }
  if (operation.kind === "reader_is_null")
    return {
      kind: "reader_is_null",
      reader: decodeInternalHandle(operation.reader, "SQL Worker reader"),
      column: safeUnsignedInteger(operation.column, "SQL Worker reader column"),
    };
  if (operation.kind === "disconnect")
    return {
      kind: "disconnect",
      connection: decodeInternalHandle(operation.connection, "SQL Worker connection"),
    };
  if (operation.kind === "import_map_rows") {
    if (typeof operation.table !== "string" || !Array.isArray(operation.rows))
      invalid("SQL Worker MAP import");
    return {
      kind: "import_map_rows",
      connection: decodeInternalHandle(operation.connection, "SQL Worker connection"),
      table: operation.table,
      rows: operation.rows.map((row) => {
        if (
          !Array.isArray(row) ||
          row.length !== 2 ||
          typeof row[0] !== "string" ||
          typeof row[1] !== "string"
        )
          return invalid("SQL Worker MAP row");
        const decoded: [string, string] = [row[0], row[1]];
        return decoded;
      }),
    };
  }
  return invalid("SQL Worker operation kind");
}

function decodeInternalHandle(value: unknown, name: string): SqlHandle {
  const record = object(value, name);
  return {
    serviceEpoch: serviceInteger(record.serviceEpoch, `${name} epoch`),
    id: serviceInteger(record.id, `${name} ID`),
  };
}

function optionalDigest(value: unknown, name: string): Uint8Array | undefined {
  return value == null ? undefined : digest(value, name);
}

function digest(value: unknown, name: string): Uint8Array {
  const result = bytes(value, name);
  if (result.byteLength !== 32) invalid(name);
  return result;
}

function optionalBytes(value: unknown, name: string): Uint8Array | undefined {
  return value == null ? undefined : bytes(value, name);
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== "[object Uint8Array]")
    return invalid(name);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(name);
  const record: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) record[key] = field;
  return record;
}

function safePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid(name);
  return value;
}

function safeUnsignedInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(name);
  return value;
}

function invalid(name: string): never {
  throw new Error(`${name} is invalid`);
}
