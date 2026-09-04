import {
  RuntimeCanvasPixelSampler,
  RuntimeServiceRequests,
  afterEach,
  beforeEach,
  blockImageStage,
  createCanvasReplayRenderer,
  describe,
  expect,
  it,
  pendingSpriteReplays,
  pixelContext,
  resourceBridge,
  resourceUrl,
  resourceUrlReleases,
  settleReplay,
  vi,
  waitFor,
} from "./canvasReplay.testHarness";
import type { CanvasPixelQuery, CanvasReplayData } from "./canvasReplay.testHarness";

describe("independent canvas pixel services", () => {
  const contexts: any[] = [];
  const query: CanvasPixelQuery = {
    context: { presentationRevision: 3, environmentRevision: 4, projectionSpaceRevision: 5 },
    canvasId: 7,
    canvasRevision: 8,
    x: 1,
    y: 1,
  };
  const replay = (): CanvasReplayData => ({
    canvas_id: 7,
    revision: 8,
    size: { width: 2, height: 2 },
    commands: [{ type: "set_pixel", point: { x: 1, y: 1 }, argb: 0x12345678 }],
  });
  const lease = () => {
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    return { requests, lease: requests.begin(1, 1) };
  };

  beforeEach(() => {
    contexts.length = 0;
    resourceUrl.mockReset().mockResolvedValue("blob:sample");
    resourceUrlReleases.length = 0;
    resourceBridge.readImageMetadata.mockReset().mockResolvedValue({ width: 2, height: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const context = pixelContext(this);
      contexts.push(context);
      return context as never;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replays an unmounted revision, returns ARGB and releases its independent backing surface", async () => {
    const sampler = new RuntimeCanvasPixelSampler();
    const { lease: request } = lease();
    expect(await sampler.sample(query, { canvases: [replay()] }, 1, request, () => true)).toBe(
      0x12345678,
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0].putImageData).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1,
        height: 1,
        data: Uint8ClampedArray.of(0x34, 0x56, 0x78, 0x12),
      }),
      1,
      1,
    );
    expect(contexts[0].canvas.isConnected).toBe(false);
    expect(contexts[0].getImageData).toHaveBeenCalledWith(1, 1, 1, 1);
    expect(contexts[0].canvas).toMatchObject({ width: 0, height: 0 });
  });

  it("rejects stale revisions, out-of-bounds pixels and excessive surfaces before allocation", async () => {
    for (const [changedQuery, canvas, category] of [
      [{ ...query, canvasRevision: 9 }, replay(), "stale_projection"],
      [{ ...query, x: 2 }, replay(), "invalid_request"],
      [query, { ...replay(), size: { width: 8193, height: 2 } }, "resource_limit"],
    ] as const) {
      await expect(
        new RuntimeCanvasPixelSampler().sample(
          changedQuery,
          { canvases: [canvas] },
          1,
          lease().lease,
          () => true,
        ),
      ).rejects.toMatchObject({ category });
    }
    expect(contexts).toHaveLength(0);
  });

  it("replaces semi-transparent pixels and clears transparent pixels without touching neighbors", async () => {
    // This is a deterministic Canvas API model, not evidence of browser premultiplication fidelity.
    const context = document.createElement("canvas").getContext("2d")!;
    const renderer = createCanvasReplayRenderer();
    const write = (argb: number, x = 0) => ({
      type: "set_pixel" as const,
      point: { x, y: 0 },
      argb,
    });
    const apply = (commands: NonNullable<CanvasReplayData["commands"]>) =>
      renderer.replay(context, { ...replay(), commands }, new Set([7]), {}, 1);
    await apply([write(0xff0000ff), write(0xff00ff00, 1)]);
    await apply([write(0x80ff0000)]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 128]);
    expect([...context.getImageData(1, 0, 1, 1).data]).toEqual([0, 255, 0, 255]);
    await apply([write(0)]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
    expect([...context.getImageData(1, 0, 1, 1).data]).toEqual([0, 255, 0, 255]);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.globalCompositeOperation).toBe("source-over");
    renderer.clear();
  });

  it.each(["metadata", "url", "bitmap", "image"] as const)(
    "cancel and resource changes release the logical queue while %s work is still pending",
    async (stage) => {
      for (const reason of ["cancel", "resource"] as const) {
        const blocked = blockImageStage(stage);
        const sampler = new RuntimeCanvasPixelSampler();
        const requests = new RuntimeServiceRequests();
        requests.enterEpoch(1);
        const oldContext = contexts.length;
        const pending = sampler.sample(
          query,
          {
            sprites: pendingSpriteReplays(),
            canvases: [{ ...replay(), commands: [blocked.command] }],
          },
          1,
          requests.begin(1, 1),
          () => true,
        );
        const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
        await waitFor(blocked.started);
        if (reason === "cancel") requests.cancel(1);
        else sampler.clear();
        // No decoder completion is allowed before these assertions: cancellation itself must settle.
        await rejected;
        expect(blocked.finished()).toBe(false);
        expect(contexts[oldContext].canvas).toMatchObject({ width: 0, height: 0 });
        expect(
          await sampler.sample(
            query,
            { canvases: [replay()] },
            2,
            requests.begin(2, 1),
            () => true,
          ),
        ).toBe(0x12345678);
        expect(contexts[oldContext].getImageData).not.toHaveBeenCalled();
        if (stage === "url" || stage === "image")
          expect(blocked.urlRelease()).not.toHaveBeenCalled();
        blocked.finish();
        await settleReplay();
        expect(blocked.finished()).toBe(true);
        expect(contexts[oldContext].getImageData).not.toHaveBeenCalled();
        expect(contexts[oldContext].drawImage).not.toHaveBeenCalled();
        if (stage === "bitmap") expect(blocked.close).toHaveBeenCalledOnce();
        if (stage === "url" || stage === "image")
          expect(blocked.urlRelease()).toHaveBeenCalledOnce();
        if (stage === "image") expect(blocked.cleared).toHaveBeenCalledOnce();
        sampler.clear();
        if (stage === "image") expect(blocked.cleared).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["bitmap", "image"] as const)(
    "late retired %s completion cannot clear a newer request's surface or renderer",
    async (stage) => {
      const old = blockImageStage(stage);
      const sampler = new RuntimeCanvasPixelSampler();
      const requests = new RuntimeServiceRequests();
      requests.enterEpoch(1);
      const pending = sampler.sample(
        query,
        { sprites: pendingSpriteReplays(), canvases: [{ ...replay(), commands: [old.command] }] },
        1,
        requests.begin(1, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(old.started);
      requests.cancel(1);
      await rejected;
      const newer = blockImageStage("bitmap");
      const following = sampler.sample(
        query,
        {
          sprites: pendingSpriteReplays(),
          canvases: [{ ...replay(), commands: [newer.command, ...replay().commands!] }],
        },
        2,
        requests.begin(2, 1),
        () => true,
      );
      await waitFor(newer.started);
      old.finish();
      await settleReplay();
      if (stage === "bitmap") expect(old.close).toHaveBeenCalledOnce();
      else {
        expect(old.cleared).toHaveBeenCalledOnce();
        expect(old.urlRelease()).toHaveBeenCalledOnce();
      }
      expect(contexts[1].canvas).toMatchObject({ width: 2, height: 2 });
      expect(newer.close).not.toHaveBeenCalled();
      newer.finish();
      await expect(following).resolves.toBe(0x12345678);
      expect(newer.close).toHaveBeenCalledOnce();
      expect(contexts[0].getImageData).not.toHaveBeenCalled();
      expect(contexts[1].getImageData).toHaveBeenCalledOnce();
    },
  );

  it.each(["url", "bitmap", "image"] as const)(
    "keeps pending %s pixels charged across generations until physical completion",
    async (stage) => {
      const blocked = blockImageStage(stage, 8192, 8191);
      const sampler = new RuntimeCanvasPixelSampler();
      const requests = new RuntimeServiceRequests();
      requests.enterEpoch(1);
      const pending = sampler.sample(
        query,
        {
          sprites: pendingSpriteReplays(),
          canvases: [{ ...replay(), commands: [blocked.command] }],
        },
        1,
        requests.begin(1, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(blocked.started);
      sampler.clear();
      await rejected;
      const large = { ...replay(), size: { width: 4096, height: 4096 } };
      await expect(
        sampler.sample(query, { canvases: [large] }, 2, requests.begin(2, 1), () => true),
      ).rejects.toMatchObject({ category: "resource_limit" });
      expect(
        await sampler.sample(query, { canvases: [replay()] }, 2, requests.begin(3, 1), () => true),
      ).toBe(0x12345678);
      blocked.finish();
      await settleReplay();
      await expect(
        sampler.sample(query, { canvases: [large] }, 3, requests.begin(4, 1), () => true),
      ).resolves.toBe(0x12345678);
    },
  );

  it("caps unfinished metadata operations across cancellation and generation changes", async () => {
    const sampler = new RuntimeCanvasPixelSampler();
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    const pendingMetadata: Array<ReturnType<typeof blockImageStage>> = [];
    for (let id = 1; id <= 32; id += 1) {
      const blocked = blockImageStage("metadata");
      pendingMetadata.push(blocked);
      const pending = sampler.sample(
        query,
        {
          sprites: pendingSpriteReplays(),
          canvases: [{ ...replay(), commands: [blocked.command] }],
        },
        id,
        requests.begin(id, 1),
        () => true,
      );
      const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
      await waitFor(blocked.started);
      sampler.clear();
      await rejected;
      requests.cancel(id);
    }
    const overflow = blockImageStage("metadata");
    await expect(
      sampler.sample(
        query,
        {
          sprites: pendingSpriteReplays(),
          canvases: [{ ...replay(), commands: [overflow.command] }],
        },
        33,
        requests.begin(33, 1),
        () => true,
      ),
    ).rejects.toMatchObject({ category: "resource_limit" });
    expect(overflow.started()).toBe(false);
    // Unknown image sizes charge decoder count without inventing a pixel estimate.
    await expect(
      sampler.sample(query, { canvases: [replay()] }, 33, requests.begin(34, 1), () => true),
    ).resolves.toBe(0x12345678);
    pendingMetadata.forEach((blocked) => blocked.finish());
    await settleReplay();
    const recovered = blockImageStage("metadata");
    const pending = sampler.sample(
      query,
      {
        sprites: pendingSpriteReplays(),
        canvases: [{ ...replay(), commands: [recovered.command] }],
      },
      34,
      requests.begin(35, 1),
      () => true,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(recovered.started);
    requests.cancel(35);
    await rejected;
    recovered.finish();
    await settleReplay();
  });

  it("bounds logical decoder waits but retains their pixels until late completion", async () => {
    vi.useFakeTimers();
    const blocked = blockImageStage("bitmap", 8192, 8191);
    const sampler = new RuntimeCanvasPixelSampler();
    const pending = sampler.sample(
      query,
      { sprites: pendingSpriteReplays(), canvases: [{ ...replay(), commands: [blocked.command] }] },
      1,
      lease().lease,
      () => true,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "backend_failure" });
    await waitFor(blocked.started);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(blocked.finished()).toBe(false);
    await expect(
      sampler.sample(
        query,
        { canvases: [{ ...replay(), size: { width: 4096, height: 4096 } }] },
        2,
        lease().lease,
        () => true,
      ),
    ).rejects.toMatchObject({ category: "resource_limit" });
    blocked.finish();
    await waitFor(() => blocked.close.mock.calls.length === 1);
    await expect(
      sampler.sample(query, { canvases: [replay()] }, 2, lease().lease, () => true),
    ).resolves.toBe(0x12345678);
  });

  it("rejects changed projections after asynchronous decoding without reading stale pixels", async () => {
    const blocked = blockImageStage("bitmap");
    let current = true;
    const sampler = new RuntimeCanvasPixelSampler();
    const pending = sampler.sample(
      query,
      { sprites: pendingSpriteReplays(), canvases: [{ ...replay(), commands: [blocked.command] }] },
      1,
      lease().lease,
      () => current,
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: "stale_projection" });
    await waitFor(blocked.started);
    current = false;
    blocked.finish();
    await rejected;
    expect(blocked.close).toHaveBeenCalledOnce();
    expect(contexts[0].getImageData).not.toHaveBeenCalled();
  });

  it("reports unavailable contexts as backend failure", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    await expect(
      new RuntimeCanvasPixelSampler().sample(
        query,
        { canvases: [replay()] },
        1,
        lease().lease,
        () => true,
      ),
    ).rejects.toMatchObject({ category: "backend_failure" });
  });
});
