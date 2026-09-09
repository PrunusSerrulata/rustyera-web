// @vitest-environment node
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesHex, sha256Bytes, SQL_SQLITE_VERSION, type SqlOperation } from "@/core/sqlProtocol";
import { SqlStorage, type SqlOpenMaterial } from "@/platform/sqlStorage";
import {
  decodeSqlWorkerReply,
  type SqlWorkerExecuteResult,
  type SqlWorkerReply,
} from "@/platform/sqlWorkerProtocol";
import { snakeSqlContract, snakeSqlFixtureUrl } from "./snakeSqlContract.mjs";

const resourceId = "plugins/qol_data.db";
const encoder = new TextEncoder();
const provider = { serviceEpoch: 1n, id: 1n };
const connection = { serviceEpoch: 1n, id: 1n };
let sequence = 0;
const pending = new Map<number, (reply: SqlWorkerReply) => void>();
const worker = {
  onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>),
  postMessage(value: unknown) {
    const reply = decodeSqlWorkerReply(value);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  },
};

beforeAll(async () => {
  vi.stubGlobal("self", worker);
  await import("@/platform/sql.worker");
});
beforeEach(async () => {
  await send({ type: "reset" });
});
afterAll(async () => {
  try {
    await send({ type: "reset" });
  } finally {
    vi.unstubAllGlobals();
  }
});

async function send(command: Record<string, unknown>): Promise<SqlWorkerReply> {
  const id = ++sequence;
  const response = new Promise<SqlWorkerReply>((resolve) => pending.set(id, resolve));
  try {
    await worker.onmessage!({ data: { id, ...command } });
    const reply = await response;
    if (reply.type === "error") throw new Error(reply.error);
    return reply;
  } finally {
    pending.delete(id);
  }
}

async function execute(
  operation: SqlOperation,
  material?: SqlOpenMaterial,
): Promise<SqlWorkerExecuteResult> {
  const reply = await send({
    type: "execute",
    value: {
      request: { provider, operation },
      persistent: true,
      reusableScalarResults: false,
      readerRowResults: false,
      initialBytes: material?.bytes,
      durableRevision: material?.durableRevision,
    },
  });
  if (reply.type !== "executed") throw new Error("Expected executed SQLite reply");
  expect((reply.result.response.get(3) as unknown[])[0]).not.toBe(10);
  return reply.result;
}

function statement(sql: string, mode: 0 | 1 | 2 = 0) {
  return execute({ kind: "execute", connection, sql, mode, parameters: [] });
}

async function queryVersion(expected: bigint) {
  const result = await statement("SELECT version FROM seed_marker", 1);
  expect(result.publication).toBeUndefined();
  expect(result.response.get(3)).toEqual([2, [[1, [expected]]]]);
}

// Only project I/O is in memory: validation, SQL execution, transactions and
// publication bytes all come from the production SQLite Worker and SqlStorage.
class MemorySqlBridge {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: any[] = [];
  constructor(readonly resource: Uint8Array) {}
  async readResource(path: string) {
    if (path !== resourceId) throw new Error("not found");
    return this.resource.slice();
  }
  async handleStorage(request: any) {
    this.requests.push(request);
    const current = this.files.get(request.relative_path);
    const revision = (bytes: Uint8Array) => bytesHex(blake3(bytes));
    if (request.operation.type === "read")
      return current
        ? { result: { type: "read", data: current.slice(), revision: revision(current) } }
        : { result: { type: "error", error: { kind: "not_found" } } };
    if (request.operation.type === "list")
      return {
        result: {
          type: "listed",
          entries: [...this.files]
            .filter(([path]) => path.startsWith(`${request.relative_path}/`))
            .map(([relative_path, bytes]) => ({ relative_path, byte_length: bytes.byteLength })),
        },
      };
    const condition = request.operation.precondition;
    if (
      (condition.type === "missing" && current) ||
      (condition.type === "revision" && (!current || revision(current) !== condition.revision))
    )
      return { result: { type: "error", error: { kind: "conflict" } } };
    const bytes = new Uint8Array(request.operation.data);
    this.files.set(request.relative_path, bytes);
    return { result: { type: "written", revision: revision(bytes) } };
  }
}

