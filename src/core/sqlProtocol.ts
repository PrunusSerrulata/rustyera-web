import { sha256 } from "@noble/hashes/sha2.js";

import {
  RuntimeServiceError,
  sameServiceInteger,
  serviceInteger,
  serviceMap,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";

export const SQL_OPERATION = "rustyera.sql";
export const SQL_SQLITE_VERSION = "3.53.0";
export const SQL_DATABASE_FORMAT_VERSION = 1;

export const SQL_LIMITS = Object.freeze({
  maximumConnections: 8,
  maximumReaders: 32,
  maximumSqlBytes: 256 * 1024,
  maximumParameters: 64,
  maximumParameterBytes: 8 * 1024 * 1024,
  maximumCellBytes: 1024 * 1024,
  maximumDatabaseBytes: 64 * 1024 * 1024,
  maximumMapRows: 100_000,
  maximumMapBytes: 8 * 1024 * 1024,
  maximumReaderRows: 1_000_000,
  executionBudgetMs: 5_000,
});

export interface SqlHandle {
  serviceEpoch: ServiceInteger;
  id: ServiceInteger;
}

export interface SqlRevision {
  sha256: Uint8Array;
}

export type SqlValue = null | bigint | string;
export type SqlOperation =
  | {
      kind: "open";
      connection: SqlHandle;
      logicalName: string;
      identity: {
        source: { kind: "memory" } | { kind: "resource"; resourceId: string; sha256: Uint8Array };
        sqliteVersion: string;
        formatVersion: number;
      };
      revision: { kind: "current" } | { kind: "exact"; revision: SqlRevision };
    }
  | {
      kind: "execute";
      connection: SqlHandle;
      mode: 0 | 1 | 2 | 3;
      sql: string;
      parameters: SqlValue[];
    }
  | { kind: "reader_read"; reader: SqlHandle }
  | { kind: "reader_get"; reader: SqlHandle; column: number; mode: 0 | 1 }
  | { kind: "reader_is_null"; reader: SqlHandle; column: number }
  | { kind: "reader_close"; reader: SqlHandle }
  | { kind: "import_map_rows"; connection: SqlHandle; table: string; rows: [string, string][] }
  | { kind: "disconnect"; connection: SqlHandle };

export interface SqlRequest {
  provider: SqlHandle;
  operation: SqlOperation;
}

export const SqlErrorCode = Object.freeze({
  InvalidRequest: 0,
  InvalidName: 1,
  InvalidSource: 2,
  InvalidConnectionString: 3,
  ConnectionLimit: 4,
  ConnectionConflict: 5,
  ConnectionNotFound: 6,
  ReaderLimit: 7,
  ReaderNotFound: 8,
  ColumnOutOfRange: 9,
  TypeMismatch: 10,
  SqlTooLarge: 11,
  ParameterLimit: 12,
  ParameterBytesLimit: 13,
  CellTooLarge: 14,
  DatabaseTooLarge: 15,
  MapRowLimit: 16,
  MapBytesLimit: 17,
  ReaderRowLimit: 18,
  ExecutionTimeout: 19,
  TransactionActive: 20,
  RevisionConflict: 21,
  RevisionMissing: 22,
  StorageFailure: 23,
  Sqlite: 24,
  Cancelled: 25,
  StaleEpoch: 26,
  InvalidTableName: 27,
  InvalidState: 28,
  Unsupported: 29,
});

export type SqlErrorCodeValue = (typeof SqlErrorCode)[keyof typeof SqlErrorCode];

const LIMIT_KEYS = Array.from({ length: 11 }, (_, index) => index);

export function decodeSqlRequest(value: unknown): SqlRequest {
  const fields = serviceMap(value, [0, 1], "SQL request");
  const provider = decodeHandle(fields.get(0), "SQL provider");
  const operation = fields.get(1);
  if (!Array.isArray(operation) || operation.length !== 2 || !Number.isInteger(operation[0]))
    invalid("SQL operation");
  const operationFields = variantFields(operation, "SQL operation");
  switch (operation[0]) {
    case 0: {
      exactLength(operationFields, 5, "SQL open operation");
      const identity = serviceMap(operationFields[2], [0, 1, 2], "SQL database identity");
      const source = identity.get(0);
      if (!Array.isArray(source) || source.length !== 2) invalid("SQL database source");
      const sourceFields = variantFields(source, "SQL database source");
      let decodedSource: Extract<SqlOperation, { kind: "open" }>["identity"]["source"];
      if (source[0] === 0 && sourceFields.length === 0) decodedSource = { kind: "memory" };
      else if (source[0] === 1 && sourceFields.length === 1) {
        const seed = serviceMap(sourceFields[0], [0, 1], "SQL resource seed");
        decodedSource = {
          kind: "resource",
          resourceId: text(seed.get(0), "SQL resource ID"),
          sha256: bytes32(seed.get(1), "SQL seed SHA-256"),
        };
      } else invalid("SQL database source");
      const openRevision = operationFields[3];
      if (!Array.isArray(openRevision) || openRevision.length !== 2) invalid("SQL open revision");
      const revisionFields = variantFields(openRevision, "SQL open revision");
      const revision: Extract<SqlOperation, { kind: "open" }>["revision"] =
        revisionFields.length === 0 && openRevision[0] === 0
          ? { kind: "current" }
          : revisionFields.length === 1 && openRevision[0] === 1
            ? { kind: "exact", revision: decodeRevision(revisionFields[0]) }
            : invalid("SQL open revision");
      validateLimits(operationFields[4]);
      return {
        provider,
        operation: {
          kind: "open",
          connection: decodeHandle(operationFields[0], "SQL connection"),
          logicalName: text(operationFields[1], "SQL logical name"),
          identity: {
            source: decodedSource,
            sqliteVersion: text(identity.get(1), "SQLite version"),
            formatVersion: unsignedNumber(identity.get(2), "SQL database format version"),
          },
          revision,
        },
      };
    }
    case 1:
      if (operationFields.length !== 4 || ![0, 1, 2, 3].includes(Number(operationFields[1])))
        invalid("SQL execute operation");
      if (!Array.isArray(operationFields[3])) invalid("SQL parameters");
      return {
        provider,
        operation: {
          kind: "execute",
          connection: decodeHandle(operationFields[0], "SQL connection"),
          mode: executeMode(operationFields[1]),
          sql: text(operationFields[2], "SQL text"),
          parameters: operationFields[3].map(decodeValue),
        },
      };
    case 2:
      exactLength(operationFields, 1, "SQL reader read");
      return {
        provider,
        operation: { kind: "reader_read", reader: decodeHandle(operationFields[0], "SQL reader") },
      };
    case 3:
      exactLength(operationFields, 3, "SQL reader get operation");
      if (operationFields[2] !== 0 && operationFields[2] !== 1) invalid("SQL reader get mode");
      return {
        provider,
        operation: {
          kind: "reader_get",
          reader: decodeHandle(operationFields[0], "SQL reader"),
          column: unsignedNumber(operationFields[1], "SQL reader column", 0xffffffff),
          mode: operationFields[2],
        },
      };
    case 4:
      exactLength(operationFields, 2, "SQL reader null operation");
      return {
        provider,
        operation: {
          kind: "reader_is_null",
          reader: decodeHandle(operationFields[0], "SQL reader"),
          column: unsignedNumber(operationFields[1], "SQL reader column", 0xffffffff),
        },
      };
    case 5:
      exactLength(operationFields, 1, "SQL reader close");
      return {
        provider,
        operation: { kind: "reader_close", reader: decodeHandle(operationFields[0], "SQL reader") },
      };
    case 6: {
      exactLength(operationFields, 3, "SQL MAP import");
      if (!Array.isArray(operationFields[2])) invalid("SQL MAP rows");
      return {
        provider,
        operation: {
          kind: "import_map_rows",
          connection: decodeHandle(operationFields[0], "SQL connection"),
          table: text(operationFields[1], "SQL MAP table"),
          rows: operationFields[2].map((entry) => {
            const row = serviceMap(entry, [0, 1], "SQL MAP row");
            const decoded: [string, string] = [
              text(row.get(0), "SQL MAP key"),
              text(row.get(1), "SQL MAP value"),
            ];
            return decoded;
          }),
        },
      };
    }
    case 7:
      exactLength(operationFields, 1, "SQL disconnect");
      return {
        provider,
        operation: {
          kind: "disconnect",
          connection: decodeHandle(operationFields[0], "SQL connection"),
        },
      };
    default:
      return invalid("SQL operation tag");
  }
}

export function encodeSqlResponse(value: {
  provider: SqlHandle;
  database?: {
    connection: SqlHandle;
    connected: boolean;
    transactionActive: boolean;
    durableRevision?: Uint8Array;
  };
  reader?: { reader: SqlHandle; status: number; rowsRead: ServiceInteger };
  result: unknown[];
}): Map<number, unknown> {
  return new Map<number, unknown>([
    [0, encodeHandle(value.provider)],
    [
      1,
      value.database
        ? new Map<number, unknown>([
            [0, encodeHandle(value.database.connection)],
            [1, value.database.connected],
            [2, value.database.transactionActive],
            [
              3,
              value.database.durableRevision
                ? encodeRevision(value.database.durableRevision)
                : null,
            ],
          ])
        : null,
    ],
    [
      2,
      value.reader
        ? new Map<number, unknown>([
            [0, encodeHandle(value.reader.reader)],
            [1, value.reader.status],
            [2, value.reader.rowsRead],
          ])
        : null,
    ],
    [3, value.result],
  ]);
}

export function sqlErrorResult(
  code: SqlErrorCodeValue,
  operation: number,
  context: Record<string, string> = {},
  sqliteCode: number | null = null,
  sqliteMessage: string | null = null,
): unknown[] {
  return [
    10,
    [
      new Map<number, unknown>([
        [0, code],
        [1, operation],
        [
          2,
          Object.entries(context).map(
            ([key, value]) =>
              new Map<number, unknown>([
                [0, key],
                [1, value],
              ]),
          ),
        ],
        [3, sqliteCode],
        [4, sqliteMessage],
      ]),
    ],
  ];
}

export function encodeSqlValue(value: SqlValue): unknown[] {
  if (value === null) return [0, []];
  return typeof value === "string"
    ? [2, [value]]
    : [1, [checkedSqlI64(value, "SQL response integer")]];
}

export function checkedSqlI64(value: unknown, name: string): bigint {
  const integer =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : undefined;
  if (integer == null || integer < -(1n << 63n) || integer > (1n << 63n) - 1n)
    throw new RangeError(`${name} is not a signed 64-bit integer`);
  return integer;
}

export function operationKind(operation: SqlOperation): number {
  return [
    "open",
    "execute",
    "reader_read",
    "reader_get",
    "reader_is_null",
    "reader_close",
    "import_map_rows",
    "disconnect",
  ].indexOf(operation.kind);
}

export function handleKey(handle: SqlHandle): string {
  return `${handle.serviceEpoch}:${handle.id}`;
}

export function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("SQL revision is not lowercase SHA-256");
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index++)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

