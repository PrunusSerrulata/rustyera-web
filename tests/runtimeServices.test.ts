import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeImagePixelCache,
  handleRuntimeService,
  type RuntimeServiceContext,
} from "@/stores/runtimeServices";
import { emptyPresentation } from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  RuntimeServiceError,
  projectionMap,
  validateServiceRequest,
  type ProjectionQueryContext,
  type RuntimeServiceRequest,
} from "@/core/runtimeServiceProtocol";
import { RuntimeServiceRequests } from "@/stores/runtimeServiceRequests";
import { RuntimeViewportState } from "@/stores/runtimeViewport";
import {
  RuntimePointerObservation,
  registerPointerButton,
  pointerButtonValue,
  htmlPointerButtonValue,
} from "@/platform/pointerObservation";
import { decodeHtmlServiceQuery } from "@/core/htmlServiceProtocol";
import { encodeProjectionServicePayload } from "@/core/serviceCodec";
import { validateProjectionCbor } from "@/core/serviceCborValidation";
import type { FrontendBridge } from "@/core/types";
import type { HtmlImageMeasurementResult, HtmlMeasurementResult } from "@/core/htmlMeasurement";
import type { HtmlMeasurementBinding } from "@/platform/htmlMeasurement";

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

const projectionContext: ProjectionQueryContext = {
  presentationRevision: 0xffff_ffff_ffff_fffen,
  environmentRevision: 7,
  projectionSpaceRevision: 9,
};

function serviceRequest(
  operation = "pointer_state",
  payload = projectionMap(projectionContext),
  requestId: number | bigint = 1,
): RuntimeServiceRequest {
  return {
    request_id: requestId,
    kind: "input_state",
    operation,
    operation_version: { major: 1, minor: 0 },
    payload: encodeServicePayload(payload),
  };
}

function serviceHarness(requestId: number | bigint = 1) {
  const requests = new RuntimeServiceRequests();
  requests.enterEpoch(1);
  const send = vi.fn(async () => undefined);
  const context: RuntimeServiceContext = {
    lease: requests.begin(requestId, 1),
    bridge: { readImageMetadata: vi.fn(), readResource: vi.fn() },
    currentPresentation: emptyPresentation,
    heldKeys: new Set(),
    clock: () => undefined,
    nextEntropy: () => 1n,
    send,
    resourceGeneration: 1,
    imagePixels: new RuntimeImagePixelCache(),
    projection: {
      prepare: vi.fn(async () => emptyPresentation()),
      matches: () => true,
      pointer: () => ({ x: 13, y: -21, buttonValue: "canonical" }),
      canvas: vi.fn(async () => 0x12345678),
    },
  };
  return { requests, send, context };
}

// Numeric maps/enum arrays mirror minicbor's canonical model; they are not serde JSON.
function htmlServicePayload(text = "a😀"): Map<number, unknown> {
  const rgba = new Map([
    [0, 192],
    [1, 192],
    [2, 192],
    [3, 255],
  ]);
  const style = new Map<number, unknown>([
    [0, rgba],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
    [7, 18000],
  ]);
  const settings = new Map<number, unknown>([
    [0, 800000],
    [1, 20000],
    [2, rgba],
    [3, rgba],
    [4, 1000],
    [5, true],
    [6, false],
    [7, 600000],
  ]);
  const document = new Map<number, unknown>([
    [0, [[0, [text, 0, new TextEncoder().encode(text).length]]]],
  ]);
  const cuts = [
    new Map<number, unknown>([
      [0, 0],
      [1, [0]],
      [2, 0],
      [3, 0],
    ]),
    new Map<number, unknown>([
      [0, 1],
      [1, [0]],
      [2, new TextEncoder().encode(text).length],
      [3, text.length],
    ]),
  ];
  const probe = new Map<number, unknown>([
    [0, 7],
    [1, document],
    [2, 0],
    [3, cuts],
  ]);
  return new Map<number, unknown>([
    [0, projectionMap(projectionContext)],
    [
      1,
      new Map([
        [0, style],
        [1, style],
        [2, settings],
      ]),
    ],
    [2, [probe]],
  ]);
}

function htmlServiceRequest(
  payload = htmlServicePayload(),
  operation = "html_string_len",
): RuntimeServiceRequest {
  return {
    request_id: 1,
    kind: "presentation_query",
    operation,
    operation_version: { major: 2, minor: 0 },
    payload: encodeProjectionServicePayload(payload),
  };
}

