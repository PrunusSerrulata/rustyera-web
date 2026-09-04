import type { FrontendBridge } from "@/core/types";
import {
  SQL_DATABASE_FORMAT_VERSION,
  SQL_SQLITE_VERSION,
  SqlErrorCode,
  bytesHex,
  hexBytes,
  sha256Bytes,
  sqlIdentityDigest,
  validateSqlResourceId,
  type SqlErrorCodeValue,
} from "@/core/sqlProtocol";

const MAXIMUM_DATABASE_BYTES = 64 * 1024 * 1024;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

type SqlStoragePrecondition = { type: "missing" } | { type: "revision"; revision: string };
type SqlStorageOperation =
  | { type: "read" }
  | { type: "list"; pattern: null; recursive: false }
  | {
      type: "write";
      data: Uint8Array;
      atomic_replace: true;
      precondition: SqlStoragePrecondition;
    };
type SqlStorageResult =
  | { type: "read"; data: Uint8Array; revision?: string }
  | { type: "written"; revision?: string }
  | { type: "listed"; entries: SqlStorageEntry[] }
  | { type: "error"; error: { kind: string } };
interface SqlStorageEntry {
  relative_path: string;
  byte_length: number;
}
interface SqlStorageRequest {
  request_id: bigint;
  namespace: "data";
  relative_path: string;
  operation: SqlStorageOperation;
  idempotency_key: string;
  deadline_ns: null;
}

export type SqlStorageCommitOutcome = "not_committed" | "committed" | "unknown";
export interface SqlPublishOutcome {
  status: "committed";
  databaseRevision: string;
  storageRevision: string;
}

export interface SqlStorageChain {
  kind: "resource" | "memory";
  identityHex: string;
  currentDatabaseRevision?: string;
  currentStorageRevision?: string;
}

export interface SqlOpenMaterial {
  bytes?: Uint8Array;
  durableRevision?: Uint8Array;
  chain: SqlStorageChain;
}

export class SqlStorageError extends Error {
  constructor(
    readonly code: SqlErrorCodeValue,
    message: string,
    readonly context: Record<string, string> = {},
    readonly commitOutcome: SqlStorageCommitOutcome = "not_committed",
  ) {
    super(message);
    this.name = "SqlStorageError";
  }
}

/** Typed SQL-only projection of the shared project storage bridge. */
export class SqlStorage {
  private requestId = 1n;

  constructor(private readonly bridge: Pick<FrontendBridge, "readResource" | "handleStorage">) {}

