import {
  SQL_DATABASE_FORMAT_VERSION,
  SQL_LIMITS,
  SQL_SQLITE_VERSION,
  SqlErrorCode,
  decodeSqlRequest,
  encodeSqlResponse,
  handleKey,
  operationKind,
  sqlErrorResult,
  type SqlHandle,
  type SqlRequest,
} from "@/core/sqlProtocol";
import type { FrontendBridge } from "@/core/types";
import { sameServiceInteger, type ServiceInteger } from "@/core/runtimeServiceProtocol";
import { SqlStorage, SqlStorageError, type SqlStorageChain } from "@/platform/sqlStorage";
import {
  decodeSqlWorkerReply,
  type SqlWorkerCommand,
  type SqlWorkerDatabaseState,
  type SqlWorkerExecuteCommand,
  type SqlWorkerExecuteResult,
  type SqlWorkerReply,
} from "@/platform/sqlWorkerProtocol";

type SqlWorkerOutboundCommand =
  | Omit<Extract<SqlWorkerCommand, { type: "execute" }>, "id">
  | Omit<Extract<SqlWorkerCommand, { type: "validate" }>, "id">
  | Omit<Extract<SqlWorkerCommand, { type: "settle" }>, "id">;

export class SqlProvider {
  private readonly storage: SqlStorage;
  private readonly chains = new Map<string, SqlStorageChain>();
  private transport?: SqlWorkerTransport;
  private epoch?: ServiceInteger;
  private providerId?: ServiceInteger;
  private generation = 0;
  private tail = Promise.resolve();

  constructor(bridge: Pick<FrontendBridge, "readResource" | "handleStorage">) {
    this.storage = new SqlStorage(bridge);
  }

