import { createApp, h, nextTick, toRaw, type App } from "vue";

import { CanvasReplayBudget } from "@/components/canvasReplayRenderer";
import HtmlMeasurementHost from "@/components/HtmlMeasurementHost.vue";
import {
  HtmlMeasurementScope,
  measurementViewportIdentity,
  type HtmlMeasurementBinding,
  type HtmlMeasurementGuard,
  type HtmlMeasurementResources,
} from "@/components/htmlMeasurementProjection";
import {
  HTML_MEASUREMENT_LIMITS,
  htmlMeasurementSegments,
  htmlNodeAt,
  htmlPrefixDocument,
  inspectHtmlDocument,
  type CanonicalHtmlDocument,
  type HtmlFirstRowMetrics,
  type HtmlMeasuredFragment,
  type HtmlMeasurementProbe,
  type HtmlMeasurementResult,
  type HtmlImageMeasurementProbe,
  type HtmlImageMeasurementResult,
  type HtmlFixedSlotProbe,
  type HtmlFixedSlotResult,
  type HtmlQueryStyle,
} from "@/core/htmlMeasurement";
import {
  projectPresentationLength,
  projectRectangleShape,
  projectSpaceShape,
} from "@/core/shapeProjection";
import {
  RuntimeServiceError,
  isBoundedUnsignedInteger,
  sameServiceInteger,
  serviceInteger,
} from "@/core/runtimeServiceProtocol";

export type {
  HtmlMeasurementBinding,
  HtmlMeasurementGuard,
} from "@/components/htmlMeasurementProjection";
export type {
  CanonicalHtmlDocument,
  CanonicalHtmlNode,
  HtmlMeasurementProbe,
  HtmlMeasurementResult,
  HtmlImageMeasurementProbe,
  HtmlImageMeasurementResult,
  HtmlFixedSlotProbe,
  HtmlFixedSlotResult,
} from "@/core/htmlMeasurement";

/** One bounded offscreen render at a time. No source HTML or script-visible result strings enter here. */
export class HtmlMeasurementProvider {
  private readonly budget = new CanvasReplayBudget();
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private generation = 0;
  private activeScope?: HtmlMeasurementScope;

  clear(): void {
    this.generation += 1;
    this.activeScope?.dispose();
  }

  async measure(
    probe: HtmlMeasurementProbe,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
  ): Promise<HtmlMeasurementResult> {
    validateProbe(probe, binding.replaceFullWidthSpaces);
    const document = cloneBounded(probe.document);
    const cuts = cloneBounded(probe.cuts);
    return this.schedule(
      probe.style,
      binding,
      guard,
      [document],
      async (style, frozen, current) => {
        let work = inspectHtmlDocument(document, frozen.replaceFullWidthSpaces).work;
        const documents = [document];
        for (const cut of cuts) {
          current.assertCurrent();
          const prefix = htmlPrefixDocument(document, cut);
          work += inspectHtmlDocument(prefix, frozen.replaceFullWidthSpaces).work;
          if (work > HTML_MEASUREMENT_LIMITS.work)
            throw new RuntimeServiceError(
              "resource_limit",
              "HTML prefix work exceeds the per-probe budget",
            );
          documents.push(prefix);
        }
        // Shape each prefix independently, but read every width from one settled DOM layout.
        // Mounting/unmounting between cuts can mix fallback-font epochs in native browsers.
        const measured = await this.render(documents, style, frozen, current, "part");
        current.assertCurrent();
        return {
          ...measured[0],
          cuts: cuts.map((cut, index) => ({
            id: cut.id,
            advancePx: measured[index + 1].advancePx,
          })),
        };
      },
    );
  }

  async measureImageSlot(
    probe: HtmlImageMeasurementProbe,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
  ): Promise<HtmlImageMeasurementResult> {
    inspectHtmlDocument(probe.document, binding.replaceFullWidthSpaces);
    const image = singleSlot(probe.document, "image");
    if (image.semantic.type !== "image")
      throw new RuntimeServiceError("invalid_request", "HTML image slot is invalid");
    const name = image.semantic.source;
    validateProbe(
      { document: probe.missingDocument, mode: "text_part", cuts: [], style: probe.style },
      binding.replaceFullWidthSpaces,
    );
    const document = cloneBounded(probe.document);
    const missing = cloneBounded(probe.missingDocument);
    return this.schedule<HtmlImageMeasurementResult>(
      probe.style,
      binding,
      guard,
      [document, missing],
      async (style, frozen, current) => {
        const sprite = frozen.resources.sprites?.find(
          (item) => item.name.toUpperCase() === name.toUpperCase(),
        );
        if (!sprite) {
          const fallback = await this.render(missing, style, frozen, current, "part");
          current.assertCurrent();
          return {
            context: { ...frozen.context },
            type: "missing",
            fallbackAdvancePx: fallback.advancePx,
          };
        }
        const [naturalWidth, naturalHeight] = spriteDimensions(sprite);
        await this.render(document, style, frozen, current, "ready");
        current.assertCurrent();
        return { context: { ...frozen.context }, type: "loaded", naturalWidth, naturalHeight };
      },
    );
  }

