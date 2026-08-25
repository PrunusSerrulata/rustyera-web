import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceUrlRegistry, resourceUrl, resourceUrlRegistry } from "@/core/resources";

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

    const first = await resourceUrl(bridge as never, resourceId, 7, 1);
    const cached = await resourceUrl(bridge as never, resourceId, 7, 1);
    const reloaded = await resourceUrl(bridge as never, resourceId, 7, 2);

    expect(cached).toBe(first);
    expect(reloaded).not.toBe(first);
    expect(bridge.readResource).toHaveBeenCalledTimes(2);
  });

  it("releases settled Blob URLs from older project generations", async () => {
    const registry = new ResourceUrlRegistry();
    const createObjectURL = vi.fn(() => "blob:settled");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bridge = { readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)) };

    await registry.resourceUrl(bridge as never, "image.png", 0, 4);
    expect(registry.memoryCounters()).toEqual({ count: 1, bytes: 3 });

    registry.releaseBeforeGeneration(5);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:settled");
    expect(registry.memoryCounters()).toEqual({ count: 0, bytes: 0 });
  });

  it("revokes a pending Blob URL when its obsolete read eventually settles", async () => {
    const registry = new ResourceUrlRegistry();
    const resource = deferred<Uint8Array>();
    const createObjectURL = vi.fn(() => "blob:late");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const bridge = { readResource: vi.fn(() => resource.promise) };

    const url = registry.resourceUrl(bridge as never, "late.png", 0, 1);
    registry.releaseBeforeGeneration(2);
    resource.resolve(Uint8Array.of(4, 5));

    await expect(url).resolves.toBe("blob:late");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
    expect(registry.memoryCounters()).toEqual({ count: 0, bytes: 0 });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfilled) => {
    resolve = fulfilled;
  });
  return { promise, resolve };
}
