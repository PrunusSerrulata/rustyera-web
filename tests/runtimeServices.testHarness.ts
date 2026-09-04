import { afterEach, describe, expect, it, vi } from "vitest";

import { Encoder } from "cbor-x";

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

import { decodeHtmlServiceDocument } from "@/core/htmlServiceDocument";

import { encodeProjectionServicePayload } from "@/core/serviceCodec";

import { validateProjectionCbor } from "@/core/serviceCborValidation";

import type { FrontendBridge } from "@/core/types";

import type { HtmlImageMeasurementResult, HtmlMeasurementResult } from "@/core/htmlMeasurement";

import type { HtmlMeasurementBinding } from "@/platform/htmlMeasurement";

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

const uncheckedServiceEncoder = new Encoder({
  mapsAsObjects: false,
  useRecords: false,
  variableMapSize: true,
  tagUint8Array: false,
});

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

function audioServiceRequest(expectedRevision = 7): RuntimeServiceRequest {
  return {
    request_id: 1,
    kind: "audio",
    operation: "audio_observation",
    operation_version: { major: 1, minor: 0 },
    payload: encodeServicePayload(
      new Map<number, unknown>([
        [0, [0, [3]]],
        [1, expectedRevision],
      ]),
    ),
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
    pumpDevices: vi.fn(async (_epoch, afterEventSequence) => afterEventSequence),
    clock: () => undefined,
    nextEntropy: () => 1n,
    send,
    resourceGeneration: 1,
    imagePixels: new RuntimeImagePixelCache(),
    projection: {
      prepare: vi.fn(async () => emptyPresentation()),
      prepareEnvironment: vi.fn(async () => emptyPresentation()),
      matches: () => true,
      matchesEnvironment: () => true,
      pointer: () => ({ x: 13, y: -21, buttonValue: "canonical" }),
      canvas: vi.fn(async () => 0x12345678),
      lineGeometry: vi.fn(async () => ({ top: -4, height: 18, viewportHeight: 600 })),
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
    viewportSize: { width: 300, height: 200 },
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

export {
  Encoder,
  RuntimeImagePixelCache,
  RuntimePointerObservation,
  RuntimeServiceError,
  RuntimeServiceRequests,
  RuntimeViewportState,
  afterEach,
  audioServiceRequest,
  decodeHtmlServiceDocument,
  decodeHtmlServiceQuery,
  decodeServicePayload,
  deferred,
  describe,
  emptyPresentation,
  encodeProjectionServicePayload,
  encodeServicePayload,
  expect,
  handleRuntimeService,
  htmlPointerButtonValue,
  htmlServiceHarness,
  htmlServicePayload,
  htmlServiceRequest,
  it,
  pointerButtonValue,
  projectionContext,
  projectionMap,
  registerPointerButton,
  serviceHarness,
  serviceRequest,
  uncheckedServiceEncoder,
  validateProjectionCbor,
  validateServiceRequest,
  vi,
  wasmServiceRequest,
};
export type {
  FrontendBridge,
  HtmlImageMeasurementResult,
  HtmlMeasurementBinding,
  HtmlMeasurementResult,
  ProjectionQueryContext,
  RuntimeServiceContext,
  RuntimeServiceRequest,
};