  /** Core computes shape/div slot widths. The renderer only confirms readiness and errors. */
  async ensureFixedSlot(
    probe: HtmlFixedSlotProbe,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
  ): Promise<HtmlFixedSlotResult> {
    inspectHtmlDocument(probe.document, binding.replaceFullWidthSpaces);
    singleSlot(probe.document, "fixed");
    const document = cloneBounded(probe.document);
    return this.schedule<HtmlFixedSlotResult>(
      probe.style,
      binding,
      guard,
      [document],
      async (style, frozen, current) => {
        await this.render(document, style, frozen, current, "ready");
        current.assertCurrent();
        return { context: { ...frozen.context }, type: "ready" };
      },
    );
  }

  /** Actual DOM row diagnostics; reference wrapping, grouping and result policy stay in core. */
  async measureDocument(
    document: CanonicalHtmlDocument,
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
  ): Promise<HtmlMeasurementResult> {
    inspectHtmlDocument(document, binding.replaceFullWidthSpaces);
    const frozenDocument = cloneBounded(document);
    return this.schedule(style, binding, guard, [frozenDocument], (frozenStyle, frozen, current) =>
      this.render(frozenDocument, frozenStyle, frozen, current, "document"),
    );
  }

  private async schedule<T>(
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
    documents: readonly CanonicalHtmlDocument[],
    run: (
      style: HtmlQueryStyle,
      binding: HtmlMeasurementBinding,
      guard: HtmlMeasurementGuard,
    ) => Promise<T>,
  ): Promise<T> {
    guard.assertCurrent();
    if (guard.signal.aborted)
      throw new RuntimeServiceError("stale_projection", "HTML request was cancelled");
    if (this.queued >= 8)
      throw new RuntimeServiceError("resource_limit", "too many queued HTML measurements");
    validateBinding(binding, style);
    const frozenStyle = cloneBounded(style);
    const frozenBinding = {
      ...binding,
      context: { ...binding.context },
      preferences: { ...binding.preferences },
      resources: cloneResources(binding.resources, documents),
    };
    const generation = this.generation;
    const viewportIdentity = measurementViewportIdentity(binding.viewport);
    const current: HtmlMeasurementGuard = {
      signal: guard.signal,
      assertCurrent: () => {
        guard.assertCurrent();
        if (
          generation !== this.generation ||
          guard.signal.aborted ||
          measurementViewportIdentity(binding.viewport) !== viewportIdentity
        )
          throw new RuntimeServiceError("stale_projection", "HTML provider generation changed");
      },
    };
    this.queued += 1;
    const pending = this.tail
      .then(async () => {
        current.assertCurrent();
        const result = await run(frozenStyle, frozenBinding, current);
        current.assertCurrent();
        return result;
      })
      .catch((error: unknown) => {
        throw measurementError(error);
      });
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      const result = await pending;
      current.assertCurrent();
      return result;
    } finally {
      this.queued -= 1;
    }
  }

  private render(
    documents: CanonicalHtmlDocument[],
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
    mode: "part",
  ): Promise<HtmlMeasurementResult[]>;
  private render(
    document: CanonicalHtmlDocument,
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
    mode: "ready",
  ): Promise<void>;
  private render(
    document: CanonicalHtmlDocument,
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
    mode: "part" | "document",
  ): Promise<HtmlMeasurementResult>;
  private async render(
    document: CanonicalHtmlDocument | CanonicalHtmlDocument[],
    style: HtmlQueryStyle,
    binding: HtmlMeasurementBinding,
    guard: HtmlMeasurementGuard,
    mode: "part" | "document" | "ready",
  ): Promise<HtmlMeasurementResult | HtmlMeasurementResult[] | void> {
    guard.assertCurrent();
    validateBinding(binding, style);
    const documents = Array.isArray(document) ? document : [document];
    const inspected = documents.map((part) => {
      const result = inspectHtmlDocument(part, binding.replaceFullWidthSpaces);
      validateMedia(part, binding.resources);
      validateSlots(
        part,
        binding.preferences.fontSizeOverridePx ?? style.base.font_millipixels / 1000,
      );
      return result;
    });
    const scope = new HtmlMeasurementScope(binding, style, guard, this.budget.fork());
    this.activeScope = scope;
    let app: App<Element> | undefined;
    let host: HTMLDivElement | undefined;
    try {
      scope.assertCurrent();
      host = window.document.createElement("div");
      host.className = "html-measurement-host";
      host.setAttribute("aria-hidden", "true");
      host.inert = true;
      const viewportStyle = getComputedStyle(binding.viewport);
      Object.assign(host.style, {
        position: "fixed",
        left: "-100000px",
        top: "0px",
        width: `${binding.viewport.clientWidth}px`,
        maxWidth: "none",
        height: "auto",
        visibility: "hidden",
        pointerEvents: "none",
        overflow: "hidden",
        contain: "layout style paint",
        zIndex: "-1",
        margin: "0",
        padding: "0",
        border: "0",
        fontFamily:
          binding.preferences.fontFamilyOverride ||
          style.base.font_family ||
          viewportStyle.fontFamily,
        fontSize: `${scope.state.gameTextStyle.fontSizePx}px`,
        lineHeight: `${scope.state.gameLineHeightPx}px`,
        fontWeight: style.base.bold ? "bold" : "normal",
        fontStyle: style.base.italic ? "italic" : "normal",
        textDecoration: "none",
        letterSpacing: viewportStyle.letterSpacing,
      });
      host.style.setProperty("--game-font", host.style.fontFamily);
      host.style.setProperty("--game-size", host.style.fontSize);
      host.style.setProperty("--game-line-height", `${scope.state.gameLineHeightPx}px`);
      binding.viewport.append(host);
      app = createApp({
        render: () =>
          h(
            "div",
            documents.map((part) =>
              h(HtmlMeasurementHost, {
                document: part,
                style,
                projection: scope,
                documentMode: mode === "document",
              }),
            ),
          ),
      });
      const renderErrors: unknown[] = [];
      app.config.errorHandler = (error: unknown) => {
        renderErrors.push(error);
      };
      app.mount(host);
      await scope.wait(nextTick(), "vue-flush");
      if (renderErrors.length) throw renderErrors[0];
      if (host.querySelectorAll("*").length > HTML_MEASUREMENT_LIMITS.domNodes)
        throw new RuntimeServiceError(
          "resource_limit",
          "rendered HTML DOM exceeds the node budget",
        );
      await scope.settle();
      scope.assertCurrent();
      await scope.wait(nextTick(), "vue-flush");
      await loadFonts(host, scope);
      scope.assertCurrent();
      await scope.settle();
      await scope.wait(nextTick(), "vue-flush");
      if (renderErrors.length) throw renderErrors[0];
      const lines = host.querySelectorAll<HTMLElement>("[data-html-measurement-line]");
      if (lines.length !== documents.length)
        throw new RuntimeServiceError(
          "backend_failure",
          "HTML measurement renderer did not mount its line",
        );
      if (mode === "ready") {
        scope.assertCurrent();
        return;
      }
      // Geometry reads flush layout without a paint tick, which an occluded WebView can suspend.
      // No await between these reads: all independent text shapes share one font/layout epoch.
      const results = [...lines].map((line, index) => {
        const width = finitePixels(line.getBoundingClientRect().width);
        const firstRow = readFirstRow(
          line,
          documents[index],
          binding.replaceFullWidthSpaces,
          scope.state.gameLineHeightPx,
        );
        return {
          context: { ...binding.context },
          advancePx: mode === "document" ? firstRow.advancePx : width,
          cuts: [],
          textNodes: inspected[index].textNodes,
          firstRow,
        };
      });
      scope.assertCurrent();
      return Array.isArray(document) ? results : results[0];
    } finally {
      scope.dispose();
      try {
        app?.unmount();
      } finally {
        host?.remove();
        if (this.activeScope === scope) this.activeScope = undefined;
      }
    }
  }
}

