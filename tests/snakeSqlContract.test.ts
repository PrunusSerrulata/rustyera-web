import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SQL_LIMITS, SQL_SQLITE_VERSION, SqlErrorCode } from "@/core/sqlProtocol";

import {
  snakeSqlContract,
  snakeSqlExpectedOutput,
  snakeSqlExpectedFollowupOutput,
  snakeSqlFixtureUrl,
} from "./snakeSqlContract.mjs";

describe("three-client SQL convergence fixture", () => {
  it("pins every behavioral input plus the provider identity", () => {
    expect(snakeSqlContract.schemaVersion).toBe(1);
    expect(snakeSqlContract.sqliteVersion).toBe(SQL_SQLITE_VERSION);
    expect(snakeSqlContract.limits).toEqual(SQL_LIMITS);
    expect(snakeSqlContract.errorCodes).toEqual({
      invalidSource: SqlErrorCode.InvalidSource,
      revisionConflict: SqlErrorCode.RevisionConflict,
      staleEpoch: SqlErrorCode.StaleEpoch,
      invalidTableName: SqlErrorCode.InvalidTableName,
    });
    expect(snakeSqlContract.referenceDifferences).toEqual({
      connectResult: { rustFirst: 0, rustCurrent: 1, snake: 1 },
      omittedVariadicParameter: { rust: "NULL", snake: "missing parameter error" },
    });
    expect(snakeSqlContract.files["plugins/qol_data.db"]).toBe(snakeSqlContract.seedSha256);
    for (const [relativePath, expected] of Object.entries(snakeSqlContract.files)) {
      const digest = createHash("sha256")
        .update(readFileSync(snakeSqlFixtureUrl(relativePath)))
        .digest("hex");
      expect(digest, relativePath).toBe(expected);
    }
  });

  it("derives every browser phase and the final goal from one output template", () => {
    const scenario = JSON.parse(
      readFileSync(resolve("tools/runtime-tester/scenarios/snake-sql.json"), "utf8"),
    );
    expect(scenario.actions[0].expect.output).toEqual(snakeSqlExpectedOutput(1));
    expect(scenario.actions[5].expect.output).toEqual(snakeSqlExpectedOutput(2));
    expect(scenario.actions[7].expect.output).toEqual([
      ...snakeSqlExpectedOutput(2),
      ...snakeSqlExpectedFollowupOutput(2),
    ]);
    expect(scenario.goal.output_contains).toEqual(scenario.actions[7].expect.output);
    expect(snakeSqlExpectedOutput(3, 0)[0]).toBe("SNAKE_SQL_CONNECT=0/1");
  });
});
