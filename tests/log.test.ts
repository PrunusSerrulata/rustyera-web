import { describe, expect, it } from "vitest";

import { formatLogEntry } from "@/core/log";

describe("TUI-compatible log formatting", () => {
  it("uses local HH:MM:SS timestamps and fixed-width severity labels", () => {
    const timestamp = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatLogEntry({ timestamp, level: "info", message: "ready" })).toBe(
      "[03:04:05] INFO  ready",
    );
    expect(formatLogEntry({ timestamp, level: "warning", message: "careful" })).toBe(
      "[03:04:05] WARN  careful",
    );
    expect(formatLogEntry({ timestamp, level: "error", message: "failed" })).toBe(
      "[03:04:05] ERROR failed",
    );
    expect(formatLogEntry({ timestamp, level: "debug", message: "trace" })).toBe(
      "[03:04:05] DEBUG trace",
    );
  });
});