function validateProbe(probe: HtmlMeasurementProbe, replaceSpaces: boolean): void {
  if (!probe || probe.mode !== "text_part" || !Array.isArray(probe.cuts))
    throw new RuntimeServiceError("invalid_request", "HTML probe mode or cuts are invalid");
  const inspected = inspectHtmlDocument(probe.document, replaceSpaces);
  if (probe.cuts.length > HTML_MEASUREMENT_LIMITS.cuts)
    throw new RuntimeServiceError("resource_limit", "HTML cut count exceeds the probe budget");
  if (probe.mode === "text_part") {
    const nonempty = inspected.textNodes.filter((entry) => entry.boundaries.length > 1);
    if (nonempty.length > 1 || inspected.media > 0)
      throw new RuntimeServiceError(
        "invalid_request",
        "a text-part probe must contain at most one nonempty text node and no media",
      );
    const visit = (nodes: CanonicalHtmlDocument["nodes"]) => {
      for (const node of nodes)
        if (node.type === "element") {
          if (!["bold", "italic", "underline", "strike", "font", "no_break"].includes(node.kind))
            throw new RuntimeServiceError(
              "invalid_request",
              "a text-part probe contains a layout atom",
            );
          visit(node.children);
        }
    };
    visit(probe.document.nodes);
  }
  const ids = new Set<number>();
  const boundaries = new Map(
    inspected.textNodes.map((entry) => [
      entry.path.join("."),
      new Map(entry.boundaries.map((boundary) => [boundary.utf16, boundary.utf8])),
    ]),
  );
  for (const cut of probe.cuts) {
    if (!Number.isInteger(cut.id) || cut.id < 0 || cut.id > 0xffffffff)
      throw new RuntimeServiceError("invalid_request", "HTML cut ID is invalid");
    if (
      !Number.isSafeInteger(cut.decodedUtf8Offset) ||
      cut.decodedUtf8Offset < 0 ||
      !Number.isSafeInteger(cut.decodedUtf16Offset) ||
      cut.decodedUtf16Offset < 0
    )
      throw new RuntimeServiceError("invalid_request", "HTML cut offsets are invalid");
    const node = htmlNodeAt(probe.document, cut.textNodePath);
    if (
      node.type !== "text" ||
      boundaries.get(cut.textNodePath.join("."))?.get(cut.decodedUtf16Offset) !==
        cut.decodedUtf8Offset
    )
      throw new RuntimeServiceError(
        "invalid_request",
        "HTML UTF-8/UTF-16 cut is not one matching scalar boundary",
      );
    if (ids.has(cut.id)) throw new RuntimeServiceError("invalid_request", "duplicate HTML cut ID");
    ids.add(cut.id);
  }
}

