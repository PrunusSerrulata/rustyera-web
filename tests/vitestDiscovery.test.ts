// @vitest-environment node

import { matchesGlob } from "node:path";

import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("Vitest discovery", () => {
  it("excludes generated native specs without excluding committed unit tests", () => {
    const excluded = (file: string) =>
      config.test?.exclude?.some((pattern) => matchesGlob(file, pattern));

    expect(excluded(".rustyera/test-runs/example/about.spec.mjs")).toBe(true);
    expect(excluded("tests/tauri/about.spec.mjs")).toBe(true);
    expect(excluded("tests/aboutDialog.test.ts")).toBe(false);
    expect(excluded("tests/pagesWorkflow.test.js")).toBe(false);
  });
});
