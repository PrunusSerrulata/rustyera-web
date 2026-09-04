import {
  htmlMeasurementSegments,
  htmlNodeAt,
  type CanonicalHtmlDocument,
  type HtmlFirstRowMetrics,
  type HtmlMeasuredFragment,
} from "@/core/htmlMeasurement";
import { RuntimeServiceError } from "@/core/runtimeServiceProtocol";

export function readFirstRow(
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

export function finitePixels(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000)
    throw new RuntimeServiceError(
      "backend_failure",
      "HTML DOM returned an unrepresentable width or height",
    );
  return value;
}
