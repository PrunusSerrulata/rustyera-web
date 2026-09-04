import {
  RuntimeImagePixelCache,
  RuntimeServiceError,
  afterEach,
  audioServiceRequest,
  decodeHtmlServiceDocument,
  decodeHtmlServiceQuery,
  decodeServicePayload,
  deferred,
  describe,
  encodeProjectionServicePayload,
  expect,
  handleRuntimeService,
  htmlServiceHarness,
  htmlServicePayload,
  htmlServiceRequest,
  it,
  projectionContext,
  projectionMap,
  serviceHarness,
  serviceRequest,
  validateProjectionCbor,
  vi,
  wasmServiceRequest,
} from "./runtimeServices.testHarness";
import type { HtmlMeasurementResult } from "./runtimeServices.testHarness";

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

describe("audio runtime service", () => {
  it("returns the provider's exact revision-bound observation payload", async () => {
    const harness = serviceHarness();
    const response = new Map<number, unknown>([
      [0, [0, [3]]],
      [1, 7],
      [2, 2_500],
      [3, 1_234],
      [4, 2],
      [5, 500_000],
      [6, 2_500_000],
      [7, false],
      [8, 999],
    ]);
    harness.context.audio = { observe: vi.fn(() => response) };

    await handleRuntimeService(audioServiceRequest(), 42, harness.context);

    expect(harness.context.audio.observe).toHaveBeenCalledWith(
      new Map<number, unknown>([
        [0, [0, [3]]],
        [1, 7],
      ]),
    );
    const [message, correlation] = harness.send.mock.calls[0] as unknown as [any, number];
    expect(correlation).toBe(42);
    expect(message.value.result.type).toBe("ready");
    expect(decodeServicePayload(message.value.result.payload)).toEqual(response);
  });

  it("returns unsupported when no real audio provider was installed", async () => {
    const harness = serviceHarness();

    await handleRuntimeService(audioServiceRequest(), undefined, harness.context);

    expect((harness.send.mock.calls[0] as any)[0].value.result).toMatchObject({
      type: "error",
      error: { code: "frontend.unsupported_service" },
    });
  });

  it("returns a structured stale response instead of encoding a stopped value", async () => {
    const harness = serviceHarness();
    harness.context.audio = {
      observe: vi.fn(() => {
        throw new RuntimeServiceError("stale_response", "audio revision changed");
      }),
    };

    await handleRuntimeService(audioServiceRequest(6), undefined, harness.context);

    expect((harness.send.mock.calls[0] as any)[0].value.result).toMatchObject({
      type: "error",
      error: {
        code: "frontend.stale_response",
        message: expect.stringContaining("audio revision changed"),
      },
    });
  });
});

describe("input runtime service adapter", () => {
  it("waits for the device event-loop pump and returns its exact watermark", async () => {
    const harness = serviceHarness();
    const pumped = deferred<number>();
    harness.context.pumpDevices = vi.fn(() => pumped.promise);
    const handling = handleRuntimeService(
      serviceRequest(
        "device_pump",
        new Map([
          [0, 2],
          [1, 7],
        ]),
      ),
      42,
      harness.context,
    );
    await Promise.resolve();

    expect(harness.context.pumpDevices).toHaveBeenCalledWith(2, 7);
    expect(harness.send).not.toHaveBeenCalled();

    pumped.resolve(9);
    await handling;
    const response = (harness.send.mock.calls[0] as unknown as [any])[0].value.result;
    expect(response.type).toBe("ready");
    expect(decodeServicePayload(response.payload)).toEqual(
      new Map([
        [0, 2],
        [1, 9],
      ]),
    );
  });
});