function htmlServiceHarness() {
  const harness = serviceHarness();
  let current = true;
  const guard = {
    signal: harness.context.lease.signal,
    assertCurrent: () => {
      harness.context.lease.assertActive();
      if (!current) throw new RuntimeServiceError("stale_projection", "fixture projection changed");
    },
  };
  const binding: HtmlMeasurementBinding = {
    viewport: document.createElement("div"),
    context: projectionContext,
    resources: { canvases: [], sprites: [] },
    resourceGeneration: 1,
    preferences: { fontFamilyOverride: "", fontSizeOverridePx: null, imageScale: 1 },
    replaceFullWidthSpaces: false,
    resourceBridge: harness.context.bridge as FrontendBridge,
  };
  const measurement = {
    measure: vi.fn(async (): Promise<HtmlMeasurementResult> => ({
      context: projectionContext,
      advancePx: 10.125,
      cuts: [
        { id: 0, advancePx: 0 },
        { id: 1, advancePx: 10.125 },
      ],
      textNodes: [],
      firstRow: { advancePx: 10.125, heightPx: 18, fragments: [] },
    })),
    measureImageSlot: vi.fn(async (): Promise<HtmlImageMeasurementResult> => ({
      context: projectionContext,
      type: "loaded" as const,
      naturalWidth: 8,
      naturalHeight: 9,
    })),
    ensureFixedSlot: vi.fn(async () => ({ context: projectionContext, type: "ready" as const })),
  };
  harness.context.html = { prepare: vi.fn(async () => ({ binding, guard })), measurement };
  return {
    ...harness,
    measurement,
    binding,
    guard,
    retireProjection: () => {
      current = false;
    },
  };
}

function wasmServiceRequest(request: RuntimeServiceRequest): RuntimeServiceRequest {
  return {
    ...request,
    request_id: BigInt(request.request_id),
    operation_version: {
      major: BigInt(request.operation_version.major),
      minor: BigInt(request.operation_version.minor),
    },
    payload: Array.from(request.payload, BigInt),
  };
}

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

