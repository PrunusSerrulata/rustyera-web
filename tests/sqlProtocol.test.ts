import { describe, expect, it } from "vitest";

import {
  SQL_LIMITS,
  bytesHex,
  checkedSqlI64,
  decodeSqlRequest,
  encodeSqlResponse,
  encodeSqlValue,
  sqlIdentityDigest,
  sqlIdentityPreimage,
  validateSqlResourceId,
} from "@/core/sqlProtocol";

const handle = (epoch: bigint, id: bigint) =>
  new Map<number, unknown>([
    [0, epoch],
    [1, id],
  ]);
const limits = () =>
  new Map<number, unknown>(
    Object.values(SQL_LIMITS).map((value, index): [number, unknown] => [index, value]),
  );

describe("SQL v1 protocol", () => {
  it("decodes the exact core integer-map and tagged-array Open schema", () => {
    const seedSha = Uint8Array.from({ length: 32 }, (_, index) => index);
    const request = decodeSqlRequest(
      new Map<number, unknown>([
        [0, handle(7n, 3n)],
        [
          1,
          [
            0,
            [
              handle(7n, 11n),
              "qol_data",
              new Map<number, unknown>([
                [
                  0,
                  [
                    1,
                    [
                      new Map<number, unknown>([
                        [0, "plugins/qol_data.db"],
                        [1, seedSha],
                      ]),
                    ],
                  ],
                ],
                [1, "3.53.0"],
                [2, 1],
              ]),
              [0, []],
              limits(),
            ],
          ],
        ],
      ]),
    );

    expect(request).toMatchObject({
      provider: { serviceEpoch: 7n, id: 3n },
      operation: {
        kind: "open",
        connection: { serviceEpoch: 7n, id: 11n },
        logicalName: "qol_data",
        identity: {
          source: { kind: "resource", resourceId: "plugins/qol_data.db" },
          sqliteVersion: "3.53.0",
          formatVersion: 1,
        },
        revision: { kind: "current" },
      },
    });
  });

  it("uses nested fields for every data-carrying enum", () => {
    const request = decodeSqlRequest(
      new Map<number, unknown>([
        [0, handle(7n, 3n)],
        [1, [3, [handle(7n, 5n), 2, 1]]],
      ]),
    );
    expect(request.operation).toEqual({
      kind: "reader_get",
      reader: { serviceEpoch: 7n, id: 5n },
      column: 2,
      mode: 1,
    });
    expect(encodeSqlValue(null)).toEqual([0, []]);
    expect(encodeSqlValue(42n)).toEqual([1, [42n]]);
    expect(encodeSqlValue("42")).toEqual([2, ["42"]]);
    expect(
      encodeSqlResponse({ provider: { serviceEpoch: 7n, id: 3n }, result: [7, []] }).get(3),
    ).toEqual([7, []]);
    const disconnected = encodeSqlResponse({
      provider: { serviceEpoch: 7n, id: 3n },
      database: {
        connection: { serviceEpoch: 7n, id: 11n },
        connected: false,
        transactionActive: false,
      },
      result: [9, []],
    });
    expect((disconnected.get(1) as Map<number, unknown>).get(1)).toBe(false);
  });

  it("pins the cross-client binary identity preimage and digest", () => {
    const seedSha = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(bytesHex(sqlIdentityPreimage("plugins/qol_data.db", seedSha))).toBe(
      "72757374796572612e73716c2e6964656e746974792e76310000000013706c7567696e732f716f6c5f646174612e6462000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f332e35332e300000000001",
    );
    expect(bytesHex(sqlIdentityDigest("plugins/qol_data.db", seedSha))).toBe(
      "905e8872fc8d0cba39021c4e999f13f59a190de5bee5db5f0402e686640b3713",
    );
  });

  it("shares one checked signed-i64 codec across parameters and results", () => {
    expect(checkedSqlI64(42, "value")).toBe(42n);
    expect(() => checkedSqlI64("42", "value")).toThrow("signed 64-bit");
    expect(checkedSqlI64(-(1n << 63n), "value")).toBe(-(1n << 63n));
    expect(checkedSqlI64((1n << 63n) - 1n, "value")).toBe((1n << 63n) - 1n);
    expect(() => checkedSqlI64(1n << 63n, "value")).toThrow("signed 64-bit");
    expect(() => checkedSqlI64(Number.MAX_SAFE_INTEGER + 1, "value")).toThrow("signed 64-bit");
  });

  it("requires canonical NFC portable Resource identities", () => {
    expect(() => validateSqlResourceId("plugins/qol_data.db")).not.toThrow();
    for (const path of ["../qol.db", "plugins//qol.db", "C:/qol.db", "plugins/e\u0301.db"])
      expect(() => validateSqlResourceId(path)).toThrow("invalid CBOR shape");
  });
});