function singleSlot(
  document: CanonicalHtmlDocument,
  expected: "image" | "fixed",
): Extract<CanonicalHtmlDocument["nodes"][number], { type: "element" }> {
  let nodes = document.nodes;
  for (;;) {
    const visible = nodes.filter((node) => node.type !== "text" || node.text.length > 0);
    if (visible.length !== 1 || visible[0].type !== "element")
      throw new RuntimeServiceError(
        "invalid_request",
        "an HTML slot probe must contain exactly one atom",
      );
    const node = visible[0];
    if (
      expected === "image"
        ? node.kind === "image"
        : node.kind === "shape" || node.kind === "division"
    ) {
      if (node.children.length)
        throw new RuntimeServiceError(
          "invalid_request",
          "HTML slot probes must not repeat their separately planned children",
        );
      return node;
    }
    if (
      ![
        "bold",
        "italic",
        "underline",
        "strike",
        "font",
        "no_break",
        "button",
        "non_button",
        "clear_button",
      ].includes(node.kind)
    )
      throw new RuntimeServiceError(
        "invalid_request",
        "HTML slot probe contains an unrelated layout node",
      );
    nodes = node.children;
  }
}

function spriteDimensions(
  sprite: NonNullable<HtmlMeasurementResources["sprites"]>[number],
): [number, number] {
  if (
    !Array.isArray(sprite.size) ||
    sprite.size.length !== 2 ||
    sprite.size.some((value) => !isBoundedUnsignedInteger(value, 1_048_576) || value <= 0)
  )
    throw new RuntimeServiceError("invalid_request", "HTML sprite has no valid natural dimensions");
  return [Number(sprite.size[0]), Number(sprite.size[1])];
}