function legacyFixture() {
  const seed = new Uint8Array(readFileSync(snakeSqlFixtureUrl(resourceId)));
  expect(snakeSqlContract.sqliteVersion).toBe("3.53.0");
  expect(bytesHex(sha256Bytes(seed))).toBe(snakeSqlContract.seedSha256);
  expect(snakeSqlContract.seedSha256).toBe(
    "3eefa4c1f5e8eb01010ad3c3200364da0e506a639258062c0f7c52163eb0acd2",
  );
  const name = encoder.encode(resourceId);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, name.length, false);
  // Independent historical identity recipe: do not derive the expected old path
  // using the production helper whose migration behavior is under test.
  const identity = bytesHex(
    sha256Bytes(
      new Uint8Array([
        ...encoder.encode("rustyera.sql.identity.v1\0"),
        ...length,
        ...name,
        ...sha256Bytes(seed),
        ...encoder.encode("3.53.0\0"),
        0,
        0,
        0,
        1,
      ]),
    ),
  );
  const root = `sql/v1/${identity}`;
  const pointerPath = `${root}/current`;
  const seedPath = `${root}/revisions/${snakeSqlContract.seedSha256}.sqlite3`;
  const bridge = new MemorySqlBridge(seed.slice());
  bridge.files.set(seedPath, seed.slice());
  bridge.files.set(pointerPath, encoder.encode(`${snakeSqlContract.seedSha256}\n`));
  return {
    seed,
    identity,
    root,
    pointerPath,
    seedPath,
    bridge,
    storage: new SqlStorage(bridge as never),
  };
}

async function open(fixture: ReturnType<typeof legacyFixture>, exact?: Uint8Array) {
  const material = await fixture.storage.openResource(
    resourceId,
    sha256Bytes(fixture.seed),
    exact ? { kind: "exact", sha256: exact } : { kind: "current" },
    async (bytes) => {
      expect((await send({ type: "validate", value: bytes })).type).toBe("validated");
    },
  );
  expect(material.chain.identityHex).toBe(fixture.identity);
  const result = await execute(
    {
      kind: "open",
      connection,
      logicalName: "db",
      identity: {
        source: { kind: "resource", resourceId, sha256: sha256Bytes(fixture.seed) },
        sqliteVersion: SQL_SQLITE_VERSION,
        formatVersion: 1,
      },
      revision: exact ? { kind: "exact", revision: { sha256: exact } } : { kind: "current" },
    },
    material,
  );
  expect(SQL_SQLITE_VERSION).toBe("3.53.4");
  expect((result.response.get(3) as any[]).slice(0, 1)).toEqual([0]);
  expect((result.response.get(3) as any[])[1][0]).toBe("3.53.4");
  return material;
}

async function publish(
  fixture: ReturnType<typeof legacyFixture>,
  material: SqlOpenMaterial,
  result: SqlWorkerExecuteResult,
) {
  const publication = result.publication;
  if (!publication) throw new Error("Expected real SQLite publication");
  expect(sha256Bytes(publication.bytes)).toEqual(publication.revision);
  await fixture.storage.publish(
    material.chain,
    publication.expectedRevision,
    publication.bytes,
    publication.revision,
  );
  const settled = await send({
    type: "settle",
    value: { token: publication.token, accepted: true },
  });
  expect(settled).toMatchObject({
    type: "settled",
    result: { durableRevision: publication.revision, transactionActive: false },
  });
  return publication;
}

