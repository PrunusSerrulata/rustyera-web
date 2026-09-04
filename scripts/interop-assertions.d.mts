import type { remote } from "webdriverio";

type InspectionBrowser = Pick<Awaited<ReturnType<typeof remote>>, "execute" | "waitUntil">;

export interface InteropValue {
  type: "integer" | "string";
  value: string;
}
export function validateExpectedValues(values: unknown): Record<string, InteropValue>;
export function typedValues(typed: unknown, watches: string[]): Record<string, InteropValue>;
export function assertProjectStorage(storage: unknown): void;
export function assertSuccessfulWrites(records: unknown[]): void;

export function nativeStorageCapture(
  text: string,
  project: string,
): {
  version: number;
  source: "native_storage_host";
  enabled: boolean;
  overflow: boolean;
  failure: null;
  records: Record<string, unknown>[];
};

export function inspectWebdriverTyped(
  browser: InspectionBrowser,
  watches: string[],
): Promise<Record<string, unknown>>;