  async openResource(
    resourceId: string,
    expectedSeedSha256: Uint8Array,
    revision: { kind: "current" } | { kind: "exact"; sha256: Uint8Array },
    validateSeed: (seed: Uint8Array) => Promise<void>,
  ): Promise<SqlOpenMaterial> {
    try {
      validateSqlResourceId(resourceId);
    } catch {
      throw new SqlStorageError(SqlErrorCode.InvalidSource, "SQL Resource seed ID is unsafe", {
        resource_id: resourceId,
      });
    }
    const seed = await this.bridge.readResource(resourceId).catch((error) => {
      throw new SqlStorageError(SqlErrorCode.InvalidSource, "cannot read SQL Resource seed", {
        resource_id: resourceId,
        reason: String(error),
      });
    });
    if (seed.byteLength > MAXIMUM_DATABASE_BYTES)
      throw new SqlStorageError(SqlErrorCode.DatabaseTooLarge, "SQL Resource seed is too large", {
        resource_id: resourceId,
        maximum_bytes: String(MAXIMUM_DATABASE_BYTES),
      });
    const actualSeed = sha256Bytes(seed);
    if (bytesHex(actualSeed) !== bytesHex(expectedSeedSha256))
      throw new SqlStorageError(SqlErrorCode.InvalidSource, "SQL Resource seed digest changed", {
        resource_id: resourceId,
        expected_sha256: bytesHex(expectedSeedSha256),
        actual_sha256: bytesHex(actualSeed),
      });
    await validateSeed(seed);

    const identityHex = bytesHex(sqlIdentityDigest(resourceId, expectedSeedSha256));
    const pointer = await this.readCurrent(identityHex);
    if (revision.kind === "exact") {
      const revisionHex = bytesHex(revision.sha256);
      const bytes = await this.readRevision(identityHex, revisionHex, true);
      return {
        bytes,
        durableRevision: revision.sha256,
        chain: {
          identityHex,
          kind: "resource",
          // An exact orphan can be restored after a failed current-pointer publication. Its
          // first successful write may create the missing pointer with a Missing CAS; an exact
          // revision behind an existing pointer still conflicts instead of overwriting it.
          currentDatabaseRevision: pointer?.databaseRevision ?? revisionHex,
          currentStorageRevision: pointer?.storageRevision,
        },
      };
    }

    if (pointer) {
      const bytes = await this.readRevision(identityHex, pointer.databaseRevision, true);
      return {
        bytes,
        durableRevision: hexBytes(pointer.databaseRevision),
        chain: {
          identityHex,
          kind: "resource",
          currentDatabaseRevision: pointer.databaseRevision,
          currentStorageRevision: pointer.storageRevision,
        },
      };
    }

    const seedRevision = bytesHex(actualSeed);
    await this.enforceChainQuota(identityHex, seedRevision, seed.byteLength);
    await this.writeRevision(identityHex, seedRevision, seed);
    const pointerWrite = await this.write(
      currentPath(identityHex),
      new TextEncoder().encode(`${seedRevision}\n`),
      { type: "missing" },
      "initialize-current",
      SqlErrorCode.RevisionConflict,
      true,
      "unknown",
    );
    if (isStorageError(pointerWrite, "conflict")) {
      const concurrent = await this.readCurrent(identityHex);
      if (!concurrent || concurrent.databaseRevision !== seedRevision)
        throw new SqlStorageError(SqlErrorCode.RevisionConflict, "SQL current revision changed", {
          expected_revision: seedRevision,
          actual_revision: concurrent?.databaseRevision ?? "missing",
        });
      return {
        bytes: seed,
        durableRevision: actualSeed,
        chain: {
          identityHex,
          kind: "resource",
          currentDatabaseRevision: seedRevision,
          currentStorageRevision: concurrent.storageRevision,
        },
      };
    }
    let seedStorageRevision: string;
    try {
      seedStorageRevision = requiredRevision(pointerWrite);
    } catch (error) {
      throw storageCommitError(error, "committed");
    }
    return {
      bytes: seed,
      durableRevision: actualSeed,
      chain: {
        identityHex,
        kind: "resource",
        currentDatabaseRevision: seedRevision,
        currentStorageRevision: seedStorageRevision,
      },
    };
  }

  async openMemory(
    logicalName: string,
    revision: { kind: "current" } | { kind: "exact"; sha256: Uint8Array },
  ): Promise<SqlOpenMaterial> {
    const identityHex = bytesHex(memoryIdentityDigest(logicalName));
    const chain: SqlStorageChain = { kind: "memory", identityHex };
    if (revision.kind === "current") return { chain };
    const revisionHex = bytesHex(revision.sha256);
    return {
      bytes: await this.readRevision(identityHex, revisionHex, true),
      durableRevision: revision.sha256,
      chain: { ...chain, currentDatabaseRevision: revisionHex },
    };
  }

