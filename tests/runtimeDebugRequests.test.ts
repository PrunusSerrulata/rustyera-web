import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeDebugRequestState } from "@/stores/runtimeDebugRequests";

describe("runtime debug request retirement", () => {
  afterEach(() => vi.useRealTimers());

  it("clears timeout owners and rejects waiters when a timeline is retired", async () => {
    vi.useFakeTimers();
    const requests = new RuntimeDebugRequestState();
    const pending = requests.wait(1, {}, "variables", 30_000);

    requests.reset();

    await expect(pending).rejects.toThrow("retired");
    expect(vi.getTimerCount()).toBe(0);
  });
});
