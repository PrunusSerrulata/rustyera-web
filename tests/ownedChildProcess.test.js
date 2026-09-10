import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { terminateOwnedChild, withOwnedChildCleanup } from "../scripts/owned-child-process.mjs";

describe("owned process cleanup", () => {
  it("terminates one Windows child tree by exact PID at most once", () => {
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const execute = vi.fn();
    terminateOwnedChild(child, "SIGTERM", { platform: "win32", execute });
    terminateOwnedChild(child, "SIGTERM", { platform: "win32", execute });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "taskkill.exe",
      ["/PID", "123", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
    terminateOwnedChild({ ...child, pid: 124, exitCode: 0 }, "SIGTERM", {
      platform: "win32",
      execute,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves the original failure and awaits every evidence finisher after close", async () => {
    const child = new EventEmitter();
    const failure = new Error("capture failed");
    const events = [];
    const stop = vi.fn(() => {
      events.push("stop");
      queueMicrotask(() => child.emit("close"));
    });
    const finish = vi.fn(async () => {
      events.push("finish");
    });
    await expect(
      withOwnedChildCleanup(
        child,
        async () => {
          throw failure;
        },
        [
          finish,
          async () => {
            throw new Error("archive failed");
          },
        ],
        stop,
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(["stop", "finish"]);
    expect(stop).toHaveBeenCalledOnce();
    expect(child.listenerCount("close")).toBe(0);
  });

  it("collects a normal exit after pipe closure", async () => {
    const child = new EventEmitter();
    const finish = vi.fn(async () => undefined);
    await expect(
      withOwnedChildCleanup(
        child,
        async () => 0,
        [finish],
        () => queueMicrotask(() => child.emit("close")),
      ),
    ).resolves.toBe(0);
    expect(finish).toHaveBeenCalledOnce();
  });
});