  async publish(
    chain: SqlStorageChain,
    expectedRevision: Uint8Array | undefined,
    bytes: Uint8Array,
    revision: Uint8Array,
  ): Promise<SqlPublishOutcome> {
    if (bytes.byteLength > MAXIMUM_DATABASE_BYTES)
      throw new SqlStorageError(SqlErrorCode.DatabaseTooLarge, "SQL database exceeds its limit", {
        maximum_bytes: String(MAXIMUM_DATABASE_BYTES),
        actual_bytes: String(bytes.byteLength),
      });
    const expectedHex = expectedRevision ? bytesHex(expectedRevision) : undefined;
    if (chain.currentDatabaseRevision !== expectedHex)
      throw new SqlStorageError(SqlErrorCode.RevisionConflict, "SQL current revision changed", {
        expected_revision: expectedHex ?? "missing",
        actual_revision: chain.currentDatabaseRevision ?? "missing",
      });
    const revisionHex = bytesHex(revision);
    if (bytesHex(sha256Bytes(bytes)) !== revisionHex)
      throw new SqlStorageError(
        SqlErrorCode.InvalidState,
        "SQL Worker publication digest mismatch",
      );
    await this.enforceChainQuota(chain.identityHex, revisionHex, bytes.byteLength);
    await this.writeRevision(chain.identityHex, revisionHex, bytes);
    if (chain.kind === "memory") {
      // Memory databases deliberately have no current pointer: a normal Open starts empty on
      // every client lifecycle, while an owned save can still reopen any immutable exact blob.
      chain.currentDatabaseRevision = revisionHex;
      return { status: "committed", databaseRevision: revisionHex, storageRevision: revisionHex };
    }
    const precondition: SqlStoragePrecondition = chain.currentStorageRevision
      ? { type: "revision", revision: chain.currentStorageRevision }
      : { type: "missing" };
    let result: SqlStorageResult;
    try {
      result = await this.write(
        currentPath(chain.identityHex),
        new TextEncoder().encode(`${revisionHex}\n`),
        precondition,
        `publish-${revisionHex}`,
        SqlErrorCode.RevisionConflict,
        false,
        "unknown",
      );
    } catch (error) {
      if (error instanceof SqlStorageError) throw error;
      throw storageCommitError(error, "unknown");
    }
    // A Written result means the CAS has committed. Update the logical revision before reading
    // any optional response metadata so no later exception can be mistaken for a rollback-safe
    // failure.
    chain.currentDatabaseRevision = revisionHex;
    let storageRevision: string;
    try {
      storageRevision = requiredRevision(result);
    } catch (error) {
      throw storageCommitError(error, "committed");
    }
    chain.currentStorageRevision = storageRevision;
    return { status: "committed", databaseRevision: revisionHex, storageRevision };
  }