function validateMedia(document: CanonicalHtmlDocument, resources: HtmlMeasurementResources): void {
  const visit = (nodes: CanonicalHtmlDocument["nodes"]) => {
    for (const node of nodes)
      if (node.type === "element") {
        if (node.semantic.type === "image") {
          const source = node.semantic.source;
          const sprite = resources.sprites?.find(
            (item) => item.name.toUpperCase() === source.toUpperCase(),
          );
          if (!sprite)
            throw new RuntimeServiceError(
              "backend_failure",
              "HTML image has no declared sprite; core must supply its fallback probe",
            );
          spriteDimensions(sprite);
          const frame = sprite.frames?.[0];
          const canvasId = sprite.canvas_id ?? frame?.canvas_id;
          if (canvasId != null) {
            const id = serviceInteger(canvasId, "HTML sprite canvas ID");
            if (
              !resources.canvases?.some(
                (canvas) =>
                  BigInt(serviceInteger(canvas.canvas_id, "HTML canvas ID")) === BigInt(id),
              )
            )
              throw new RuntimeServiceError(
                "backend_failure",
                "HTML declared sprite canvas is unavailable",
              );
          } else if (!frame?.resource_id)
            throw new RuntimeServiceError(
              "backend_failure",
              "HTML declared sprite has no readable frame",
            );
        }
        visit(node.children);
      }
  };
  visit(document.nodes);
}

/** Copy only bounded DTO values; never retain mutable Vue objects or arbitrary resource graphs. */
function cloneBounded<T>(value: T): T {
  let values = 0;
  let stringUnits = 0;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (++values > 1_000_000 || depth > 128 || stringUnits > 8 * 1024 * 1024)
      throw new RuntimeServiceError("resource_limit", "HTML snapshot graph exceeds its work limit");
    if (input == null || typeof input === "boolean" || typeof input === "bigint") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input))
        throw new RuntimeServiceError(
          "invalid_request",
          "HTML snapshot contains a nonfinite number",
        );
      return input;
    }
    if (typeof input === "string") {
      stringUnits += input.length;
      if (stringUnits > 8 * 1024 * 1024)
        throw new RuntimeServiceError(
          "resource_limit",
          "HTML snapshot strings exceed their memory limit",
        );
      return input;
    }
    if (typeof input !== "object")
      throw new RuntimeServiceError("invalid_request", "HTML snapshot is not a data object");
    const raw = toRaw(input);
    if (ancestors.has(raw))
      throw new RuntimeServiceError("invalid_request", "HTML snapshot contains a cycle");
    ancestors.add(raw);
    try {
      if (Array.isArray(raw)) {
        if (raw.length > 1_000_000 - values)
          throw new RuntimeServiceError(
            "resource_limit",
            "HTML snapshot array exceeds its work limit",
          );
        return raw.map((item) => copy(item, depth + 1));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
        throw new RuntimeServiceError("invalid_request", "HTML snapshot contains a non-DTO object");
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(raw)) {
        stringUnits += key.length;
        result[key] = copy(item, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(raw);
    }
  };
  return copy(value, 0) as T;
}

function validateBinding(binding: HtmlMeasurementBinding, style: HtmlQueryStyle): void {
  if (
    !binding ||
    !(binding.viewport instanceof HTMLElement) ||
    !binding.viewport.isConnected ||
    binding.viewport.ownerDocument !== document ||
    binding.viewport.clientWidth <= 0 ||
    binding.viewport.clientHeight <= 0
  )
    throw new RuntimeServiceError(
      "stale_projection",
      "HTML measurement requires the confirmed mounted viewport",
    );
  if (binding.viewport.clientWidth > 32768 || binding.viewport.clientHeight > 32768)
    throw new RuntimeServiceError(
      "resource_limit",
      "HTML viewport dimensions exceed the projection budget",
    );
  serviceInteger(binding.context.presentationRevision, "HTML presentation revision");
  serviceInteger(binding.context.environmentRevision, "HTML environment revision");
  serviceInteger(binding.context.projectionSpaceRevision, "HTML projection-space revision");
  if (!Number.isSafeInteger(binding.resourceGeneration) || binding.resourceGeneration < 0)
    throw new RuntimeServiceError("invalid_request", "HTML resource generation is invalid");
  if (
    !style?.base ||
    !style.current ||
    !style.settings ||
    !Number.isSafeInteger(style.base.font_millipixels) ||
    style.base.font_millipixels <= 0 ||
    style.base.font_millipixels > 8_192_000 ||
    !Number.isFinite(Number(style.settings.line_height)) ||
    Number(style.settings.line_height) <= 0 ||
    Number(style.settings.line_height) > 32_768_000
  )
    throw new RuntimeServiceError("invalid_request", "HTML query base style is invalid");
  for (const textStyle of [style.base, style.current]) {
    if (
      [textStyle.bold, textStyle.italic, textStyle.underline, textStyle.strikeout].some(
        (value) => typeof value !== "boolean",
      ) ||
      (textStyle.font_family != null &&
        (typeof textStyle.font_family !== "string" || textStyle.font_family.length > 4096))
    )
      throw new RuntimeServiceError("invalid_request", "HTML text style is invalid");
    for (const color of [textStyle.foreground, textStyle.background].filter(
      (value) => value != null,
    )) {
      if (
        !color ||
        [color.red, color.green, color.blue, color.alpha].some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255,
        )
      )
        throw new RuntimeServiceError("invalid_request", "HTML text style color is invalid");
    }
    if (!textStyle.foreground)
      throw new RuntimeServiceError("invalid_request", "HTML text style foreground is missing");
  }
  const preferences = binding.preferences;
  if (
    !preferences ||
    (preferences.fontFamilyOverride != null &&
      (typeof preferences.fontFamilyOverride !== "string" ||
        preferences.fontFamilyOverride.length > 4096)) ||
    !Number.isFinite(preferences.imageScale) ||
    preferences.imageScale <= 0 ||
    preferences.imageScale > 64 ||
    (preferences.fontSizeOverridePx != null &&
      (!Number.isFinite(preferences.fontSizeOverridePx) ||
        preferences.fontSizeOverridePx <= 0 ||
        preferences.fontSizeOverridePx > 8192))
  )
    throw new RuntimeServiceError("invalid_request", "HTML projection preferences are invalid");
}

