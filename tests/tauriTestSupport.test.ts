import { describe, expect, it } from "vitest";

import { snapshotProgressSignature } from "../scripts/tauri-test-support.mjs";

describe("Tauri complete snapshot policy", () => {
  it("ignores timestamps and the elapsed-time-only loading suffix", () => {
    const first = {
      capturedAt: "2026-08-07T00:00:00Z",
      document: [{ text: "正在准备 Runtime 资源：661/661（100%） · 已等待 5 秒" }],
      runtime: {
        projectLoadProgressLabel: "正在准备 Runtime 资源：661/661（100%） · 已等待 5 秒",
        timestamp: "first",
      },
    };
    const second = {
      capturedAt: "2026-08-07T00:00:05Z",
      document: [{ text: "正在准备 Runtime 资源：661/661（100%） · 已等待 10 秒" }],
      runtime: {
        projectLoadProgressLabel: "正在准备 Runtime 资源：661/661（100%） · 已等待 10 秒",
        timestamp: "second",
      },
    };

    expect(snapshotProgressSignature(first)).toBe(snapshotProgressSignature(second));
  });
});