  handle(query: unknown, signal: AbortSignal): Promise<Map<number, unknown>> {
    const request = decodeSqlRequest(query);
    if (!this.enterProvider(request.provider))
      return Promise.resolve(
        encodeSqlResponse({
          provider: request.provider,
          result: sqlErrorResult(SqlErrorCode.StaleEpoch, operationKind(request.operation)),
        }),
      );
    const generation = this.generation;
    const operation = this.tail.then(() => this.execute(request, signal, generation));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  reset(): void {
    this.generation += 1;
    this.transport?.close();
    this.transport = undefined;
    this.chains.clear();
    this.epoch = undefined;
    this.providerId = undefined;
  }

  private async execute(
    request: SqlRequest,
    signal: AbortSignal,
    generation: number,
  ): Promise<Map<number, unknown>> {
    if (generation !== this.generation)
      return encodeSqlResponse({
        provider: request.provider,
        result: sqlErrorResult(SqlErrorCode.StaleEpoch, operationKind(request.operation)),
      });
    if (signal.aborted) throw new DOMException("SQL request cancelled", "AbortError");
    const workerCommand: SqlWorkerExecuteCommand = { request, persistent: false };
    let pendingChain: SqlStorageChain | undefined;
    try {
      const transport = (this.transport ??= new SqlWorkerTransport());
      validateRequestLimits(request);
      if (request.operation.kind === "open") {
        const { identity } = request.operation;
        if (
          identity.sqliteVersion !== SQL_SQLITE_VERSION ||
          identity.formatVersion !== SQL_DATABASE_FORMAT_VERSION
        )
          throw new SqlStorageError(
            SqlErrorCode.Unsupported,
            "SQL database identity is unsupported",
            {
              sqlite_version: identity.sqliteVersion,
              format_version: String(identity.formatVersion),
            },
          );
        if (identity.source.kind === "resource") {
          const revision: { kind: "current" } | { kind: "exact"; sha256: Uint8Array } =
            request.operation.revision.kind === "current"
              ? { kind: "current" }
              : { kind: "exact", sha256: request.operation.revision.revision.sha256 };
          const material = await this.storage.openResource(
            identity.source.resourceId,
            identity.source.sha256,
            revision,
            async (seed) => {
              try {
                await transport.validate(seed, signal);
              } catch (error) {
                throw new SqlStorageError(
                  SqlErrorCode.InvalidSource,
                  "SQL Resource seed is not a valid SQLite database",
                  { reason: error instanceof Error ? error.message : String(error) },
                );
              }
            },
          );
          workerCommand.initialBytes = material.bytes;
          workerCommand.durableRevision = material.durableRevision;
          workerCommand.persistent = true;
          pendingChain = material.chain;
        } else if (request.operation.revision.kind !== "current") {
          throw new SqlStorageError(
            SqlErrorCode.InvalidRequest,
            "memory SQL cannot open a revision",
          );
        }
      }

      const result = await transport.execute(workerCommand, signal);
      if (pendingChain && request.operation.kind === "open" && isOpenedResponse(result.response))
        this.chains.set(handleKey(request.operation.connection), pendingChain);
      if (result.publication) return await this.publish(request, result, signal);
      if (request.operation.kind === "disconnect")
        this.chains.delete(handleKey(request.operation.connection));
      return result.response;
    } catch (error) {
      if (signal.aborted) {
        this.reset();
        throw new DOMException("SQL request cancelled", "AbortError");
      }
      if (error instanceof SqlStorageError)
        return encodeSqlResponse({
          provider: request.provider,
          result: sqlErrorResult(error.code, operationKind(request.operation), error.context),
        });
      this.reset();
      return encodeSqlResponse({
        provider: request.provider,
        result: sqlErrorResult(SqlErrorCode.InvalidState, operationKind(request.operation), {
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  private async publish(
    request: SqlRequest,
    result: SqlWorkerExecuteResult,
    signal: AbortSignal,
  ): Promise<Map<number, unknown>> {
    const publication = result.publication;
    if (!publication)
      throw new SqlStorageError(SqlErrorCode.InvalidState, "SQL publication is missing");
    const chain = this.chains.get(handleKey(publication.connection));
    if (!chain || !publication.expectedRevision)
      throw new SqlStorageError(SqlErrorCode.InvalidState, "SQL publication has no durable base");
    const transport = this.transport;
    if (!transport)
      throw new SqlStorageError(SqlErrorCode.InvalidState, "SQL Worker transport is unavailable");
    let committed = false;
    try {
      const outcome = await this.storage.publish(
        chain,
        publication.expectedRevision,
        publication.bytes,
        publication.revision,
      );
      committed = outcome.status === "committed";
      await transport.settle(publication.token, true, signal);
      setResponseDurableRevision(result.response, publication.revision);
      return result.response;
    } catch (error) {
      // Once current has moved, the durable commit won the race with cancellation. Never ask the
      // Worker to restore the old revision; the caller's lifecycle reset will terminate it.
      const commitOutcome =
        error instanceof SqlStorageError
          ? error.commitOutcome
          : committed
            ? "committed"
            : "not_committed";
      if (committed || commitOutcome !== "not_committed") {
        this.reset();
        const storageError =
          error instanceof SqlStorageError
            ? error
            : new SqlStorageError(
                SqlErrorCode.StorageFailure,
                "SQL publication acknowledgement failed",
                {
                  reason: String(error),
                },
                commitOutcome,
              );
        return encodeSqlResponse({
          provider: request.provider,
          result: sqlErrorResult(storageError.code, operationKind(request.operation), {
            ...storageError.context,
            commit_outcome: commitOutcome,
          }),
        });
      }
      let state: SqlWorkerDatabaseState | undefined;
      try {
        state = await transport.settle(publication.token, false, signal);
      } catch {
        // A failed negative acknowledgement leaves the Worker publication state unknowable.
        // Terminating it is the only safe cleanup; the durable current pointer has not moved.
        this.reset();
      }
      if (signal.aborted) throw error;
      const storageError =
        error instanceof SqlStorageError
          ? error
          : new SqlStorageError(SqlErrorCode.StorageFailure, "SQL publication failed", {
              reason: String(error),
            });
      return encodeSqlResponse({
        provider: request.provider,
        database: state,
        result: sqlErrorResult(
          storageError.code,
          operationKind(request.operation),
          storageError.context,
        ),
      });
    }
  }

  private enterProvider(provider: SqlHandle): boolean {
    const { serviceEpoch: epoch, id } = provider;
    if (this.epoch == null || this.providerId == null) {
      this.epoch = epoch;
      this.providerId = id;
      return true;
    }
    if (sameServiceInteger(this.epoch, epoch)) return sameServiceInteger(this.providerId, id);
    if (BigInt(epoch) <= BigInt(this.epoch)) return false;
    this.reset();
    this.epoch = epoch;
    this.providerId = id;
    return true;
  }
}

class SqlWorkerTransport {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: SqlWorkerReply) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL("./sql.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      let reply: SqlWorkerReply;
      try {
        reply = decodeSqlWorkerReply(event.data);
      } catch (error) {
        this.fail(new Error(`invalid SQL Worker reply: ${String(error)}`));
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.type === "error") pending.reject(new Error(reply.error));
      else pending.resolve(reply);
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message || "SQL Worker crashed"));
  }

  async execute(
    value: SqlWorkerExecuteCommand,
    signal: AbortSignal,
  ): Promise<SqlWorkerExecuteResult> {
    const reply = await this.request({ type: "execute", value }, signal);
    if (reply.type !== "executed") throw new Error("SQL Worker returned the wrong reply kind");
    return reply.result;
  }

  async validate(value: Uint8Array, signal: AbortSignal): Promise<void> {
    const reply = await this.request({ type: "validate", value }, signal);
    if (reply.type !== "validated") throw new Error("SQL Worker returned the wrong reply kind");
  }

  async settle(
    token: number,
    accepted: boolean,
    signal: AbortSignal,
  ): Promise<SqlWorkerDatabaseState> {
    const reply = await this.request({ type: "settle", value: { token, accepted } }, signal);
    if (reply.type !== "settled") throw new Error("SQL Worker returned the wrong reply kind");
    return reply.result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.fail(new Error("SQL Worker closed"));
  }

  private request(command: SqlWorkerOutboundCommand, signal: AbortSignal): Promise<SqlWorkerReply> {
    if (this.closed) return Promise.reject(new Error("SQL Worker is closed"));
    const id = this.nextId++;
    return new Promise<SqlWorkerReply>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(new DOMException("SQL request cancelled", "AbortError"));
      };
      this.pending.set(id, {
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      this.worker.postMessage({ id, ...command } satisfies SqlWorkerCommand);
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function setResponseDurableRevision(response: Map<number, unknown>, revision: Uint8Array): void {
  const database = response.get(1);
  if (database instanceof Map) database.set(3, new Map<number, unknown>([[0, revision]]));
}

function isOpenedResponse(response: Map<number, unknown>): boolean {
  const result = response.get(3);
  return Array.isArray(result) && result[0] === 0 && Array.isArray(result[1]);
}

function validateRequestLimits(request: SqlRequest): void {
  const operation = request.operation;
  const sameEpoch = (handle: SqlHandle) =>
    sameServiceInteger(handle.serviceEpoch, request.provider.serviceEpoch);
  const handles: SqlHandle[] = [];
  if ("connection" in operation) handles.push(operation.connection);
  if ("reader" in operation) handles.push(operation.reader);
  if (handles.some((handle) => !sameEpoch(handle)))
    throw new SqlStorageError(SqlErrorCode.StaleEpoch, "SQL handle belongs to another epoch");
  if (operation.kind === "open") {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(operation.logicalName))
      throw new SqlStorageError(SqlErrorCode.InvalidName, "SQL logical connection name is invalid");
    return;
  }
  if (operation.kind === "execute") {
    const sqlBytes = new TextEncoder().encode(operation.sql).byteLength;
    if (sqlBytes > SQL_LIMITS.maximumSqlBytes)
      throw new SqlStorageError(SqlErrorCode.SqlTooLarge, "SQL text exceeds its limit");
    if (operation.parameters.length > SQL_LIMITS.maximumParameters)
      throw new SqlStorageError(
        SqlErrorCode.ParameterLimit,
        "SQL parameter count exceeds its limit",
      );
    let parameterBytes = 0;
    for (const value of operation.parameters) {
      const valueBytes =
        typeof value === "string"
          ? new TextEncoder().encode(value).byteLength
          : value === null
            ? 0
            : 8;
      if (valueBytes > SQL_LIMITS.maximumCellBytes)
        throw new SqlStorageError(
          SqlErrorCode.CellTooLarge,
          "SQL parameter cell exceeds its limit",
        );
      parameterBytes += valueBytes;
    }
    if (parameterBytes > SQL_LIMITS.maximumParameterBytes)
      throw new SqlStorageError(
        SqlErrorCode.ParameterBytesLimit,
        "SQL parameters exceed their byte limit",
      );
    return;
  }
  if (operation.kind === "import_map_rows") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(operation.table))
      throw new SqlStorageError(SqlErrorCode.InvalidTableName, "SQL MAP table name is invalid");
    if (operation.rows.length > SQL_LIMITS.maximumMapRows)
      throw new SqlStorageError(SqlErrorCode.MapRowLimit, "SQL MAP row count exceeds its limit");
    let mapBytes = 0;
    for (const [key, value] of operation.rows) {
      const keyBytes = new TextEncoder().encode(key).byteLength;
      const valueBytes = new TextEncoder().encode(value).byteLength;
      if (keyBytes > SQL_LIMITS.maximumCellBytes || valueBytes > SQL_LIMITS.maximumCellBytes)
        throw new SqlStorageError(SqlErrorCode.CellTooLarge, "SQL MAP cell exceeds its limit");
      mapBytes += keyBytes + valueBytes;
    }
    if (mapBytes > SQL_LIMITS.maximumMapBytes)
      throw new SqlStorageError(SqlErrorCode.MapBytesLimit, "SQL MAP rows exceed their byte limit");
  }
}