function validateSlots(document: CanonicalHtmlDocument, fontSize: number): void {
  const visit = (nodes: CanonicalHtmlDocument["nodes"]) => {
    for (const node of nodes)
      if (node.type === "element") {
        const semantic = node.semantic;
        if (semantic.type === "shape") {
          const projected =
            semantic.kind.toLowerCase() === "space"
              ? projectSpaceShape(semantic.parameters[0], fontSize)
              : projectRectangleShape(semantic.parameters, fontSize)?.slot;
          if (!projected)
            throw new RuntimeServiceError(
              "invalid_request",
              "HTML shape has no valid renderer slot",
            );
          if (projected.width > 32768 || projected.height > 32768)
            throw new RuntimeServiceError("resource_limit", "HTML shape projection is too large");
        }
        if (semantic.type === "division") {
          const width = projectPresentationLength(semantic.width, fontSize);
          const height =
            semantic.height == null
              ? undefined
              : projectPresentationLength(semantic.height, fontSize);
          if (width == null || (semantic.height != null && height == null))
            throw new RuntimeServiceError(
              "invalid_request",
              "HTML division has no valid renderer dimensions",
            );
          if (
            Math.abs(width) > 32768 ||
            (height != null &&
              (Math.abs(height) > 32768 ||
                Math.abs(width * height) > HTML_MEASUREMENT_LIMITS.pixels))
          )
            throw new RuntimeServiceError(
              "resource_limit",
              "HTML division projection is too large",
            );
        }
        visit(node.children);
      }
  };
  visit(document.nodes);
}

