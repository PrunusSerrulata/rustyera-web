import { describe, expect, it } from "vitest";

import { SQL_LIMITS, SQL_SQLITE_VERSION, encodeSqlResponse } from "@/core/sqlProtocol";
import { decodeSqlWorkerCommand, decodeSqlWorkerReply } from "@/platform/sqlWorkerProtocol";

const provider = { serviceEpoch: 3n, id: 1n };
const connection = { serviceEpoch: 3n, id: 7n };

describe("SQL Worker structured-clone protocol", () => {
  it("decodes a typed execute command and response publication", () => {
    const command = decodeSqlWorkerCommand({
      id: 1,
      type: "execute",
      value: {
        request: {
          provider,
          operation: {
            kind: "execute",
            connection,
            mode: 0,
            sql: "CREATE TABLE t (value)",
            parameters: [],
          },
        },
        persistent: false,
      },
    });
    expect(command.type).toBe("execute");

    const revision = new Uint8Array(32);
    const reply = decodeSqlWorkerReply({
      id: 1,
      type: "executed",
      result: {
        response: encodeSqlResponse({
          provider,
          database: {
            connection,
            connected: true,
            transactionActive: false,
          },
          result: [
            0,
            [
              SQL_SQLITE_VERSION,
              new Map<number, unknown>(
                Object.values(SQL_LIMITS).map((value, index): [number, unknown] => [index, value]),
              ),
            ],
          ],
        }),
        publication: {
          token: 1,
          connection,
          expectedRevision: revision,
          revision,
          bytes: Uint8Array.of(1),
        },
      },
    });
    expect(reply.type).toBe("executed");
  });

  it("rejects malformed handles, byte fields and reply discriminants", () => {
    expect(() =>
      decodeSqlWorkerCommand({
        id: 1,
        type: "settle",
        value: { token: 0, accepted: true },
      }),
    ).toThrow("publication token");
    expect(() =>
      decodeSqlWorkerReply({ id: 1, type: "settled", result: { connected: true } }),
    ).toThrow("database flags");
    expect(() => decodeSqlWorkerReply({ id: 1, result: null })).toThrow("reply type");
  });

  it("validates seed databases with a bounded typed command", () => {
    expect(
      decodeSqlWorkerCommand({ id: 2, type: "validate", value: Uint8Array.of(1, 2, 3) }),
    ).toEqual({ id: 2, type: "validate", value: Uint8Array.of(1, 2, 3) });
    expect(decodeSqlWorkerReply({ id: 2, type: "validated", result: null })).toEqual({
      id: 2,
      type: "validated",
      result: null,
    });
    expect(() => decodeSqlWorkerCommand({ id: 2, type: "validate", value: "bad" })).toThrow(
      "seed database",
    );
  });

  it("allows a durable memory database to start without material but rejects partial material", () => {
    const request = {
      provider,
      operation: {
        kind: "open",
        connection,
        logicalName: "tr_db",
        identity: {
          source: { kind: "memory" },
          sqliteVersion: SQL_SQLITE_VERSION,
          formatVersion: 1,
        },
        revision: { kind: "current" },
      },
    };

    expect(
      decodeSqlWorkerCommand({
        id: 3,
        type: "execute",
        value: { request, persistent: true },
      }),
    ).toMatchObject({ type: "execute", value: { persistent: true } });
    expect(() =>
      decodeSqlWorkerCommand({
        id: 4,
        type: "execute",
        value: { request, persistent: true, initialBytes: Uint8Array.of(1) },
      }),
    ).toThrow("persistent SQL Worker database material");
  });
});
