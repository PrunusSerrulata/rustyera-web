import {
  HTML_MEASUREMENT_LIMITS,
  htmlNodeAt,
  inspectHtmlDocument,
  type CanonicalHtmlDocument,
  type HtmlMeasurementCut,
  type HtmlQueryStyle,
} from "@/core/htmlMeasurement";
import {
  decodeHtmlQueryStyle,
  decodeHtmlServiceDocument,
  htmlWireInteger,
  htmlWireList,
  htmlWireMap,
  invalidHtmlWire,
} from "@/core/htmlServiceDocument";
import {
  RuntimeServiceError,
  projectionQuery,
  type ProjectionQueryContext,
} from "@/core/runtimeServiceProtocol";

export type HtmlServiceProbe = { id: number; document: CanonicalHtmlDocument } & (
  | { mode: "text_part"; cuts: HtmlMeasurementCut[] }
  | { mode: "image_slot"; missingDocument: CanonicalHtmlDocument }
  | { mode: "fixed_slot" }
);
export interface HtmlServiceQuery {
  context: ProjectionQueryContext;
  style: HtmlQueryStyle;
  probes: HtmlServiceProbe[];
}

export function decodeHtmlServiceQuery(value: unknown): HtmlServiceQuery {
  const map = htmlWireMap(value, [0, 1, 2]);
  const probes = htmlWireList(map.get(2), 32);
  if (probes.length === 0) return invalidHtmlWire("HTML query has no measurement probes");
  let nodes = 0;
  let cuts = 0;
  let work = 0;
  let media = 0;
  let scalars = 0;
  const ids = new Set<number>();
  const document = (value: unknown): CanonicalHtmlDocument => {
    const result = decodeHtmlServiceDocument(value);
    const count = (list: CanonicalHtmlDocument["nodes"]) => {
      for (const node of list) {
        if (++nodes > HTML_MEASUREMENT_LIMITS.nodes)
          throw new RuntimeServiceError(
            "resource_limit",
            "HTML request aggregate node limit exceeded",
          );
        if (node.type === "element") count(node.children);
      }
    };
    count(result.nodes);
    const inspected = inspectHtmlDocument(result);
    work += inspected.work;
    media += inspected.media;
    scalars += inspected.textNodes.reduce((total, node) => total + node.boundaries.length - 1, 0);
    if (
      work > HTML_MEASUREMENT_LIMITS.work ||
      media > HTML_MEASUREMENT_LIMITS.media ||
      scalars > HTML_MEASUREMENT_LIMITS.scalars
    )
      throw new RuntimeServiceError(
        "resource_limit",
        "HTML request aggregate work or atom limit exceeded",
      );
    return result;
  };
  const decoded = probes.map((value): HtmlServiceProbe => {
    const probe = htmlWireMap(value, [0, 1, 2, 3], [4]);
    const id = htmlWireInteger(probe.get(0), 0, 0xffffffff);
    if (ids.has(id)) return invalidHtmlWire("duplicate HTML probe ID");
    ids.add(id);
    const tree = document(probe.get(1));
    const mode = htmlWireInteger(probe.get(2), 0, 2);
    const rawCuts = htmlWireList(probe.get(3), HTML_MEASUREMENT_LIMITS.cuts);
    cuts += rawCuts.length;
    if (cuts > HTML_MEASUREMENT_LIMITS.cuts)
      throw new RuntimeServiceError("resource_limit", "HTML request aggregate cut limit exceeded");
    if (mode !== 0 && rawCuts.length !== 0)
      return invalidHtmlWire("HTML slot probe cannot contain text cuts");
    if (mode !== 1 && probe.has(4))
      return invalidHtmlWire("only image slots may carry missing_document");
    if (mode === 1) {
      if (probe.get(4) == null)
        return invalidHtmlWire("image slot requires a canonical missing_document");
      requireSlot(tree, ["image"]);
      const missingDocument = document(probe.get(4));
      requireTextPart(missingDocument);
      return { id, document: tree, mode: "image_slot", missingDocument };
    }
    if (mode === 2) {
      requireSlot(tree, ["shape", "division"]);
      return { id, document: tree, mode: "fixed_slot" };
    }
    requireTextPart(tree);
    const boundaries = new Map(
      inspectHtmlDocument(tree).textNodes.map((node) => [
        node.path.join("."),
        new Map(node.boundaries.map((boundary) => [boundary.utf16, boundary.utf8])),
      ]),
    );
    const cutIds = new Set<number>();
    const decodedCuts = rawCuts.map((value): HtmlMeasurementCut => {
      const cut = htmlWireMap(value, [0, 1, 2, 3]);
      const id = htmlWireInteger(cut.get(0), 0, 0xffffffff);
      if (cutIds.has(id)) return invalidHtmlWire("duplicate HTML cut ID");
      cutIds.add(id);
      const textNodePath = htmlWireList(cut.get(1), HTML_MEASUREMENT_LIMITS.depth + 1).map(
        (value) => htmlWireInteger(value, 0, 0xffffffff),
      );
      if (textNodePath.length === 0) return invalidHtmlWire("HTML cut path is empty");
      const decodedUtf8Offset = htmlWireInteger(cut.get(2), 0, 0xffffffff);
      const decodedUtf16Offset = htmlWireInteger(cut.get(3), 0, 0xffffffff);
      if (
        htmlNodeAt(tree, textNodePath).type !== "text" ||
        boundaries.get(textNodePath.join("."))?.get(decodedUtf16Offset) !== decodedUtf8Offset
      )
        return invalidHtmlWire(
          "HTML cut does not identify one matching UTF-8/UTF-16 scalar boundary",
        );
      return { id, textNodePath, decodedUtf8Offset, decodedUtf16Offset };
    });
    return { id, document: tree, mode: "text_part", cuts: decodedCuts };
  });
  return {
    context: projectionQuery(map.get(0)),
    style: decodeHtmlQueryStyle(map.get(1)),
    probes: decoded,
  };
}

function requireTextPart(document: CanonicalHtmlDocument): void {
  let nonempty = 0;
  const visit = (nodes: CanonicalHtmlDocument["nodes"]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        if (node.text.length) nonempty += 1;
      } else {
        if (!["bold", "italic", "underline", "strike", "font", "no_break"].includes(node.kind))
          invalidHtmlWire("text-part probe contains a layout atom");
        visit(node.children);
      }
    }
  };
  visit(document.nodes);
  if (nonempty > 1) invalidHtmlWire("text-part probe contains more than one nonempty text node");
}

function requireSlot(document: CanonicalHtmlDocument, kinds: readonly string[]): void {
  let nodes = document.nodes;
  for (;;) {
    const visible = nodes.filter((node) => node.type !== "text" || node.text.length > 0);
    if (visible.length !== 1 || visible[0].type !== "element")
      invalidHtmlWire("HTML slot requires exactly one canonical atom");
    const node = visible[0];
    if (kinds.includes(node.kind)) {
      if (node.children.length !== 0)
        invalidHtmlWire("HTML slot repeats its separately planned children");
      return;
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
      invalidHtmlWire("HTML slot has an unrelated wrapper");
    nodes = node.children;
  }
}

/** Only this new DTO uses millipixels. Existing ProjectionLength remains integer CSS px. */
export function htmlAdvanceMillipixels(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RuntimeServiceError("backend_failure", "HTML provider returned an invalid advance");
  const milli = Math.round(value * 1000);
  if (!Number.isSafeInteger(milli) || milli > 1_048_576_000)
    throw new RuntimeServiceError(
      "resource_limit",
      "HTML advance exceeds the core measurement limit",
    );
  return milli;
}