function cloneResources(
  resources: HtmlMeasurementResources,
  documents: readonly CanonicalHtmlDocument[],
): HtmlMeasurementResources {
  if (
    !resources ||
    !Array.isArray(resources.sprites ?? []) ||
    !Array.isArray(resources.canvases ?? [])
  )
    throw new RuntimeServiceError("invalid_request", "HTML resource projection is invalid");
  const sprites = resources.sprites ?? [];
  const canvases = resources.canvases ?? [];
  const selectedSprites: typeof sprites = [];
  const selectedCanvases: typeof canvases = [];
  const queuedSprites: typeof sprites = [];
  const queuedCanvases: typeof canvases = [];
  const seenSprites = new Set<object>();
  const seenCanvases = new Set<object>();

  const selectSprite = (name: unknown, revision?: unknown) => {
    if (typeof name !== "string") return;
    const key = name.toUpperCase();
    const sprite = sprites.find(
      (candidate) =>
        candidate != null &&
        typeof candidate.name === "string" &&
        candidate.name.toUpperCase() === key &&
        (revision == null || sameServiceInteger(candidate.revision, revision)),
    );
    if (!sprite || seenSprites.has(sprite)) return;
    seenSprites.add(sprite);
    selectedSprites.push(sprite);
    queuedSprites.push(sprite);
  };
  const selectCanvas = (canvasId: unknown, revision?: unknown) => {
    if (canvasId == null) return;
    const canvas = canvases.find(
      (candidate) =>
        candidate != null &&
        sameServiceInteger(candidate.canvas_id, canvasId) &&
        (revision == null || sameServiceInteger(candidate.revision, revision)),
    );
    if (!canvas || seenCanvases.has(canvas)) return;
    seenCanvases.add(canvas);
    selectedCanvases.push(canvas);
    queuedCanvases.push(canvas);
  };
  const collectDocument = (document: CanonicalHtmlDocument) => {
    const visit = (nodes: CanonicalHtmlDocument["nodes"]) => {
      for (const node of nodes)
        if (node.type === "element") {
          if (node.semantic.type === "image") {
            selectSprite(node.semantic.source);
            selectSprite(node.semantic.hover_source);
            selectSprite(node.semantic.mask_source);
          }
          visit(node.children);
        }
    };
    visit(document.nodes);
  };
  for (const document of documents) collectDocument(document);

  for (let spriteIndex = 0, canvasIndex = 0; ;) {
    while (spriteIndex < queuedSprites.length) {
      const sprite = queuedSprites[spriteIndex++];
      if (sprite.canvas_id != null) selectCanvas(sprite.canvas_id, sprite.canvas_revision);
      const frame = sprite.frames?.[0];
      if (frame?.canvas_id != null) selectCanvas(frame.canvas_id, frame.canvas_revision);
    }
    while (canvasIndex < queuedCanvases.length) {
      const canvas = queuedCanvases[canvasIndex++];
      for (const command of canvas.commands ?? []) {
        if (command?.type === "draw_sprite") selectSprite(command.name, command.resource_revision);
        else if (command?.type === "draw_canvas") {
          selectCanvas(command.source_canvas_id, command.source_revision);
          selectCanvas(command.mask_canvas_id, command.mask_revision);
        }
      }
    }
    if (spriteIndex >= queuedSprites.length && canvasIndex >= queuedCanvases.length) break;
    if (selectedSprites.length > 4096 || selectedCanvases.length > 128)
      throw new RuntimeServiceError(
        "resource_limit",
        "HTML resource projection exceeds the graph budget",
      );
  }
  if (selectedSprites.length > 4096 || selectedCanvases.length > 128)
    throw new RuntimeServiceError(
      "resource_limit",
      "HTML resource projection exceeds the graph budget",
    );
  let commands = 0;
  let encodedBytes = 0;
  const names = new Set<string>();
  for (const sprite of selectedSprites) {
    if (
      !sprite ||
      typeof sprite.name !== "string" ||
      sprite.name.length > 4096 ||
      !Array.isArray(sprite.frames ?? [])
    )
      throw new RuntimeServiceError("invalid_request", "HTML sprite projection is invalid");
    const name = sprite.name.toUpperCase();
    if (names.has(name))
      throw new RuntimeServiceError(
        "invalid_request",
        "HTML sprite projection contains a duplicate name",
      );
    names.add(name);
  }
  const canvasIds = new Set<bigint>();
  for (const canvas of selectedCanvases) {
    if (!canvas)
      throw new RuntimeServiceError("invalid_request", "HTML canvas projection is invalid");
    const id = BigInt(serviceInteger(canvas.canvas_id, "HTML canvas ID"));
    serviceInteger(canvas.revision, "HTML canvas revision");
    if (canvasIds.has(id))
      throw new RuntimeServiceError(
        "invalid_request",
        "HTML canvas projection contains duplicate IDs",
      );
    canvasIds.add(id);
    if (!Array.isArray(canvas.commands ?? []))
      throw new RuntimeServiceError("invalid_request", "HTML canvas command list is invalid");
    commands += canvas.commands?.length ?? 0;
    for (const command of canvas.commands ?? []) {
      if (!command || typeof command.type !== "string")
        throw new RuntimeServiceError("invalid_request", "HTML canvas command is invalid");
      if (command.type === "load_encoded_image") {
        if (
          !Array.isArray(command.encoded) ||
          command.encoded.some((byte) => !isBoundedUnsignedInteger(byte, 255))
        )
          throw new RuntimeServiceError(
            "invalid_request",
            "HTML canvas encoded image bytes are invalid",
          );
        encodedBytes += command.encoded.length;
      }
    }
  }
  if (commands > 100_000 || encodedBytes > 16 * 1024 * 1024)
    throw new RuntimeServiceError(
      "resource_limit",
      "HTML canvas graph exceeds the retained work budget",
    );
  return cloneBounded({ sprites: selectedSprites, canvases: selectedCanvases });
}