  private async readCurrent(
    identityHex: string,
  ): Promise<{ databaseRevision: string; storageRevision: string } | undefined> {
    const result = await this.call(currentPath(identityHex), { type: "read" });
    if (isStorageError(result, "not_found")) return undefined;
    assertStorageResult(
      result,
      "read",
      SqlErrorCode.StorageFailure,
      "cannot read SQL current pointer",
    );
    const bytes = storageBytes(result.data);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/^[0-9a-f]{64}\n$/.test(text))
      throw new SqlStorageError(SqlErrorCode.StorageFailure, "SQL current pointer is malformed", {
        identity: identityHex,
      });
    return { databaseRevision: text.slice(0, -1), storageRevision: requiredRevision(result) };
  }

  private async readRevision(
    identityHex: string,
    revisionHex: string,
    missingIsRevisionMissing: boolean,
  ): Promise<Uint8Array> {
    const result = await this.call(revisionPath(identityHex, revisionHex), { type: "read" });
    if (isStorageError(result, "not_found") && missingIsRevisionMissing)
      throw new SqlStorageError(SqlErrorCode.RevisionMissing, "SQL database revision is missing", {
        revision: revisionHex,
      });
    assertStorageResult(result, "read", SqlErrorCode.StorageFailure, "cannot read SQL revision");
    const bytes = storageBytes(result.data);
    if (bytes.byteLength > MAXIMUM_DATABASE_BYTES || bytesHex(sha256Bytes(bytes)) !== revisionHex)
      throw new SqlStorageError(SqlErrorCode.StorageFailure, "SQL database revision is corrupt", {
        revision: revisionHex,
      });
    return bytes;
  }

  private async writeRevision(identityHex: string, revisionHex: string, bytes: Uint8Array) {
    const result = await this.write(
      revisionPath(identityHex, revisionHex),
      bytes,
      { type: "missing" },
      `revision-${revisionHex}`,
      SqlErrorCode.StorageFailure,
      true,
    );
    if (!isStorageError(result, "conflict")) return;
    // Another host may have published the same content-addressed blob. It is equivalent only
    // after a bounded read verifies the full digest.
    await this.readRevision(identityHex, revisionHex, false);
  }

  private async enforceChainQuota(
    identityHex: string,
    revisionHex: string,
    revisionBytes: number,
  ): Promise<void> {
    const result = await this.call(`sql/v1/${identityHex}/revisions`, {
      type: "list",
      pattern: null,
      recursive: false,
    });
    if (isStorageError(result, "not_found")) return;
    assertStorageResult(
      result,
      "listed",
      SqlErrorCode.StorageFailure,
      "cannot inspect SQL revision quota",
    );
    let total = 0;
    let present = false;
    for (const entry of result.entries ?? []) {
      if (!Number.isSafeInteger(Number(entry.byte_length)) || Number(entry.byte_length) < 0)
        throw new SqlStorageError(SqlErrorCode.StorageFailure, "SQL revision listing is malformed");
      total += Number(entry.byte_length);
      present ||=
        String(entry.relative_path).endsWith(`/${revisionHex}.sqlite3`) ||
        String(entry.relative_path) === `${revisionHex}.sqlite3`;
    }
    if (!present) total += revisionBytes;
    if (total > MAXIMUM_DATABASE_BYTES)
      throw new SqlStorageError(
        SqlErrorCode.DatabaseTooLarge,
        "SQL revision chain exceeds its quota",
        {
          maximum_bytes: String(MAXIMUM_DATABASE_BYTES),
          attempted_bytes: String(total),
        },
      );
  }

  private async write(
    relativePath: string,
    data: Uint8Array,
    precondition: SqlStoragePrecondition,
    idempotencySuffix: string,
    conflictCode: SqlErrorCodeValue = SqlErrorCode.StorageFailure,
    returnConflict = false,
    transportFailureOutcome: SqlStorageCommitOutcome = "not_committed",
  ): Promise<SqlStorageResult> {
    const result = await this.call(
      relativePath,
      {
        type: "write",
        data,
        atomic_replace: true,
        precondition,
      },
      idempotencySuffix,
      transportFailureOutcome,
    );
    if (returnConflict && isStorageError(result, "conflict")) return result;
    assertStorageResult(result, "written", conflictCode, "cannot publish SQL storage");
    return result;
  }

  private async call(
    relativePath: string,
    operation: SqlStorageOperation,
    suffix = "read",
    transportFailureOutcome: SqlStorageCommitOutcome = "not_committed",
  ): Promise<SqlStorageResult> {
    const requestId = this.requestId++;
    const request: SqlStorageRequest = {
      request_id: requestId,
      namespace: "data",
      relative_path: relativePath,
      operation,
      idempotency_key: `sql-v1-${requestId}-${suffix}`,
      deadline_ns: null,
    };
    let response: unknown;
    try {
      response = await this.bridge.handleStorage(request);
    } catch (error) {
      throw new SqlStorageError(
        SqlErrorCode.StorageFailure,
        "SQL storage bridge failed",
        { reason: String(error) },
        transportFailureOutcome,
      );
    }
    try {
      return decodeStorageResponse(response);
    } catch (error) {
      if (transportFailureOutcome === "not_committed") throw error;
      throw storageCommitError(error, transportFailureOutcome);
    }
  }
}

function memoryIdentityDigest(logicalName: string): Uint8Array {
  const normalized = logicalName.toLowerCase();
  const name = new TextEncoder().encode(normalized);
  const prefix = new TextEncoder().encode("rustyera.sql.memory.v1\0");
  const sqlite = new TextEncoder().encode(`${SQL_SQLITE_VERSION}\0`);
  const bytes = new Uint8Array(prefix.length + 4 + name.length + sqlite.length + 4);
  let offset = 0;
  bytes.set(prefix, offset);
  offset += prefix.length;
  new DataView(bytes.buffer).setUint32(offset, name.length, false);
  offset += 4;
  bytes.set(name, offset);
  offset += name.length;
  bytes.set(sqlite, offset);
  offset += sqlite.length;
  new DataView(bytes.buffer).setUint32(offset, SQL_DATABASE_FORMAT_VERSION, false);
  return sha256Bytes(bytes);
}

export function sqlRevisionPath(identityHex: string, revisionHex: string): string {
  return revisionPath(identityHex, revisionHex);
}

export function sqlCurrentPath(identityHex: string): string {
  return currentPath(identityHex);
}