describe("projection runtime services", () => {
  it("accepts WASM bigint pointer versions and bytes without changing identities", async () => {
    const harness = serviceHarness();
    await handleRuntimeService(wasmServiceRequest(serviceRequest()), 42n, harness.context);
    const [response, correlation] = harness.send.mock.calls[0] as unknown as [any, bigint];
    expect(response.value.request_id).toBe(1n);
    expect(response.value.result.type).toBe("ready");
    expect(correlation).toBe(42n);
  });

  it.each([-1n, 65536n, 1.5, NaN, "1"])("rejects invalid service version %s", (major) => {
    const request = {
      ...serviceRequest(),
      operation_version: { major, minor: 0n },
    } as RuntimeServiceRequest;
    expect(() => validateServiceRequest(request)).toThrow("service operation version is invalid");
  });

  it.each([-1n, 256n, 1.5, NaN, "163"])("rejects invalid protocol byte %s", (byte) => {
    const request = { ...serviceRequest(), payload: [byte] } as RuntimeServiceRequest;
    expect(() => validateServiceRequest(request)).toThrow("service payload contains a non-byte");
  });

  it("preserves full-width request and correlation identities", async () => {
    const identity = 0xffff_ffff_ffff_fff0n;
    const harness = serviceHarness(identity);
    await handleRuntimeService(
      serviceRequest("pointer_state", projectionMap(projectionContext), identity),
      identity - 1n,
      harness.context,
    );
    expect((harness.send.mock.calls[0] as unknown as [any, bigint])[0].value.request_id).toBe(
      identity,
    );
    expect((harness.send.mock.calls[0] as unknown as [any, bigint])[1]).toBe(identity - 1n);
  });

  it("returns pointer values with exact u64 revisions and the request correlation", async () => {
    const { context, send } = serviceHarness();
    await handleRuntimeService(serviceRequest(), 42, context);
    expect(send).toHaveBeenCalledOnce();
    const [response, correlation] = send.mock.calls[0] as unknown as [any, number];
    expect(correlation).toBe(42);
    expect(response.value.request_id).toBe(1);
    expect(decodeServicePayload(response.value.result.payload)).toEqual(
      new Map<number, unknown>([
        [0, 13],
        [1, -21],
        [2, "canonical"],
        [3, projectionContext.presentationRevision],
        [4, 7],
        [5, 9],
      ]),
    );
  });

  it.each([
    [
      "unknown operation",
      (request: RuntimeServiceRequest) => {
        request.operation = "unknown";
      },
      "frontend.unsupported_service",
    ],
    [
      "future version",
      (request: RuntimeServiceRequest) => {
        request.operation_version.major = 2;
      },
      "frontend.unsupported_service",
    ],
    [
      "missing version",
      (request: RuntimeServiceRequest) => {
        delete (request as Partial<RuntimeServiceRequest>).operation_version;
      },
      "frontend.invalid_request",
    ],
    [
      "string revision",
      (request: RuntimeServiceRequest) => {
        request.payload = encodeServicePayload(
          new Map<number, unknown>([
            [0, "4"],
            [1, 7],
            [2, 9],
          ]),
        );
      },
      "frontend.invalid_request",
    ],
    [
      "missing field",
      (request: RuntimeServiceRequest) => {
        request.payload = encodeServicePayload(
          new Map([
            [0, 4],
            [1, 7],
          ]),
        );
      },
      "frontend.invalid_request",
    ],
    [
      "non-byte payload",
      (request: RuntimeServiceRequest) => {
        request.payload = [256];
      },
      "frontend.invalid_request",
    ],
  ] as const)("rejects %s without invoking its provider", async (_name, mutate, code) => {
    const { context, send } = serviceHarness();
    const request = serviceRequest();
    mutate(request);
    await handleRuntimeService(request, undefined, context);
    expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(code);
    expect(context.projection!.prepare).not.toHaveBeenCalled();
  });

  it.each(["stale_projection", "resource_limit", "backend_failure"] as const)(
    "preserves %s rather than reporting unsupported",
    async (category) => {
      const { context, send } = serviceHarness();
      context.projection!.prepare = async () => {
        throw new RuntimeServiceError(category, "query failed");
      };
      await handleRuntimeService(serviceRequest(), undefined, context);
      expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
        `frontend.${category}`,
      );
    },
  );

  it.each(["cancel", "epoch", "reset"])(
    "suppresses success and error after %s during asynchronous work",
    async (reason) => {
      for (const fails of [false, true]) {
        const { requests, context, send } = serviceHarness();
        const gate = deferred<void>();
        context.projection!.prepare = async () => {
          await gate.promise;
          if (fails) throw new Error("decode failed");
          return emptyPresentation();
        };
        const pending = handleRuntimeService(serviceRequest(), undefined, context);
        if (reason === "cancel") requests.cancel(1);
        else if (reason === "epoch") requests.enterEpoch(2);
        else requests.reset();
        gate.resolve();
        await pending;
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a duplicate ID once and retires the original work", async () => {
    const { requests, context, send } = serviceHarness();
    const gate = deferred<void>();
    context.projection!.prepare = async () => {
      await gate.promise;
      return emptyPresentation();
    };
    const original = handleRuntimeService(serviceRequest(), undefined, context);
    const duplicate = { ...context, lease: requests.begin(1, 1) };
    await handleRuntimeService(serviceRequest(), undefined, duplicate);
    gate.resolve();
    await original;
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
      "frontend.invalid_request",
    );
  });

  it("bounds active requests and makes reset a definite cancellation boundary", () => {
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    const leases = Array.from({ length: 32 }, (_, index) => requests.begin(index, 1));
    expect(() => requests.begin(32, 1)).toThrow("too many active");
    leases[0].finish();
    expect(requests.begin(32, 1).active()).toBe(true);
    requests.reset();
    expect(leases.every((lease) => !lease.active())).toBe(true);
    requests.enterEpoch(2);
    expect(requests.begin(0, 2).active()).toBe(true);
  });

  it.each([17, 0xffff_ffff_ffff_fffen])(
    "decodes canvas pixel maps without coercing identities or coordinates (%s)",
    async (canvasRevision) => {
      const { context, send } = serviceHarness();
      const payload = new Map<number, unknown>([
        [0, projectionMap(projectionContext)],
        [1, 4],
        [2, canvasRevision],
        [
          3,
          new Map([
            [0, 2],
            [1, 3],
          ]),
        ],
      ]);
      const request = { ...serviceRequest("sample_canvas_pixel", payload), kind: "canvas" };
      await handleRuntimeService(request, undefined, context);
      expect(context.projection!.canvas).toHaveBeenCalledWith(
        { context: projectionContext, canvasId: 4, canvasRevision, x: 2, y: 3 },
        expect.anything(),
        context.lease,
      );
      expect(
        decodeServicePayload((send.mock.calls[0] as unknown as [any])[0].value.result.payload),
      ).toEqual(
        new Map<number, unknown>([
          [0, projectionMap(projectionContext)],
          [1, canvasRevision],
          [2, 0x12345678],
        ]),
      );
      for (const coordinate of ["2", 1.5, 2147483648]) {
        const failed = serviceHarness();
        payload.set(
          3,
          new Map<number, unknown>([
            [0, coordinate],
            [1, 0],
          ]),
        );
        await handleRuntimeService(
          { ...request, payload: encodeServicePayload(payload) },
          undefined,
          failed.context,
        );
        expect(failed.context.projection!.canvas).not.toHaveBeenCalled();
        expect((failed.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
          "frontend.invalid_request",
        );
      }
    },
  );
});

