import { describe, expect, it, vi } from "vitest";

import { RuntimeLogState } from "@/stores/runtimeLogs";

describe("runtime log memory bounds", () => {
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
