import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeImagePixelCache } from "@/stores/runtimeServices";

describe("runtime image pixel cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("coalesces concurrent decoding and releases old-generation surfaces", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 2, height: 2, close })),
    );
    const surfaces: Array<{ width: number; height: number }> = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        context = {
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({ data: Uint8ClampedArray.of(1, 2, 3, 4) })),
        };
        constructor(
          public width: number,
          public height: number,
        ) {
          surfaces.push(this);
        }
        getContext() {
          return this.context;
        }
      },
    );
    const bridge = {
      readImageMetadata: vi.fn(async () => ({
        width: 2,
        height: 2,
        format: "png",
        animated: false,
      })),
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    };
    const cache = new RuntimeImagePixelCache(4);

    await Promise.all([
      cache.pixel(bridge, "image.png", 0, 0, 1),
      cache.pixel(bridge, "image.png", 1, 1, 1),
    ]);
    expect(bridge.readResource).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(cache.memoryCounters()).toEqual({
      count: 1,
      pixels: 4,
      estimatedBytes: 16,
      inflight: 0,
    });

    await cache.pixel(bridge, "image.png", 0, 0, 2);
    expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    expect(bridge.readResource).toHaveBeenCalledTimes(2);
    cache.clear();
    expect(surfaces[1]).toMatchObject({ width: 0, height: 0 });
    expect(cache.memoryCounters()).toEqual({ count: 0, pixels: 0, estimatedBytes: 0, inflight: 0 });
  });

  it("rejects oversized metadata before reading or decoding resource bytes", async () => {
    const bridge = {
      readImageMetadata: vi.fn(async () => ({
        width: 10,
        height: 10,
        format: "png",
        animated: false,
      })),
      readResource: vi.fn(),
    };
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(new RuntimeImagePixelCache(16).pixel(bridge, "huge.png", 0, 0, 1)).rejects.toThrow(
      "超过前端服务预算",
    );
    expect(bridge.readResource).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("retires an in-flight decoded surface when the generation is cleared", async () => {
    const bitmap = deferred<{ width: number; height: number; close(): void }>();
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => bitmap.promise),
    );
    const surfaces: Array<{ width: number; height: number }> = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        context = {
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({ data: Uint8ClampedArray.of(1, 2, 3, 4) })),
        };
        constructor(
          public width: number,
          public height: number,
        ) {
          surfaces.push(this);
        }
        getContext() {
          return this.context;
        }
      },
    );
    const bridge = {
      readImageMetadata: vi.fn(async () => ({
        width: 2,
        height: 2,
        format: "png",
        animated: false,
      })),
      readResource: vi.fn(async () => Uint8Array.of(1)),
    };
    const cache = new RuntimeImagePixelCache(4);
    const pending = cache.pixel(bridge, "late.png", 0, 0, 1);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());

    cache.clear();
    bitmap.resolve({ width: 2, height: 2, close });

    await expect(pending).rejects.toThrow("已过期");
    expect(close).toHaveBeenCalledOnce();
    expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    expect(cache.memoryCounters()).toEqual({ count: 0, pixels: 0, estimatedBytes: 0, inflight: 0 });
  });

  it("does not retain a failed decode and retries the resource", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode failed")));
    const bridge = {
      readImageMetadata: vi.fn(async () => ({
        width: 2,
        height: 2,
        format: "png",
        animated: false,
      })),
      readResource: vi.fn(async () => Uint8Array.of(1)),
    };
    const cache = new RuntimeImagePixelCache(4);

    await expect(cache.pixel(bridge, "broken.png", 0, 0, 1)).rejects.toThrow("decode failed");
    await expect(cache.pixel(bridge, "broken.png", 0, 0, 1)).rejects.toThrow("decode failed");

    expect(bridge.readResource).toHaveBeenCalledTimes(2);
    expect(cache.memoryCounters()).toEqual({ count: 0, pixels: 0, estimatedBytes: 0, inflight: 0 });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
