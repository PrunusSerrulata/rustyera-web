import { flushPromises as flushVuePromises, mount as mountComponent } from "@vue/test-utils";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/runtime", () => ({
  useRuntimeStore: () => ({
    activate: vi.fn(),
    canInteract: true,
    interactionEnabled: () => true,
    replaceFullWidthSpaces: false,
    effectivePreferences: { fontFamilyOverride: null, fontSizeOverridePx: null, imageScale: 1 },
    gameTextStyle: { fontSizePx: 16 },
    gameLineHeightPx: 16,
    presentation: {
      settings: { line_height: 16_000 },
      resources: {
        sprites: [{ name: "portrait", size: [400, 600], frames: [] }],
        canvases: [],
      },
    },
  }),
}));

import DisplayLineImplementation from "@/components/DisplayLine.vue";

import HtmlNodeImplementation from "@/components/HtmlNode.vue";

import {
  htmlBoxRowLayoutsForRange as rowLayoutsForRange,
  positionedMediaRightBoundariesForRange as mediaRightBoundariesForRange,
  type HtmlBoxRowLayout,
} from "@/core/htmlBoxLayout";

import {
  projectMediaDimensions as mediaDimensions,
  projectPositionedMediaVerticalSpan as positionedMediaVerticalSpan,
} from "@/core/mediaProjection";

import type { DisplayLine } from "@/core/types";

function htmlLine(lineId: number, ...documents: any[][]): DisplayLine {
  return {
    line_id: lineId,
    temporary: false,
    logical_line_start: true,
    line_end: true,
    alignment: "left",
    runs: documents.map((nodes) => ({ type: "html_document", document: { nodes } })),
  } as DisplayLine;
}

function textLine(lineId: number, text: string): DisplayLine {
  return htmlLine(lineId, [{ type: "text", text }]);
}

function mixedTextLine(lineId: number, before: string, button: string, after: string): DisplayLine {
  return {
    line_id: lineId,
    temporary: false,
    logical_line_start: true,
    line_end: true,
    alignment: "left",
    runs: [
      { type: "html_document", document: { nodes: [{ type: "text", text: before }] } },
      { type: "button", runs: [{ type: "text", text: button }] },
      { type: "html_document", document: { nodes: [{ type: "text", text: after }] } },
    ],
  } as DisplayLine;
}

function mountLine(line: DisplayLine, boxRowLayout: HtmlBoxRowLayout) {
  return mount(DisplayLineComponent, {
    props: { line, boxRowLayout, viewportColumns: 132 },
  });
}

// These tests exercise canonical projection and async ownership with controlled DOM geometry.
// Real browser/font measurements remain a separate Browser/Tauri acceptance gate.
import {
  HtmlMeasurementScope as MeasurementScope,
  htmlMeasurementProjectionKey as measurementProjectionKey,
  type HtmlMeasurementBinding,
} from "@/components/htmlMeasurementProjection";

import {
  htmlMeasurementSegments as measurementSegments,
  htmlPrefixDocument as prefixDocument,
  htmlTextBoundaries as textBoundaries,
  inspectHtmlDocument as inspectDocument,
  validateHtmlCut as validateCut,
  type CanonicalHtmlDocument,
  type HtmlQueryStyle,
} from "@/core/htmlMeasurement";

import { RuntimeServiceError as ServiceError } from "@/core/runtimeServiceProtocol";

import type { FrontendBridge } from "@/core/types";

import { HtmlMeasurementProvider as MeasurementProvider } from "@/platform/htmlMeasurement";

import * as importedHtmlResourceUrls from "@/core/resources";

import * as importedPointerObservation from "@/platform/pointerObservation";

const DisplayLineComponent = DisplayLineImplementation;
const HtmlNode = HtmlNodeImplementation;
const flushPromises = flushVuePromises;
const mount = mountComponent;
const htmlResourceUrls = importedHtmlResourceUrls;
const pointerObservation = importedPointerObservation;
const htmlBoxRowLayoutsForRange = rowLayoutsForRange;
const positionedMediaRightBoundariesForRange = mediaRightBoundariesForRange;
const projectMediaDimensions = mediaDimensions;
const projectPositionedMediaVerticalSpan = positionedMediaVerticalSpan;
const HtmlMeasurementScope = MeasurementScope;
const htmlMeasurementProjectionKey = measurementProjectionKey;
const htmlMeasurementSegments = measurementSegments;
const htmlPrefixDocument = prefixDocument;
const htmlTextBoundaries = textBoundaries;
const inspectHtmlDocument = inspectDocument;
const validateHtmlCut = validateCut;
const RuntimeServiceError = ServiceError;
const HtmlMeasurementProvider = MeasurementProvider;

const queryStyle = (): HtmlQueryStyle => ({
  current: {
    foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
    bold: true,
    italic: true,
    underline: true,
    strikeout: true,
    font_millipixels: 24000,
  },
  base: {
    foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    font_millipixels: 16000,
    font_family: "FixtureFont",
  },
  settings: { line_height: 17000 },
});

const queryText = (text: string): CanonicalHtmlDocument => ({ nodes: [{ type: "text", text }] });

function measurementBinding(viewport: HTMLElement): HtmlMeasurementBinding {
  return {
    viewport,
    viewportSize: { width: viewport.clientWidth, height: viewport.clientHeight },
    context: { presentationRevision: 3, environmentRevision: 4, projectionSpaceRevision: 5 },
    resources: { sprites: [], canvases: [] },
    resourceGeneration: 8,
    preferences: { fontFamilyOverride: null, fontSizeOverridePx: null, imageScale: 1 },
    replaceFullWidthSpaces: false,
    resourceBridge: {
      readImageMetadata: vi.fn(),
      readResource: vi.fn(),
    } as unknown as FrontendBridge,
  };
}

export {
  DisplayLineComponent,
  HtmlMeasurementProvider,
  HtmlMeasurementScope,
  HtmlNode,
  RuntimeServiceError,
  afterEach,
  beforeEach,
  describe,
  expect,
  flushPromises,
  htmlBoxRowLayoutsForRange,
  htmlLine,
  htmlMeasurementProjectionKey,
  htmlMeasurementSegments,
  htmlPrefixDocument,
  htmlResourceUrls,
  htmlTextBoundaries,
  inspectHtmlDocument,
  it,
  measurementBinding,
  mixedTextLine,
  mount,
  mountLine,
  pointerObservation,
  positionedMediaRightBoundariesForRange,
  projectMediaDimensions,
  projectPositionedMediaVerticalSpan,
  queryStyle,
  queryText,
  textLine,
  validateHtmlCut,
  vi,
};
export type {
  CanonicalHtmlDocument,
  DisplayLine,
  FrontendBridge,
  HtmlBoxRowLayout,
  HtmlMeasurementBinding,
  HtmlQueryStyle,
};