describe("HTML v2 runtime service adapter", () => {
  it.each(["html_string_len", "html_substring", "html_string_lines"])(
    "accepts WASM bigint versions and payload bytes for %s",
    async (operation) => {
      const harness = htmlServiceHarness();
      await handleRuntimeService(
        wasmServiceRequest(htmlServiceRequest(htmlServicePayload(), operation)),
        42n,
        harness.context,
      );
      expect(harness.measurement.measure).toHaveBeenCalledOnce();
      expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result.type).toBe("ready");
    },
  );

  it.each(["html_string_len", "html_substring", "html_string_lines"])(
    "routes %s to independent prefix measurement and returns minicbor enum arrays",
    async (operation) => {
      const harness = htmlServiceHarness();
      await handleRuntimeService(
        htmlServiceRequest(htmlServicePayload(), operation),
        42,
        harness.context,
      );
      expect(harness.measurement.measure).toHaveBeenCalledOnce();
      const probe = harness.measurement.measure.mock.calls[0] as unknown as [any];
      expect(probe[0].document.nodes[0]).toEqual({ type: "text", text: "a😀", start: 0, end: 5 });
      expect(probe[0].cuts[1]).toEqual({
        id: 1,
        textNodePath: [0],
        decodedUtf8Offset: 5,
        decodedUtf16Offset: 3,
      });
      const response = (harness.send.mock.calls[0] as unknown as [any])[0].value.result;
      expect(response.type).toBe("ready");
      expect(() => validateProjectionCbor(Uint8Array.from(response.payload))).not.toThrow();
      const decoded = decodeServicePayload(response.payload) as Map<number, any>;
      expect(decoded.get(0)).toEqual(projectionMap(projectionContext));
      expect(decoded.get(1)[0].get(1)).toEqual([
        0,
        [
          10125,
          [
            new Map([
              [0, 0],
              [1, 0],
            ]),
            new Map([
              [0, 1],
              [1, 10125],
            ]),
          ],
        ],
      ]);
    },
  );

  it("decodes omitted optional map fields and shortened optional enum fields", () => {
    const payload = htmlServicePayload("x");
    const probe = (payload.get(2) as Map<number, unknown>[])[0];
    const document = probe.get(1) as Map<number, unknown>;
    const child = (document.get(0) as unknown[])[0];
    document.set(0, [[1, [4, [], [child], null, 0, 1, [1, []]]]]);
    for (const cut of probe.get(3) as Map<number, unknown>[]) cut.set(1, [0, 0]);
    const decoded = decodeHtmlServiceQuery(payload);
    expect(decoded.style.base.background).toBeUndefined();
    expect(decoded.style.base.font_family).toBeUndefined();
    expect(decoded.probes[0].document.nodes[0]).toMatchObject({
      kind: "font",
      semantic: { type: "font", face: undefined },
    });
  });

  it("decodes protocol 45 font, positioned image and division intents exactly", () => {
    const payload = htmlServicePayload("x");
    const probe = (payload.get(2) as Map<number, unknown>[])[0];
    const document = probe.get(1) as Map<number, unknown>;
    const matrix = Array.from({ length: 25 }, (_, index) => (index % 6 === 0 ? 256 : 0));
    document.set(0, [
      [
        1,
        [
          4,
          [],
          [],
          null,
          0,
          1,
          [
            1,
            [
              null,
              0xff0000,
              null,
              12_500,
              1,
              new Map([
                [0, 1],
                [1, 2],
                [2, 3],
              ]),
            ],
          ],
        ],
      ],
      [
        1,
        [
          10,
          [],
          [],
          null,
          1,
          2,
          [7, ["face", null, null, [0, [6]], [0, [5]], [1, [4]], [0, [3]], 3, [1, [matrix]]]],
        ],
      ],
      [1, [12, [], [], null, 2, 3, [9, [null, null, [0, [80]], null, -2, null, 2, new Map()]]]],
    ]);
    const decoded = decodeHtmlServiceDocument(document).nodes as any[];
    expect(decoded[0].semantic).toEqual({
      type: "font",
      face: undefined,
      color: 0xff0000,
      button_color: undefined,
      size_millipixels: 12_500,
      vertical_alignment: "middle",
      render_intent: {
        renderer: "skia",
        edging: "subpixel_anti_alias",
        hinting: "full",
      },
    });
    expect(decoded[1].semantic).toMatchObject({
      type: "image",
      source: "face",
      x: { unit: "pixels", value: 3 },
      y: { unit: "font_height_hundredths", value: 4 },
      display: "absolute_left_bottom",
      color_matrix: { type: "fixed", value: matrix },
    });
    expect(decoded[2].semantic).toMatchObject({
      type: "division",
      width: { unit: "pixels", value: 80 },
      height: undefined,
      depth: -2,
      display: "absolute_left_top",
      relative: false,
    });
  });

  it.each([
    "surrogate",
    "utf8",
    "duplicate_cut",
    "duplicate_probe",
    "unknown_field",
    "mode",
    "extra_fallback",
    "missing_image_fallback",
    "unknown_semantic",
  ])("rejects %s before realizing a provider", async (failure) => {
    const payload = htmlServicePayload();
    const probe = (payload.get(2) as Map<number, unknown>[])[0];
    const cuts = probe.get(3) as Map<number, unknown>[];
    if (failure === "surrogate") {
      cuts[1].set(2, 2);
      cuts[1].set(3, 2);
    } else if (failure === "utf8") cuts[1].set(2, 2);
    else if (failure === "duplicate_cut") cuts[1].set(0, 0);
    else if (failure === "duplicate_probe") payload.set(2, [probe, probe]);
    else if (failure === "unknown_field") probe.set(9, 0);
    else if (failure === "mode") probe.set(2, 9);
    else if (failure === "extra_fallback") probe.set(4, probe.get(1));
    else if (failure === "missing_image_fallback") {
      probe.set(2, 1);
      probe.set(3, []);
    } else (probe.get(1) as Map<number, unknown>).set(0, [[1, [0, [], [], null, 0, 0, [99, []]]]]);
    const harness = htmlServiceHarness();
    await handleRuntimeService(htmlServiceRequest(payload), undefined, harness.context);
    expect(harness.context.html!.prepare).not.toHaveBeenCalled();
    expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
      "frontend.invalid_request",
    );
  });

  it.each(["loaded", "missing", "fixed"])(
    "encodes %s slots without replacing core layout with DOM widths",
    async (mode) => {
      const payload = htmlServicePayload("fallback");
      const probe = (payload.get(2) as Map<number, unknown>[])[0];
      const fallback = probe.get(1);
      probe.set(3, []);
      if (mode === "fixed") {
        probe.set(2, 2);
        probe.set(1, new Map([[0, [[1, [11, [], [], null, 0, 0, [8, ["space", [[0, [12]]]]]]]]]]));
      } else {
        probe.set(2, 1);
        probe.set(4, fallback);
        probe.set(1, new Map([[0, [[1, [10, [], [], null, 0, 0, [7, ["sprite"]]]]]]]));
      }
      const harness = htmlServiceHarness();
      if (mode === "missing")
        harness.measurement.measureImageSlot.mockResolvedValue({
          context: projectionContext,
          type: "missing",
          fallbackAdvancePx: 8.125,
        });
      await handleRuntimeService(htmlServiceRequest(payload), undefined, harness.context);
      const result = (harness.send.mock.calls[0] as unknown as [any])[0].value.result;
      expect(result.type).toBe("ready");
      const decoded = decodeServicePayload(result.payload) as Map<number, any>;
      expect(decoded.get(1)[0].get(1)).toEqual(
        mode === "fixed" ? [4, []] : mode === "missing" ? [3, [8125]] : [2, [8, 9]],
      );
      expect(harness.measurement.measure).not.toHaveBeenCalled();
      if (mode === "fixed") expect(harness.measurement.ensureFixedSlot).toHaveBeenCalledOnce();
      else expect(harness.measurement.measureImageSlot).toHaveBeenCalledOnce();
    },
  );

  it.each(["backend_failure", "resource_limit"] as const)(
    "keeps declared-image %s distinct from missing or unsupported",
    async (category) => {
      const payload = htmlServicePayload("fallback");
      const probe = (payload.get(2) as Map<number, unknown>[])[0];
      probe.set(4, probe.get(1));
      probe.set(2, 1);
      probe.set(3, []);
      probe.set(1, new Map([[0, [[1, [10, [], [], null, 0, 0, [7, ["declared"]]]]]]]));
      const harness = htmlServiceHarness();
      harness.measurement.measureImageSlot.mockRejectedValue(
        new RuntimeServiceError(category, "declared resource failed"),
      );
      await handleRuntimeService(htmlServiceRequest(payload), undefined, harness.context);
      expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result).toMatchObject({
        type: "error",
        error: {
          code: `frontend.${category}`,
          message: expect.stringContaining("declared resource failed"),
        },
      });
    },
  );

  it.each(["count", "duplicate", "unknown", "context"])(
    "rejects provider %s mismatches",
    async (failure) => {
      const harness = htmlServiceHarness();
      const measured: HtmlMeasurementResult = {
        context: projectionContext,
        advancePx: 10,
        cuts: [
          { id: 0, advancePx: 0 },
          { id: 1, advancePx: 10 },
        ],
        textNodes: [],
        firstRow: { advancePx: 10, heightPx: 18, fragments: [] },
      };
      if (failure === "count") measured.cuts.pop();
      else if (failure === "duplicate") measured.cuts[1].id = 0;
      else if (failure === "unknown") measured.cuts[1].id = 99;
      else measured.context = { ...projectionContext, environmentRevision: 8 };
      harness.measurement.measure.mockResolvedValue(measured);
      await handleRuntimeService(htmlServiceRequest(), undefined, harness.context);
      expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
        failure === "context" ? "frontend.stale_projection" : "frontend.backend_failure",
      );
    },
  );

  it("requires v2 only for the three HTML operations", async () => {
    const harness = htmlServiceHarness();
    const request = htmlServiceRequest();
    request.operation_version.major = 1;
    await handleRuntimeService(request, undefined, harness.context);
    expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
      "frontend.unsupported_service",
    );
    expect(harness.measurement.measure).not.toHaveBeenCalled();
  });

  it.each(["cancel", "epoch", "reset", "projection"])(
    "suppresses or rejects obsolete HTML results after %s",
    async (reason) => {
      const harness = htmlServiceHarness();
      const gate = deferred<void>();
      const measured = {
        context: projectionContext,
        advancePx: 10.125,
        cuts: [
          { id: 0, advancePx: 0 },
          { id: 1, advancePx: 10.125 },
        ],
        textNodes: [],
        firstRow: { advancePx: 10.125, heightPx: 18, fragments: [] },
      };
      harness.measurement.measure.mockImplementation(async () => {
        await gate.promise;
        return measured;
      });
      const pending = handleRuntimeService(htmlServiceRequest(), undefined, harness.context);
      await vi.waitFor(() => expect(harness.measurement.measure).toHaveBeenCalledOnce());
      if (reason === "cancel") harness.requests.cancel(1);
      else if (reason === "epoch") harness.requests.enterEpoch(2);
      else if (reason === "reset") harness.requests.reset();
      else harness.retireProjection();
      gate.resolve();
      await pending;
      if (reason === "projection")
        expect((harness.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
          "frontend.stale_projection",
        );
      else expect(harness.send).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -1, 2_000_000])(
    "does not serialize invalid provider width %s as zero",
    async (advancePx) => {
      const harness = htmlServiceHarness();
      harness.measurement.measure.mockResolvedValue({
        context: projectionContext,
        advancePx,
        cuts: [
          { id: 0, advancePx: 0 },
          { id: 1, advancePx },
        ],
        textNodes: [],
        firstRow: { advancePx, heightPx: 18, fragments: [] },
      });
      await handleRuntimeService(htmlServiceRequest(), undefined, harness.context);
      const result = (harness.send.mock.calls[0] as unknown as [any])[0].value.result;
      expect(result.type).toBe("error");
      expect(result.error.code).not.toBe("frontend.unsupported_service");
    },
  );
});