/** Cross-client chain identity preimage. Keep byte-for-byte aligned with the TUI provider. */
export function sqlIdentityPreimage(resourceId: string, seedSha256: Uint8Array): Uint8Array {
  validateSqlResourceId(resourceId);
  const prefix = new TextEncoder().encode("rustyera.sql.identity.v1\0");
  const resource = new TextEncoder().encode(resourceId);
  const sqlite = new TextEncoder().encode(`${SQL_SQLITE_VERSION}\0`);
  const result = new Uint8Array(prefix.length + 4 + resource.length + 32 + sqlite.length + 4);
  let offset = 0;
  result.set(prefix, offset);
  offset += prefix.length;
  new DataView(result.buffer).setUint32(offset, resource.length, false);
  offset += 4;
  result.set(resource, offset);
  offset += resource.length;
  result.set(bytes32(seedSha256, "SQL seed SHA-256"), offset);
  offset += 32;
  result.set(sqlite, offset);
  offset += sqlite.length;
  new DataView(result.buffer).setUint32(offset, SQL_DATABASE_FORMAT_VERSION, false);
  return result;
}

export function sqlIdentityDigest(resourceId: string, seedSha256: Uint8Array): Uint8Array {
  return sha256(sqlIdentityPreimage(resourceId, seedSha256));
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

function decodeHandle(value: unknown, name: string): SqlHandle {
  const fields = serviceMap(value, [0, 1], name);
  return {
    serviceEpoch: serviceInteger(fields.get(0), `${name} epoch`),
    id: serviceInteger(fields.get(1), `${name} ID`),
  };
}

function encodeHandle(value: SqlHandle): Map<number, unknown> {
  return new Map<number, unknown>([
    [0, value.serviceEpoch],
    [1, value.id],
  ]);
}

function decodeRevision(value: unknown): SqlRevision {
  const fields = serviceMap(value, [0], "SQL revision");
  return { sha256: bytes32(fields.get(0), "SQL revision SHA-256") };
}

function encodeRevision(value: Uint8Array): Map<number, unknown> {
  return new Map<number, unknown>([[0, value]]);
}

function decodeValue(value: unknown): SqlValue {
  if (!Array.isArray(value) || value.length !== 2) invalid("SQL value");
  const fields = variantFields(value, "SQL value");
  if (fields.length === 0 && value[0] === 0) return null;
  if (fields.length !== 1) invalid("SQL value");
  if (value[0] === 1)
    return checkedSqlI64(serviceInteger(fields[0], "SQL integer", true), "SQL integer");
  if (value[0] === 2) return text(fields[0], "SQL string");
  return invalid("SQL value tag");
}

export function validateSqlResourceId(resourceId: string): void {
  const bytes = new TextEncoder().encode(resourceId);
  const parts = resourceId.split("/");
  if (
    !resourceId ||
    resourceId.normalize("NFC") !== resourceId ||
    bytes.length > 4096 ||
    resourceId.includes("\\") ||
    resourceId.includes("\0") ||
    resourceId.includes(":") ||
    resourceId.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    invalid("SQL Resource seed ID");
}

function validateLimits(value: unknown): void {
  const fields = serviceMap(value, LIMIT_KEYS, "SQL limits");
  const expected = Object.values(SQL_LIMITS);
  for (let index = 0; index < expected.length; index++) {
    const actual = serviceInteger(fields.get(index), `SQL limit ${index}`);
    if (!sameServiceInteger(actual, expected[index])) invalid(`SQL limit ${index}`);
  }
}

function bytes32(value: unknown, name: string): Uint8Array {
  const typed = uint8Array(value);
  const bytes = typed
    ? typed
    : Array.isArray(value) &&
        value.every(
          (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      ? Uint8Array.from(value)
      : undefined;
  if (!bytes || bytes.length !== 32) return invalid(name);
  return bytes;
}

function uint8Array(value: unknown): Uint8Array | undefined {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== "[object Uint8Array]")
    return undefined;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") return invalid(name);
  return value;
}

function unsignedNumber(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const integer = serviceInteger(value, name);
  if (BigInt(integer) > BigInt(maximum)) return invalid(name);
  return Number(integer);
}

function executeMode(value: unknown): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return invalid("SQL execute mode");
}

function exactLength(value: unknown[], length: number, name: string): void {
  if (value.length !== length) invalid(name);
}

function variantFields(value: unknown[], name: string): unknown[] {
  if (!Array.isArray(value[1])) return invalid(name);
  return value[1];
}

function invalid(name: string): never {
  throw new RuntimeServiceError("invalid_request", `${name} has an invalid CBOR shape`);
}
