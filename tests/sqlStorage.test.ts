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

describe("SQL revision storage", () => {
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
