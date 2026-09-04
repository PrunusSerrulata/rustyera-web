import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixtureRoot = resolve("tests/fixtures/snake-sql-project");

export const snakeSqlContract = JSON.parse(
  readFileSync(resolve(fixtureRoot, "contract.json"), "utf8"),
);

export function snakeSqlExpectedOutput(runCount, connectResult = runCount === 1 ? 0 : 1) {
  if (!Number.isSafeInteger(runCount) || runCount < 1)
    throw new TypeError("runCount must be a positive safe integer");
  if (connectResult !== 0 && connectResult !== 1)
    throw new TypeError("connectResult must be 0 or 1");
  return snakeSqlContract.outputTemplate.map((line) =>
    line
      .replaceAll("{runCount}", String(runCount))
      .replaceAll("{connectResult}", String(connectResult)),
  );
}

export function snakeSqlExpectedFollowupOutput(runCount) {
  if (!Number.isSafeInteger(runCount) || runCount < 1)
    throw new TypeError("runCount must be a positive safe integer");
  return snakeSqlContract.followupTemplate.map((line) =>
    line.replaceAll("{runCount}", String(runCount)),
  );
}

export function assertSnakeSqlContractOutput(output, runCount, connectResult) {
  assert.deepEqual(output, snakeSqlExpectedOutput(runCount, connectResult));
}

export function assertSnakeSqlContractFollowupOutput(output, runCount) {
  assert.deepEqual(output, [
    ...snakeSqlExpectedOutput(runCount),
    ...snakeSqlExpectedFollowupOutput(runCount),
  ]);
}

export function snakeSqlFixtureUrl(relativePath) {
  return resolve(fixtureRoot, relativePath);
}
