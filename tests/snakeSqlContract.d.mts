export interface SnakeSqlContract {
  schemaVersion: number;
  sqliteVersion: string;
  seedSha256: string;
  limits: Record<string, number>;
  errorCodes: Record<string, number>;
  files: Record<string, string>;
  outputTemplate: string[];
  followupTemplate: string[];
  referenceDifferences: Record<string, Record<string, string | number>>;
}

export const snakeSqlContract: SnakeSqlContract;

export function snakeSqlExpectedOutput(runCount: number, connectResult?: 0 | 1): string[];

export function snakeSqlExpectedFollowupOutput(runCount: number): string[];

export function assertSnakeSqlContractOutput(
  output: string[],
  runCount: number,
  connectResult?: 0 | 1,
): void;

export function assertSnakeSqlContractFollowupOutput(output: string[], runCount: number): void;

export function snakeSqlFixtureUrl(relativePath: string): string;