describe("strict projection CBOR", () => {
  it.each([
    [0xa3, 0, 1, 0, 2, 2, 3], // duplicate key before materialization
    [0xa1, 0, 0x18, 1], // nonminimal integer
    [0xa1, 0, 0x61, 0xff], // invalid UTF-8
    [0xbf, 0xff], // indefinite map
    [0xa0, 0], // trailing value
    [0xd8, 0x18, 0xa0], // forbidden tag
  ])("rejects malformed deterministic CBOR %j", (...bytes) => {
    expect(() => validateProjectionCbor(Uint8Array.from(bytes))).toThrow();
  });

  it("encodes all projection integer widths without float64 or nonminimal bigint", () => {
    const payload = new Map<number, unknown>([
      [0, 7n],
      [1, 4_294_967_296],
      [2, -4_294_967_297],
      [3, 0xffff_ffff_ffff_fffen],
    ]);
    const bytes = encodeProjectionServicePayload(payload);
    expect(() => validateProjectionCbor(bytes)).not.toThrow();
    const decoded = decodeServicePayload(bytes) as Map<number, number | bigint>;
    expect(BigInt(decoded.get(0)!)).toBe(7n);
    expect(BigInt(decoded.get(1)!)).toBe(4_294_967_296n);
    expect(BigInt(decoded.get(2)!)).toBe(-4_294_967_297n);
    expect(decoded.get(3)).toBe(0xffff_ffff_ffff_fffen);
  });
});
