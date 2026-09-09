import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it } from "vitest";

import { bytesHex, sha256Bytes } from "@/core/sqlProtocol";
import {
  SqlStorage,
  SqlStorageError,
  sqlCurrentPath,
  sqlRevisionPath,
} from "@/platform/sqlStorage";

const acceptSeed = async () => undefined;

class MemorySqlBridge {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: any[] = [];
  readonly extraEntries: { relative_path: string; byte_length: number }[] = [];
  omitNextCurrentRevision = false;

  constructor(readonly resource: Uint8Array) {}

  async readResource(path: string) {
    if (path !== "plugins/qol_data.db") throw new Error("not found");
    return this.resource.slice();
  }

  async handleStorage(request: any) {
    this.requests.push(request);
    const current = this.files.get(request.relative_path);
    if (request.operation.type === "read")
      return current
        ? { result: { type: "read", data: current.slice(), revision: digest(current) } }
        : { result: { type: "error", error: { kind: "not_found" } } };
    if (request.operation.type === "list") {
      const prefix = `${request.relative_path}/`;
      return {
        result: {
          type: "listed",
          entries: [...this.files]
            .filter(([path]) => path.startsWith(prefix))
            .map(([path, bytes]) => ({ relative_path: path, byte_length: bytes.byteLength }))
            .concat(this.extraEntries),
        },
      };
    }
    const precondition = request.operation.precondition;
    if (
      (precondition.type === "missing" && current) ||
      (precondition.type === "revision" && (!current || digest(current) !== precondition.revision))
    )
      return { result: { type: "error", error: { kind: "conflict" } } };
    const bytes = new Uint8Array(request.operation.data);
    this.files.set(request.relative_path, bytes);
    if (this.omitNextCurrentRevision && request.relative_path.endsWith("/current")) {
      this.omitNextCurrentRevision = false;
      return { result: { type: "written", revision: null } };
    }
    return { result: { type: "written", revision: digest(bytes) } };
  }
}

function legacyIdentity(prefix: string, name: string, seed?: Uint8Array) {
  const encoder = new TextEncoder();
  const encodedName = encoder.encode(name);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, encodedName.length, false);
  return bytesHex(
    sha256Bytes(
      new Uint8Array([
        ...encoder.encode(prefix + "\0"),
        ...length,
        ...encodedName,
        ...(seed ?? []),
        ...encoder.encode("3.53.0\0"),
        0,
        0,
        0,
        1,
      ]),
    ),
  );
}

