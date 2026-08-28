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

  it.each(["response", "error"])(
    "delivers an early %s only to its registered request",
    async (kind) => {
      vi.useFakeTimers();
      const requests = new RuntimeDebugRequestState();
      const id = 9007199254740993n;
      let submitted!: (id: bigint) => void;
      const grant = { token: "current" };
      const pending = requests.submit(
        () =>
          new Promise<bigint>((resolve) => {
            submitted = resolve;
          }),
        (messageId) => requests.wait(messageId, grant, "read_variable", 10_000),
      );
      const observed =
        kind === "error"
          ? expect(pending).rejects.toThrow("actual native rejection")
          : expect(pending).resolves.toEqual({ value: 777 });
      const uncorrelated = vi.fn(async () => {});
      expect(requests.deferReply(id + 1n, uncorrelated)).toBe(true);
      expect(
        requests.deferReply(id, async () => {
          const request = requests.take(id);
          expect(request).toMatchObject({ grant, commandType: "read_variable" });
          if (kind === "error") request?.reject?.(new Error("actual native rejection"));
          else request?.resolve?.({ value: 777 });
        }),
      ).toBe(true);
      submitted(id);
      await observed;
      expect(uncorrelated).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retires unresolved submissions without waiting for the bridge or reusing their late IDs", async () => {
    vi.useFakeTimers();
    const requests = new RuntimeDebugRequestState();
    let submitted!: (id: number) => void;
    const oldRegister = vi.fn((id: number | bigint) => requests.wait(id, {}, "old", 10_000));
    const pending = requests.submit(
      () =>
        new Promise<number>((resolve) => {
          submitted = resolve;
        }),
      oldRegister,
    );
    const rejected = expect(pending).rejects.toThrow("retired");
    const oldReply = vi.fn(async () => {});
    expect(requests.deferReply(7, oldReply)).toBe(true);
    requests.reset();
    await rejected;
    const replacement = requests.wait(7, { token: "new" }, "new", 10_000);
    submitted(7);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldRegister).not.toHaveBeenCalled();
    expect(oldReply).not.toHaveBeenCalled();
    const current = requests.take(7);
    expect(current?.grant).toEqual({ token: "new" });
    current?.resolve?.("new reply");
    await expect(replacement).resolves.toBe("new reply");
    expect(requests.deferReply(7, oldReply)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
