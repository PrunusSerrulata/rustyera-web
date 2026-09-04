import { createHash, webcrypto } from "node:crypto";
import {
  configureServiceLifecycle,
  nextServiceLifecycleProject,
  observeServiceDecode,
  serviceLifecycleImageCrossOrigin,
  serviceLifecycleResourceUrl,
  serviceLifecycleSnapshot,
} from "@/testing/serviceLifecycle";
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

describe("test-only real lifecycle resource stream boundary", () => {
  const bytes = new Uint8Array(34).fill(7);
  const gate = {
    resourceId: "resources/lifecycle-gate.png",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "http://127.0.0.1:19001/snake-lifecycle/" + "a".repeat(64) + ".png",
  };
  afterEach(() => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ projectPaths: [] });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("cannot configure stream or picker injection in a production build", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "0");
    expect(() => configureServiceLifecycle({ gate })).toThrow("test build");
    expect(nextServiceLifecycleProject("/fixture/default")).toBe("/fixture/default");
    expect(serviceLifecycleImageCrossOrigin(gate.resourceId, gate.url)).toBeUndefined();
    expect(await serviceLifecycleResourceUrl(gate.resourceId, bytes, 1)).toBeUndefined();
  });

  it("rejects arbitrary endpoints, resources and over-budget stream declarations", () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    for (const url of [
      "https://example.com/pixel.png",
      gate.url.replace("127.0.0.1", "localhost"),
      gate.url + "?path=/secret",
      gate.url.replace("http://", "http://user:password@"),
    ])
      expect(() => configureServiceLifecycle({ gate: { ...gate, url } })).toThrow("loopback");
    expect(() =>
      configureServiceLifecycle({ gate: { ...gate, resourceId: "secret.png" } }),
    ).toThrow("bounded fixture");
    expect(() =>
      configureServiceLifecycle({ gate: { ...gate, byteLength: 1024 * 1024 + 1 } }),
    ).toThrow("bounded fixture");
  });

  it("retains ordinary authorized reading and verifies unchanged source SHA before stream substitution", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    vi.stubGlobal("crypto", webcrypto);
    configureServiceLifecycle({ gate });
    expect(serviceLifecycleImageCrossOrigin(gate.resourceId, gate.url)).toBe("anonymous");
    expect(serviceLifecycleImageCrossOrigin(gate.resourceId, "blob:ordinary")).toBeUndefined();
    expect(serviceLifecycleImageCrossOrigin("resources/unrelated.png", gate.url)).toBeUndefined();
    const bridge = { readResource: vi.fn(async () => bytes) };
    const registry = new ResourceUrlRegistry();
    const lease = registry.acquire(bridge as never, gate.resourceId, 0, 4);
    expect(await lease.url).toBe(gate.url);
    expect(bridge.readResource).toHaveBeenCalledWith(gate.resourceId);
    expect(serviceLifecycleSnapshot()).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          phase: "resource_authorized",
          sha256: gate.sha256,
          byteLength: 34,
          resourceGeneration: 4,
        }),
      ]),
    });
    lease.release();
    expect(registry.memoryCounters().bytes).toBe(0);
    const denied = registry.acquire(
      {
        readResource: vi.fn(async () => {
          throw new Error("permission denied");
        }),
      } as never,
      gate.resourceId,
      0,
      5,
    );
    await expect(denied.url).rejects.toThrow("permission denied");
    denied.release();
    await expect(
      serviceLifecycleResourceUrl(gate.resourceId, new Uint8Array(34), 6),
    ).rejects.toThrow("SHA256 changed");
    await expect(
      serviceLifecycleResourceUrl(gate.resourceId, new Uint8Array(35), 6),
    ).rejects.toThrow("byte length changed");
  });

  it("returns copied phase records and consumes a configured independent picker once", () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ gate, projectPaths: ["/fixture/successor"] });
    const before = (serviceLifecycleSnapshot().records as unknown[]).length;
    observeServiceDecode({
      phase: "start",
      resourceId: gate.resourceId,
      resourceGeneration: 9,
      sourceUrl: gate.url,
    });
    observeServiceDecode({
      phase: "cancelled",
      resourceId: gate.resourceId,
      resourceGeneration: 9,
      sourceUrl: gate.url,
    });
    observeServiceDecode({
      phase: "settled",
      resourceId: gate.resourceId,
      resourceGeneration: 9,
      sourceUrl: gate.url,
      outcome: "resolved",
    });
    const snapshot = serviceLifecycleSnapshot().records as Array<{ phase: string }>;
    expect(snapshot.slice(before).map((row) => row.phase)).toEqual([
      "start",
      "cancelled",
      "settled",
    ]);
    snapshot[before].phase = "forged";
    expect((serviceLifecycleSnapshot().records as Array<{ phase: string }>)[before].phase).toBe(
      "start",
    );
    expect(nextServiceLifecycleProject("/fixture/original")).toBe("/fixture/successor");
    expect(nextServiceLifecycleProject("/fixture/original")).toBe("/fixture/original");
  });
});
