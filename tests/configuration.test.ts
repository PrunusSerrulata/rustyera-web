import { describe, expect, it } from "vitest";

import {
  clientConfigurationEntries,
  parsePreparedConfiguration,
  parseProjectConfiguration,
  prepareConfigurationUpdate,
} from "@/core/configuration";

describe("project configuration protocol", () => {
  const snapshot = {
    project_revision: 7,
    source_digest: new Uint8Array(32).fill(3),
    entries: [
      {
        code: "フォントサイズ",
        japanese: "フォントサイズ",
        english: "FontSize",
        value: "18",
        kind: "integer",
        allowed: [],
        fixed: false,
        applicability: 12,
      },
      {
        code: "TAURI_ONLY",
        japanese: "",
        english: "TauriOnly",
        value: "TRUE",
        kind: "boolean",
        allowed: [],
        fixed: false,
        applicability: 8,
      },
    ],
  };

  it("parses snapshots and filters settings by client applicability", () => {
    const parsed = parseProjectConfiguration(snapshot);

    expect(clientConfigurationEntries(parsed, "browser")).toHaveLength(1);
    expect(clientConfigurationEntries(parsed, "tauri")).toHaveLength(2);
    expect(prepareConfigurationUpdate(parsed, [{ code: "フォントサイズ", value: "20" }])).toEqual({
      project_revision: 7,
      expected_source_digest: [...snapshot.source_digest],
      changes: [{ code: "フォントサイズ", value: "20" }],
    });
  });

  it("preserves lossless u64 project revisions", () => {
    const revision = 9_007_199_254_740_993n;

    expect(
      parseProjectConfiguration({ ...snapshot, project_revision: revision }).project_revision,
    ).toBe(revision);
  });

  it("accepts protocol byte arrays decoded as lossless integers", () => {
    const digest = new Array(32).fill(3n);

    expect(parseProjectConfiguration({ ...snapshot, source_digest: digest }).source_digest).toEqual(
      new Uint8Array(32).fill(3),
    );
  });

  it("normalizes protocol applicability flags decoded as lossless integers", () => {
    const parsed = parseProjectConfiguration({
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, applicability: 12n })),
    });

    expect(parsed.entries.every((entry) => entry.applicability === 12)).toBe(true);
  });

  it("rejects malformed prepared updates at the bridge boundary", () => {
    expect(() =>
      parsePreparedConfiguration({
        project_revision: 7,
        expected_source_digest: [1, 2],
        contents: "フォントサイズ:20\n",
        restart_required: true,
      }),
    ).toThrow("长度无效");
  });

  it.each([
    { ...snapshot, project_revision: "7" },
    { ...snapshot, project_revision: Number.NaN },
    { ...snapshot, project_revision: -1n },
    { ...snapshot, project_revision: 0x1_0000_0000_0000_0000n },
    { ...snapshot, source_digest: [1, -1, ...new Array(30).fill(0)] },
    { ...snapshot, source_digest: [1, 256, ...new Array(30).fill(0)] },
    { ...snapshot, source_digest: [1, 1.5, ...new Array(30).fill(0)] },
    {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], applicability: 0x1_0000_0000 }],
    },
    {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], applicability: -1n }],
    },
    {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], applicability: 0x1_0000_0000n }],
    },
  ])("rejects malformed snapshot numbers and bytes", (invalid) => {
    expect(() => parseProjectConfiguration(invalid)).toThrow();
  });
});