async function loadFonts(host: HTMLElement, scope: HtmlMeasurementScope): Promise<void> {
  const fonts = host.ownerDocument.fonts;
  if (!fonts || typeof fonts.load !== "function")
    throw new RuntimeServiceError("backend_failure", "the host cannot observe font readiness");
  const samples = new Map<string, string>();
  for (const segment of host.querySelectorAll<HTMLElement>("[data-html-segment]")) {
    const style = getComputedStyle(segment);
    const font =
      style.font ||
      `${style.fontStyle || "normal"} ${style.fontWeight || "normal"} ${style.fontSize} ${style.fontFamily}`;
    samples.set(font, (samples.get(font) ?? "") + (segment.textContent ?? ""));
  }
  for (const [font, text] of samples) await scope.wait(fonts.load(font, text), "font-load");
  await scope.wait(fonts.ready, "font-ready");
}

function readFirstRow(
  line: HTMLElement,
  document: CanonicalHtmlDocument,
  replaceSpaces: boolean,
  lineHeight: number,
): HtmlFirstRowMetrics {
  const fragments: HtmlMeasuredFragment[] = [];
  let top: number | undefined;
  let bottom: number | undefined;
  let forcedBreak = false;
  const append = (
    rect: DOMRect,
    data: Omit<HtmlMeasuredFragment, "leftPx" | "topPx" | "widthPx" | "heightPx"> = {},
  ) => {
    const width = finitePixels(rect.width);
    const height = finitePixels(rect.height);
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top))
      throw new RuntimeServiceError("backend_failure", "HTML DOM returned invalid positions");
    if (height === 0 && width === 0) return;
    if (top == null) {
      top = rect.top;
      bottom = rect.bottom;
    }
    if (rect.bottom <= top || rect.top >= bottom!) return;
    fragments.push({
      ...data,
      leftPx: rect.left,
      topPx: rect.top,
      widthPx: width,
      heightPx: height,
    });
  };
  for (const element of line.querySelectorAll<HTMLElement>(
    "[data-html-text-path], [data-html-atomic-path], [data-html-break-path]",
  )) {
    // A positioned division contributes its layout slot; its visual children do not add flow advance.
    if (element.parentElement?.closest("[data-html-atomic-path]")) continue;
    if (element.hasAttribute("data-html-break-path")) {
      forcedBreak = true;
      break;
    }
    if (element.hasAttribute("data-html-atomic-path")) {
      const slot =
        getComputedStyle(element).display === "contents" ? element.firstElementChild : element;
      if (!(slot instanceof HTMLElement))
        throw new RuntimeServiceError(
          "backend_failure",
          "HTML media slot is missing after readiness",
        );
      append(slot.getBoundingClientRect());
      continue;
    }
    const path = element.dataset.htmlTextPath!.split(".").map(Number);
    const node = htmlNodeAt(document, path);
    if (node.type !== "text")
      throw new RuntimeServiceError(
        "backend_failure",
        "HTML DOM provenance does not identify canonical text",
      );
    const segments = htmlMeasurementSegments(node.text, replaceSpaces);
    const projected = [...element.querySelectorAll<HTMLElement>("[data-html-segment]")];
    if (projected.length !== segments.length)
      throw new RuntimeServiceError("backend_failure", "HTML DOM text segmentation changed");
    for (const [index, segment] of segments.entries()) {
      const target = projected[index];
      if (target.textContent !== segment.text)
        throw new RuntimeServiceError(
          "backend_failure",
          "HTML projected text differs from its canonical source",
        );
      const data = {
        textNodePath: path,
        decodedUtf16Start: segment.boundaries[0]?.sourceUtf16,
        decodedUtf16End: segment.boundaries.at(-1)?.sourceUtf16,
      };
      if (segment.kind !== "text") {
        append(target.getBoundingClientRect(), data);
        continue;
      }
      const range = line.ownerDocument.createRange();
      try {
        range.selectNodeContents(target);
        const rects = [...range.getClientRects()];
        for (const rect of rects) append(rect, rects.length === 1 ? data : { textNodePath: path });
      } finally {
        range.detach();
      }
    }
  }
  const advancePx = finitePixels(fragments.reduce((sum, item) => sum + item.widthPx, 0));
  return {
    advancePx,
    heightPx: top == null ? (forcedBreak ? lineHeight : 0) : Math.max(lineHeight, bottom! - top),
    fragments,
  };
}

function finitePixels(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000)
    throw new RuntimeServiceError(
      "backend_failure",
      "HTML DOM returned an unrepresentable width or height",
    );
  return value;
}
function measurementError(error: unknown): RuntimeServiceError {
  return error instanceof RuntimeServiceError
    ? error
    : new RuntimeServiceError(
        "backend_failure",
        error instanceof Error ? error.message : "HTML projection failed",
      );
}