function revisionPath(identityHex: string, revisionHex: string): string {
  requireDigestHex(identityHex, "SQL identity");
  requireDigestHex(revisionHex, "SQL revision");
  return `sql/v1/${identityHex}/revisions/${revisionHex}.sqlite3`;
}

function currentPath(identityHex: string): string {
  requireDigestHex(identityHex, "SQL identity");
  return `sql/v1/${identityHex}/current`;
}

function assertStorageResult<T extends SqlStorageResult["type"]>(
  result: SqlStorageResult,
  expected: T,
  code: SqlErrorCodeValue,
  message: string,
): asserts result is Extract<SqlStorageResult, { type: T }> {
  if (result.type === expected) return;
  const actualCode = isStorageError(result, "conflict") ? SqlErrorCode.RevisionConflict : code;
  throw new SqlStorageError(actualCode, message, {
    storage_error: result.type === "error" ? result.error.kind : result.type,
  });
}

function isStorageError(
  result: SqlStorageResult,
  kind: string,
): result is Extract<SqlStorageResult, { type: "error" }> {
  return result.type === "error" && result.error.kind === kind;
}

function requiredRevision(result: SqlStorageResult): string {
  if (
    (result.type !== "read" && result.type !== "written") ||
    typeof result.revision !== "string" ||
    !result.revision
  )
    throw new SqlStorageError(SqlErrorCode.StorageFailure, "SQL storage omitted revision identity");
  return result.revision;
}

function storageBytes(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]")
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (
    Array.isArray(value) &&
    value.every(
      (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    return Uint8Array.from(value);
  throw new SqlStorageError(SqlErrorCode.StorageFailure, "SQL storage returned invalid bytes");
}

function decodeStorageResponse(value: unknown): SqlStorageResult {
  const response = storageObject(value, "SQL storage response");
  const result = storageObject(response.result, "SQL storage result");
  if (result.type === "read")
    return {
      type: "read",
      data: storageBytes(result.data),
      revision: optionalStorageRevision(result.revision),
    };
  if (result.type === "written")
    return { type: "written", revision: optionalStorageRevision(result.revision) };
  if (result.type === "listed") {
    if (!Array.isArray(result.entries)) return invalidStorage("SQL storage entries");
    return {
      type: "listed",
      entries: result.entries.map((entry) => {
        const fields = storageObject(entry, "SQL storage entry");
        if (
          typeof fields.relative_path !== "string" ||
          typeof fields.byte_length !== "number" ||
          !Number.isSafeInteger(fields.byte_length) ||
          fields.byte_length < 0
        )
          return invalidStorage("SQL storage entry");
        return {
          relative_path: fields.relative_path,
          byte_length: fields.byte_length,
        };
      }),
    };
  }
  if (result.type === "error") {
    const error = storageObject(result.error, "SQL storage error");
    if (typeof error.kind !== "string") return invalidStorage("SQL storage error kind");
    return { type: "error", error: { kind: error.kind } };
  }
  return invalidStorage("SQL storage result type");
}

function optionalStorageRevision(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value) return invalidStorage("SQL storage revision");
  return value;
}

function storageObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidStorage(name);
  const record: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) record[key] = field;
  return record;
}

function requireDigestHex(value: string, name: string): void {
  if (!DIGEST_HEX.test(value))
    throw new SqlStorageError(SqlErrorCode.InvalidState, `${name} is not lowercase SHA-256`);
}

function storageCommitError(
  error: unknown,
  outcome: Exclude<SqlStorageCommitOutcome, "not_committed">,
): SqlStorageError {
  if (error instanceof SqlStorageError)
    return new SqlStorageError(error.code, error.message, error.context, outcome);
  return new SqlStorageError(
    SqlErrorCode.StorageFailure,
    "SQL current publication outcome is uncertain",
    { reason: String(error) },
    outcome,
  );
}

function invalidStorage(name: string): never {
  throw new SqlStorageError(SqlErrorCode.StorageFailure, `${name} is malformed`);
}

export const SQL_STORAGE_IDENTITY = Object.freeze({
  sqliteVersion: SQL_SQLITE_VERSION,
  formatVersion: SQL_DATABASE_FORMAT_VERSION,
});
