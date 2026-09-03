import { describe, expect, it, vi } from "vitest";

import { MAXIMUM_PENDING_LOG_NOTIFICATIONS, RuntimeLogState } from "@/stores/runtimeLogs";

describe("runtime log memory bounds", () => {
  it("retains diagnostics while bounding alert bursts before rendering", () => {
    const state = new RuntimeLogState(10_000);
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      timestamp: new Date(),
      level: "error" as const,
      message: `compiler.invalidhir ${index}`,
      authoritative: true,
    }));
    state.append(entries);
    expect(state.entries).toHaveLength(10_000);
    expect(state.notifications).toHaveLength(MAXIMUM_PENDING_LOG_NOTIFICATIONS);
    expect(state.notifications[0].message).toBe("compiler.invalidhir 9968");
    state.record("error", "new error");
    expect(state.notifications).toHaveLength(MAXIMUM_PENDING_LOG_NOTIFICATIONS);
    expect(state.notifications.at(-1)?.message).toBe("new error");
    state.dismiss(state.notifications[0].id);
    expect(state.notifications).toHaveLength(MAXIMUM_PENDING_LOG_NOTIFICATIONS - 1);
    expect(state.entries).toHaveLength(10_000);
  });

  it("selects the newest eligible alerts without losing per-entry notification policies", () => {
    const state = new RuntimeLogState(100);
    state.append(
      Array.from({ length: 100 }, (_, index) => ({
        timestamp: new Date(),
        level: "warning" as const,
        message: `warning ${index}`,
        authoritative: true,
      })),
      Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? "all" : "errors_only")),
    );
    expect(state.entries).toHaveLength(100);
    expect(state.notifications).toHaveLength(MAXIMUM_PENDING_LOG_NOTIFICATIONS);
    expect(state.notifications[0].message).toBe("warning 36");
    expect(state.notifications.at(-1)?.message).toBe("warning 98");
  });

  it("does not access messages discarded by the entry-count prefix bound", () => {
    const discardedMessage = vi.fn(() => "discarded");
    const entries = Array.from({ length: 4 }, (_, index) => {
      const entry = {
        timestamp: new Date(),
        level: "info" as const,
        authoritative: false,
        message: `retained-${index}`,
      };
      if (index < 2)
        Object.defineProperty(entry, "message", { get: discardedMessage, enumerable: true });
      return entry;
    });
    const state = new RuntimeLogState(2, 1024, 4096);

    state.append(entries);

    expect(discardedMessage).not.toHaveBeenCalled();
    expect(state.entries.map((entry) => entry.message)).toEqual(["retained-2", "retained-3"]);
  });

  it("truncates individual messages and evicts entries and notifications by retained bytes", () => {
    const state = new RuntimeLogState(100, 20, 32);

    state.record("warning", "a".repeat(100));
    state.record("error", "b".repeat(100));
    state.record("info", "c".repeat(100));

    expect(state.entries.every((entry) => entry.message.length <= 10)).toBe(true);
    expect(
      state.entries.reduce((sum, entry) => sum + entry.message.length * 2, 0),
    ).toBeLessThanOrEqual(32);
    expect(
      state.notifications.reduce((sum, entry) => sum + entry.message.length * 2, 0),
    ).toBeLessThanOrEqual(32);
  });
});
