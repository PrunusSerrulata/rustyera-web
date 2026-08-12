import { afterEach, describe, expect, it, vi } from "vitest";

import { resourceUrl } from "@/core/resources";

describe("resource URL cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not reuse a cached resource across project generations", async () => {
    const createObjectURL = vi.fn(() => `blob:${createObjectURL.mock.calls.length}`);
    vi.stubGlobal("URL", { createObjectURL });
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
});