describe("SQLite 3.53.0 storage chains with the real 3.53.4 Worker", () => {
  it("opens historical Current/Exact, commits and rolls back without rewriting old revisions", async () => {
    const fixture = legacyFixture();
    const originalPointer = fixture.bridge.files.get(fixture.pointerPath)!.slice();
    const material = await open(fixture);
    await queryVersion(1n);
    expect(fixture.bridge.requests.every((request) => request.operation.type === "read")).toBe(
      true,
    );
    expect((await statement("BEGIN")).publication).toBeUndefined();
    expect((await statement("UPDATE seed_marker SET version=2")).publication).toBeUndefined();
    await queryVersion(2n);
    expect(fixture.bridge.files.get(fixture.pointerPath)).toEqual(originalPointer);
    const committed = await publish(fixture, material, await statement("COMMIT"));
    expect(committed.expectedRevision).toEqual(sha256Bytes(fixture.seed));
    const newPath = `${fixture.root}/revisions/${bytesHex(committed.revision)}.sqlite3`;
    const committedBytes = committed.bytes.slice();
    const committedPointer = encoder.encode(`${bytesHex(committed.revision)}\n`);
    expect(fixture.bridge.files.get(fixture.pointerPath)).toEqual(committedPointer);
    expect(fixture.bridge.requests.at(-1)).toMatchObject({
      relative_path: fixture.pointerPath,
      operation: {
        precondition: { type: "revision", revision: bytesHex(blake3(originalPointer)) },
      },
    });
    await send({ type: "reset" });
    await open(fixture);
    await queryVersion(2n);
    expect((await statement("BEGIN")).publication).toBeUndefined();
    expect((await statement("UPDATE seed_marker SET version=3")).publication).toBeUndefined();
    await queryVersion(3n);
    expect((await statement("ROLLBACK")).publication).toBeUndefined();
    await queryVersion(2n);
    await send({ type: "reset" });
    await open(fixture, sha256Bytes(fixture.seed));
    await queryVersion(1n);
    expect(fixture.bridge.files.get(fixture.pointerPath)).toEqual(committedPointer);
    expect(fixture.bridge.files.get(fixture.seedPath)).toEqual(fixture.seed);
    expect(fixture.bridge.files.get(newPath)).toEqual(committedBytes);
    expect(fixture.bridge.resource).toEqual(fixture.seed);
    expect(fixture.bridge.files.size).toBe(3);
  });

  it("rejects publication from Exact behind Current and restores the Worker without losing the new value", async () => {
    const fixture = legacyFixture();
    const current = await open(fixture);
    const committed = await publish(
      fixture,
      current,
      await statement("UPDATE seed_marker SET version=8"),
    );
    await send({ type: "reset" });
    const exact = await open(fixture, sha256Bytes(fixture.seed));
    await queryVersion(1n);
    const before = new Map([...fixture.bridge.files].map(([path, bytes]) => [path, bytes.slice()]));
    const writeCount = fixture.bridge.requests.filter(
      (request) => request.operation.type === "write",
    ).length;
    const result = await statement("UPDATE seed_marker SET version=9");
    const publication = result.publication;
    if (!publication) throw new Error("Expected stale Exact publication");
    expect(publication.expectedRevision).toEqual(sha256Bytes(fixture.seed));
    await expect(
      fixture.storage.publish(
        exact.chain,
        publication.expectedRevision,
        publication.bytes,
        publication.revision,
      ),
    ).rejects.toMatchObject({ code: 21, commitOutcome: "not_committed" });
    const settled = await send({
      type: "settle",
      value: { token: publication.token, accepted: false },
    });
    expect(settled).toMatchObject({
      type: "settled",
      result: { durableRevision: sha256Bytes(fixture.seed), transactionActive: false },
    });
    await queryVersion(1n);
    expect(fixture.bridge.files).toEqual(before);
    expect(
      fixture.bridge.requests.filter((request) => request.operation.type === "write"),
    ).toHaveLength(writeCount);
    await send({ type: "reset" });
    const reopened = await open(fixture);
    expect(reopened.durableRevision).toEqual(committed.revision);
    await queryVersion(8n);
    expect(fixture.bridge.files).toEqual(before);
    expect(fixture.bridge.resource).toEqual(fixture.seed);
  });
});
