import { describe, expect, it } from "vitest";

import {
  concatenateChunks,
  formatDiagnosisLogs,
  formatProjectProgress,
  saveSlotFileName,
  snapshotFileName,
} from "@/core/runtimeSupport";

describe("runtime support", () => {
  it("preserves project progress labels and clamps completed work", () => {
    expect(formatProjectProgress({ stage: "scanning", completed: 0, total: 0 })).toBe(
      "正在枚举项目文件…",
    );
    expect(formatProjectProgress({ stage: "compiling", completed: 12, total: 10 })).toBe(
      "正在编译脚本函数：10/10（100%）",
    );
    expect(formatProjectProgress({ stage: "packaging", completed: 1, total: 2 })).toBe(
      "正在打包全量项目文件：1/2（50%）",
    );
  });

  it("assembles transfer chunks in order", () => {
    expect(concatenateChunks([Uint8Array.of(1, 2), Uint8Array.of(3)], 3)).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it("keeps diagnosis and export names stable", () => {
    const timestamp = new Date(2026, 7, 1, 2, 3, 4);
    expect(formatDiagnosisLogs([{ timestamp, level: "warning", message: "example" }])).toBe(
      "[02:03:04] WARN  example\n",
    );
    expect(saveSlotFileName(3)).toBe("save03.sav");
    expect(snapshotFileName(timestamp)).toBe("runtime_20260801-020304.snapshot");
  });
});