describe("realized viewport identity", () => {
  it("reuses the confirmed environment after output publishes without hiding real changes", async () => {
    let message = 0;
    const send = vi.fn(async () => ++message);
    const viewport = new RuntimeViewportState(send);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    await viewport.observe(measurement, true, 8, "", "font-one");
    await viewport.observe({ ...measurement }, true, 9n, "", "font-one");
    expect(send).toHaveBeenCalledOnce();
    const expected = {
      presentationRevision: 9n,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    expect(viewport.matches(expected, 9n, measurement, "font-one")).toBe(true);
    await viewport.observe(measurement, true, 9n, "", "font-two");
    expect(send).toHaveBeenCalledTimes(2);
    expect(viewport.matches(expected, 9n, measurement, "font-two")).toBe(false);
    await viewport.observe(measurement, true, 9n, "typed", "font-two");
    expect(send).toHaveBeenCalledTimes(3);
    viewport.reject("3");
    await viewport.observe(measurement, true, 9n, "typed", "font-two");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("records only acknowledged observations and invalidates rejected or reset identities", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const expected = {
      presentationRevision: 9,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    const pending = viewport.observe(measurement, true, 8, "");
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
    gate.resolve(4);
    await pending;
    // New output can use the existing measured environment after Vue publishes that revision.
    expect(viewport.matches(expected, 9, measurement)).toBe(true);
    expect(viewport.matches(expected, 8, measurement)).toBe(false);
    expect(viewport.matches(expected, 9, { ...measurement, height: 201 })).toBe(false);
    for (const field of ["environmentRevision", "projectionSpaceRevision"] as const)
      expect(viewport.matches({ ...expected, [field]: 2 }, 9, measurement)).toBe(false);
    viewport.reject("4");
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
    viewport.reset();
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
  });
});

describe("late viewport acknowledgements", () => {
  it("cannot confirm an observation rejected before its submission acknowledgement", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const pending = viewport.observe(measurement, true, 1, "", "font-one");
    viewport.reject("4");
    gate.resolve(4);
    await pending;
    expect(
      viewport.matches(
        { presentationRevision: 1, environmentRevision: 1, projectionSpaceRevision: 1 },
        1,
        measurement,
        "font-one",
      ),
    ).toBe(false);
  });

  it("rejects changed font identity even when viewport dimensions and rounded column counts are unchanged", async () => {
    const viewport = new RuntimeViewportState(async () => 1);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    await viewport.observe(measurement, true, 1, "", "font-one");
    const expected = {
      presentationRevision: 2,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    expect(viewport.matches(expected, 2, measurement, "font-one")).toBe(true);
    expect(viewport.matches(expected, 2, measurement, "font-two")).toBe(false);
  });

  it("invalidates the confirmed environment while newer geometry or font observations are pending", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const send = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const viewport = new RuntimeViewportState(send);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const one = viewport.observe(measurement, true, 1, "");
    first.resolve(1);
    await one;
    const old = { presentationRevision: 2, environmentRevision: 1, projectionSpaceRevision: 1 };
    expect(viewport.matches(old, 2, measurement)).toBe(true);
    const two = viewport.observe({ ...measurement, lineColumns: 20 }, true, 2, "");
    expect(viewport.matches(old, 2, measurement)).toBe(false);
    const three = viewport.observe({ ...measurement, lineColumns: 25 }, true, 2, "");
    second.resolve(2);
    await two;
    expect(
      viewport.matches(
        { ...old, environmentRevision: 2, projectionSpaceRevision: 2 },
        2,
        measurement,
      ),
    ).toBe(false);
    third.resolve(3);
    await three;
    expect(
      viewport.matches(
        { ...old, environmentRevision: 3, projectionSpaceRevision: 3 },
        2,
        measurement,
      ),
    ).toBe(true);
  });

  it("does not republish observation identity after the session has been reset", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const pending = viewport.observe(measurement, true, 1, "");
    viewport.reset();
    gate.resolve(4);
    await pending;
    expect(
      viewport.matches(
        { presentationRevision: 1, environmentRevision: 1, projectionSpaceRevision: 1 },
        1,
        measurement,
      ),
    ).toBe(false);
    expect(viewport.pendingMessages.size).toBe(0);
  });
});

describe("pointer canonical button observation", () => {
  const originalHitTest = document.elementFromPoint;
  let pointer: RuntimePointerObservation | undefined;
  afterEach(() => {
    pointer?.stop();
    pointer = undefined;
    document.body.replaceChildren();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalHitTest,
    });
    vi.restoreAllMocks();
  });

  it("uses viewport coordinates and model values across scrolling, disabled input, resize and focus loss", () => {
    const viewport = document.createElement("main");
    const button = document.createElement("button");
    const child = document.createElement("span");
    child.textContent = "visible text is not the script value";
    button.disabled = true;
    button.append(child);
    viewport.append(button);
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 200 },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20 } as DOMRect);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let hit: Element = child;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hit),
    });
    const unregister = registerPointerButton(button, () => ({ epoch: 1, value: "42" }));
    pointer = new RuntimePointerObservation(() => viewport);
    pointer.start();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 50, buttons: 2 }));
    expect(pointer.sample(1)).toEqual({ x: 20, y: -170, buttonValue: "42" });
    expect(pointer.sample(2).buttonValue).toBe("");
    hit = viewport;
    viewport.dispatchEvent(new Event("scroll"));
    // Firefox may report the old hover location in a layout-driven pointerout.
    window.dispatchEvent(
      new MouseEvent("pointerout", { clientX: 199, clientY: 150, relatedTarget: viewport }),
    );
    expect(pointer.sample(1)).toEqual({ x: 20, y: -170, buttonValue: "" });
    hit = child;
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 250 });
    window.dispatchEvent(new Event("resize"));
    expect(pointer.sample(1).y).toBe(-220);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(
      new MouseEvent("pointerout", { clientX: 30, clientY: 50, relatedTarget: child }),
    );
    expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 50 }));
    window.dispatchEvent(new MouseEvent("pointerout", { relatedTarget: null }));
    expect(pointer.sample(1).buttonValue).toBe("");
    for (const type of ["pointermove", "pointerdown", "pointerup"]) {
      focus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new MouseEvent(type, { clientX: 199, clientY: 150 }));
      focus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      // An event delivered in the background cannot reappear when keyboard focus returns.
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      window.dispatchEvent(new MouseEvent(type, { clientX: 30, clientY: 50 }));
      expect(pointer.sample(1)).toEqual({ x: 20, y: -220, buttonValue: "42" });
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new MouseEvent(type, { clientX: 199, clientY: 150 }));
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      window.dispatchEvent(new MouseEvent(type, { clientX: 30, clientY: 50 }));
      expect(pointer.sample(1)).toEqual({ x: 20, y: -220, buttonValue: "42" });
    }
    unregister();
  });

  it("preserves integer and string values from the canonical run/HTML model", () => {
    expect(pointerButtonValue({ type: "integer", value: -9223372036854775808n })).toBe(
      "-9223372036854775808",
    );
    expect(pointerButtonValue({ type: "string", value: "001" })).toBe("001");
    expect(htmlPointerButtonValue({ integer_value: 42 })).toBe("42");
    expect(htmlPointerButtonValue({ string_value: "button text", integer_value: null })).toBe(
      "button text",
    );
    expect(pointerButtonValue({ type: "integer", value: "42" })).toBeUndefined();
  });
});