describe("SQL revision storage", () => {
  it("reuses legacy resource current/exact paths and CAS without rewriting old bytes", async () => {
    const seed = new TextEncoder().encode("immutable old seed");
    const current = new TextEncoder().encode("old current database");
    const exact = new TextEncoder().encode("older exact database");
    const currentRevision = sha256Bytes(current);
    const exactRevision = sha256Bytes(exact);
    const identity = legacyIdentity(
      "rustyera.sql.identity.v1",
      "plugins/qol_data.db",
      sha256Bytes(seed),
    );
    const bridge = new MemorySqlBridge(seed);
    const pointerPath = `sql/v1/${identity}/current`;
    const currentPath = `sql/v1/${identity}/revisions/${bytesHex(currentRevision)}.sqlite3`;
    const exactPath = `sql/v1/${identity}/revisions/${bytesHex(exactRevision)}.sqlite3`;
    const pointer = new TextEncoder().encode(bytesHex(currentRevision) + "\n");
    bridge.files.set(pointerPath, pointer);
    bridge.files.set(currentPath, current);
    bridge.files.set(exactPath, exact);
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "current" },
      acceptSeed,
    );
    const restored = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "exact", sha256: exactRevision },
      acceptSeed,
    );
    expect(opened.chain!.identityHex).toBe(identity);
    expect(restored.chain!.identityHex).toBe(identity);
    expect(bytesHex(opened.bytes!)).toBe(bytesHex(current));
    expect(bytesHex(restored.bytes!)).toBe(bytesHex(exact));
    expect(restored.durableRevision).toEqual(exactRevision);
    expect(bridge.requests.every((request) => request.operation.type === "read")).toBe(true);
    const next = new TextEncoder().encode("new database");
    await storage.publish(opened.chain!, currentRevision, next, sha256Bytes(next));
    expect(bridge.requests.at(-1)).toMatchObject({
      relative_path: pointerPath,
      operation: { precondition: { type: "revision", revision: digest(pointer) } },
    });
    expect(bridge.files.get(currentPath)).toEqual(current);
    expect(bridge.files.get(exactPath)).toEqual(exact);
    expect(bridge.resource).toEqual(seed);
  });

  it("keeps the legacy Web memory exact revision path", async () => {
    const bytes = new TextEncoder().encode("old memory revision");
    const revision = sha256Bytes(bytes);
    const identity = legacyIdentity("rustyera.sql.memory.v1", "db");
    const bridge = new MemorySqlBridge(new Uint8Array());
    const path = `sql/v1/${identity}/revisions/${bytesHex(revision)}.sqlite3`;
    bridge.files.set(path, bytes);
    const opened = await new SqlStorage(bridge as never).openMemory("db", {
      kind: "exact",
      sha256: revision,
    });
    expect(opened.chain!.identityHex).toBe(identity);
    expect(bytesHex(opened.bytes!)).toBe(bytesHex(bytes));
    expect(opened.durableRevision).toEqual(revision);
    expect(bridge.requests.map((request) => request.relative_path)).toEqual([path]);
    expect(bridge.files.size).toBe(1);
  });

  it("seeds a content-addressed revision before atomically creating current", async () => {
    const seed = new TextEncoder().encode("SQLite fixture");
    const bridge = new MemorySqlBridge(seed);
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "current" },
      acceptSeed,
    );
    const identity = opened.chain!.identityHex;
    const revision = bytesHex(sha256Bytes(seed));

    expect(bytesHex(bridge.files.get(sqlRevisionPath(identity, revision))!)).toBe(bytesHex(seed));
    expect(new TextDecoder().decode(bridge.files.get(sqlCurrentPath(identity)))).toBe(
      `${revision}\n`,
    );
    expect(bridge.requests.at(-1).operation).toMatchObject({
      type: "write",
      atomic_replace: true,
      precondition: { type: "missing" },
    });
  });

  it("validates a Resource seed before creating any durable revision", async () => {
    const seed = new TextEncoder().encode("not SQLite");
    const bridge = new MemorySqlBridge(seed);
    const storage = new SqlStorage(bridge as never);

    await expect(
      storage.openResource(
        "plugins/qol_data.db",
        sha256Bytes(seed),
        { kind: "current" },
        async () => {
          throw new SqlStorageError(2, "invalid SQLite seed");
        },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(bridge.requests).toEqual([]);
    expect(bridge.files.size).toBe(0);
  });

  it("publishes a new blob missing-only then CAS-replaces current", async () => {
    const seed = new TextEncoder().encode("old database");
    const bridge = new MemorySqlBridge(seed);
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "current" },
      acceptSeed,
    );
    const next = new TextEncoder().encode("new database");
    const nextRevision = sha256Bytes(next);

    await storage.publish(opened.chain!, opened.durableRevision!, next, nextRevision);

    expect(
      new TextDecoder().decode(bridge.files.get(sqlCurrentPath(opened.chain!.identityHex))),
    ).toBe(`${bytesHex(nextRevision)}\n`);
    expect(bridge.requests.at(-1).operation.precondition).toEqual({
      type: "revision",
      revision: expect.any(String),
    });
  });

  it("stores memory revisions without a current pointer and reopens an exact revision", async () => {
    const bridge = new MemorySqlBridge(new Uint8Array());
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openMemory("TR_DB", { kind: "current" });
    const bytes = new TextEncoder().encode("memory database");
    const revision = sha256Bytes(bytes);

    await storage.publish(opened.chain, undefined, bytes, revision);
    const restored = await storage.openMemory("tr_db", { kind: "exact", sha256: revision });

    expect(bytesHex(restored.bytes!)).toBe(bytesHex(bytes));
    expect(bytesHex(restored.durableRevision!)).toBe(bytesHex(revision));
    expect(restored.chain.currentDatabaseRevision).toBe(bytesHex(revision));
    expect(bridge.files.has(sqlCurrentPath(opened.chain.identityHex))).toBe(false);
  });

  it("rejects a seed before writing when immutable chain quota is already exhausted", async () => {
    const seed = new TextEncoder().encode("new seed");
    const bridge = new MemorySqlBridge(seed);
    bridge.extraEntries.push({
      relative_path: "existing.sqlite3",
      byte_length: 64 * 1024 * 1024,
    });
    const storage = new SqlStorage(bridge as never);

    await expect(
      storage.openResource(
        "plugins/qol_data.db",
        sha256Bytes(seed),
        { kind: "current" },
        acceptSeed,
      ),
    ).rejects.toMatchObject({ code: 15 });

    expect(bridge.requests.some((request) => request.operation.type === "write")).toBe(false);
  });

  it("leaves a competing current pointer intact when its storage revision CAS fails", async () => {
    const seed = new TextEncoder().encode("old database");
    const bridge = new MemorySqlBridge(seed);
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "current" },
      acceptSeed,
    );
    const currentPath = sqlCurrentPath(opened.chain.identityHex);
    const competing = `${"f".repeat(64)}\n`;
    bridge.files.set(currentPath, new TextEncoder().encode(competing));
    const next = new TextEncoder().encode("new database");

    await expect(
      storage.publish(opened.chain, opened.durableRevision, next, sha256Bytes(next)),
    ).rejects.toMatchObject({ code: 21, commitOutcome: "not_committed" });
    expect(new TextDecoder().decode(bridge.files.get(currentPath))).toBe(competing);
  });

  it("marks errors after a successful current write as committed and never rollback-safe", async () => {
    const seed = new TextEncoder().encode("old database");
    const bridge = new MemorySqlBridge(seed);
    const storage = new SqlStorage(bridge as never);
    const opened = await storage.openResource(
      "plugins/qol_data.db",
      sha256Bytes(seed),
      { kind: "current" },
      acceptSeed,
    );
    const next = new TextEncoder().encode("committed database");
    const nextRevision = sha256Bytes(next);
    bridge.omitNextCurrentRevision = true;

    let failure: unknown;
    try {
      await storage.publish(opened.chain, opened.durableRevision, next, nextRevision);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SqlStorageError);
    expect(failure).toMatchObject({ commitOutcome: "committed" });
    expect(
      new TextDecoder().decode(bridge.files.get(sqlCurrentPath(opened.chain.identityHex))),
    ).toBe(`${bytesHex(nextRevision)}\n`);
  });

  it("rejects non-canonical storage digest paths", () => {
    expect(() => sqlCurrentPath("A".repeat(64))).toThrow("lowercase SHA-256");
    expect(() => sqlRevisionPath("0".repeat(64), "short")).toThrow("lowercase SHA-256");
  });
});

function digest(bytes: Uint8Array): string {
  return bytesHex(blake3(bytes));
}
