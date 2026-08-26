import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireResourceUrl, ResourceUrlRegistry, resourceUrlRegistry } from "@/core/resources";

describe("resource URL cache", () => {
  afterEach(() => {
    resourceUrlRegistry.clear();
    vi.unstubAllGlobals();
  });

  it("does not reuse a cached resource across project generations", async () => {
    const createObjectURL = vi.fn(() => `blob:${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bridge = {
      readResource: vi.fn(async () => new Uint8Array([1, 2, 3])),
    };
    const resourceId = "generation-test-image.png";

    const firstLease = acquireResourceUrl(bridge as never, resourceId, 7, 1);
    const cachedLease = acquireResourceUrl(bridge as never, resourceId, 7, 1);
    const reloadedLease = acquireResourceUrl(bridge as never, resourceId, 7, 2);
    const [first, cached, reloaded] = await Promise.all([
      firstLease.url,
      cachedLease.url,
      reloadedLease.url,
    ]);

    expect(cached).toBe(first);
    expect(reloaded).not.toBe(first);
    expect(bridge.readResource).toHaveBeenCalledTimes(2);
    firstLease.release();
    cachedLease.release();
    reloadedLease.release();
  });

  it("reuses one project resource across placement revisions", async () => {
    const createObjectURL = vi.fn(() => "blob:stable");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const bridge = { readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)) };

    const leases = Array.from({ length: 1_000 }, (_, revision) =>
      acquireResourceUrl(bridge as never, "animated.png", revision, 4),
    );
    const urls = await Promise.all(leases.map((lease) => lease.url));

    expect(new Set(urls)).toEqual(new Set(["blob:stable"]));
    expect(bridge.readResource).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    for (const lease of leases) lease.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stable");
  });

  it("releases settled Blob URLs from older project generations", async () => {
    const registry = new ResourceUrlRegistry();
    const createObjectURL = vi.fn(() => "blob:settled");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bridge = { readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)) };

    const lease = registry.acquire(bridge as never, "image.png", 0, 4);
    await lease.url;
    expect(registry.memoryCounters().active).toEqual({ count: 1, bytes: 3 });

    registry.releaseBeforeGeneration(5);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:settled");
    expect(registry.memoryCounters().active).toEqual({ count: 0, bytes: 0 });
    lease.release();
  });

  it("revokes a pending Blob URL when its obsolete read eventually settles", async () => {
    const registry = new ResourceUrlRegistry();
    const resource = deferred<Uint8Array>();
    const createObjectURL = vi.fn(() => "blob:late");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bridge = { readResource: vi.fn(() => resource.promise) };

    const lease = registry.acquire(bridge as never, "late.png", 0, 1);
    registry.releaseBeforeGeneration(2);
    resource.resolve(Uint8Array.of(4, 5));

    await expect(lease.url).resolves.toBe("blob:late");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
    expect(registry.memoryCounters().active).toEqual({ count: 0, bytes: 0 });
    lease.release();
  });

  it("drops a failed pending lease so a later acquire retries without retained counters", async () => {
    const registry = new ResourceUrlRegistry();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const bridge = {
      readResource: vi
        .fn<() => Promise<Uint8Array>>()
        .mockRejectedValueOnce(new Error("read failed")),
    };
    const first = registry.acquire(bridge as never, "broken.png", 1, 1);
    first.release();

    await expect(first.url).rejects.toThrow("read failed");
    expect(registry.memoryCounters()).toMatchObject({ count: 0, bytes: 0 });

    bridge.readResource.mockResolvedValueOnce(Uint8Array.of(1));
    const retry = registry.acquire(bridge as never, "broken.png", 2, 1);
    await retry.url;
    expect(bridge.readResource).toHaveBeenCalledTimes(2);
    retry.release();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfilled) => {
    resolve = fulfilled;
  });
  return { promise, resolve };
}
