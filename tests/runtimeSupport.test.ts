import { describe, expect, it } from "vitest";

import {
  concatenateChunks,
  formatDiagnostic,
  formatDiagnosisLogs,
  formatDiagnosisProgress,
  formatProjectProgress,
  saveSlotFileName,
  snapshotFileName,
} from "@/core/runtimeSupport";

describe("runtime support", () => {
  it("keeps unknown diagnostic positions distinct from the first line and column", () => {
    expect(
      formatDiagnostic({
        code: "runtime.warning",
        message: "position unavailable",
        source: { relative_path: "ERB/UNKNOWN.ERB" },
      }),
    ).toBe("ERB/UNKNOWN.ERB:?:?: [runtime.warning] position unavailable");
  });

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

  it("shows diagnosis byte progress as a percentage without reaching 100 early", () => {
    expect(formatDiagnosisProgress({ stage: "waiting", completed: 0, total: 0 })).toBe(
      "正在准备诊断信息…",
    );
    expect(formatDiagnosisProgress({ stage: "archive", completed: 999, total: 1_000 })).toBe(
      "正在写入诊断归档（99%）",
    );
    expect(formatDiagnosisProgress({ stage: "archive", completed: 1_000, total: 1_000 })).toBe(
      "正在写入诊断归档（100%）",
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
