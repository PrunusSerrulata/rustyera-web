import { describe, expect, it } from "vitest";

import { oldestOverflowCount } from "@/core/notificationLayout";

describe("notification viewport layout", () => {
  it("evicts the oldest notifications and retains the newest suffix that fits", () => {
    expect(oldestOverflowCount([40, 40, 40], 8, 98)).toBe(1);
  });

  it("does not evict notifications when the viewport grows", () => {
    expect(oldestOverflowCount([40], 8, 300)).toBe(0);
  });

  it("evicts the oldest notification when the stack exactly fills the viewport", () => {
    expect(oldestOverflowCount([30, 30], 8, 68)).toBe(1);
  });

  it("evicts every notification when none can fit", () => {
    expect(oldestOverflowCount([40, 40], 8, 30)).toBe(2);
  });
});
