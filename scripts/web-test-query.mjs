/* global window, HTMLImageElement */

export function resolveLocator(page, locator = {}) {
  let resolved;
  if (locator.role)
    resolved = page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
  else if (locator.label) resolved = page.getByLabel(locator.label, { exact: locator.exact });
  else if (locator.text) resolved = page.getByText(locator.text, { exact: locator.exact });
  else if (locator.test_id) resolved = page.getByTestId(locator.test_id);
  else if (locator.css) resolved = page.locator(locator.css);
  else throw new Error("locator requires role, label, text, test_id, or css");
  return locator.nth == null ? resolved : resolved.nth(Number(locator.nth));
}

export async function sampleQueries(page, action) {
  const count = Number(action.count ?? 3);
  const interval = Number(action.interval_ms ?? 1_000);
  const queries = action.queries ?? [];
  if (!Number.isInteger(count) || count < 2)
    throw new Error("sample_queries count must be an integer of at least 2");
  if (!Number.isFinite(interval) || interval < 0)
    throw new Error("sample_queries interval_ms must be a non-negative number");
  if (!queries.length) throw new Error("sample_queries requires at least one query");
  const names = queries.map((query) => String(query.name ?? ""));
  if (names.some((name) => !name) || new Set(names).size !== names.length)
    throw new Error("sample_queries query names must be non-empty and unique");

  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const runtime = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    if (runtime.fault && !action.allow_fault)
      throw new Error(`runtime fault while sampling queries: ${JSON.stringify(runtime.fault)}`);
    const sample = {
      runtime: {
        presentation_revision: runtime.presentationRevision,
        history_revision: runtime.historyRevision,
        output_count: runtime.output?.length,
      },
    };
    for (const query of queries)
      sample[query.name] = await queryLocator(resolveLocator(page, query.locator), query.fields);
    samples.push(sample);
    if (index + 1 < count) await page.waitForTimeout(interval);
  }
  assertSampleExpectations(samples, action.expect ?? {});
  return { query: { samples }, semanticInput: action.semantic_input };
}

export function assertSampleExpectations(samples, expected) {
  for (const path of expected.stable ?? []) {
    const values = samples.map((sample, index) => valueAtPath(sample, path, index));
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0])))
      throw new Error(
        `assertion failed at sample_queries.stable.${path}: got ${JSON.stringify(values)}`,
      );
  }
  for (const path of expected.changes ?? []) {
    const values = samples.map((sample, index) => valueAtPath(sample, path, index));
    if (new Set(values.map((value) => JSON.stringify(value))).size < 2)
      throw new Error(
        `assertion failed at sample_queries.changes.${path}: got ${JSON.stringify(values)}`,
      );
  }
}

export function valueAtPath(value, path, sampleIndex) {
  let current = value;
  for (const key of String(path).split(".")) {
    if (current == null || !Object.hasOwn(current, key))
      throw new Error(`sample_queries path ${path} is missing from sample ${sampleIndex}`);
    current = current[key];
  }
  return current;
}

export async function queryCanvasPixels(locator) {
  const count = await locator.count();
  if (!count) return { count, nontransparent: 0 };
  return locator.first().evaluate((element, elementCount) => {
    if (element?.tagName !== "CANVAS") throw new Error("locator is not a canvas");
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas has no 2D context");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let nontransparent = 0;
    for (let index = 3; index < pixels.length; index += 4)
      if (pixels[index] !== 0) nontransparent += 1;
    return {
      count: elementCount,
      width: element.width,
      height: element.height,
      nontransparent,
    };
  }, count);
}

export async function queryLayout(locator, relative, boxMode, relativeBoxMode) {
  const subject = await layoutBoxes(locator, boxMode);
  const reference = relative ? await layoutBoxes(relative, relativeBoxMode) : undefined;
  return {
    count: subject.length,
    visible: subject.some((item) => item.width > 0 && item.height > 0),
    boxes: subject,
    reference_count: reference?.length,
    reference_boxes: reference,
  };
}

export async function layoutBoxes(locator, mode) {
  if (mode != null && mode !== "game_line") throw new Error(`unsupported layout box mode: ${mode}`);
  return locator.evaluateAll(
    (elements, boxMode) =>
      elements.map((element) => {
        const measured = boxMode === "game_line" ? element.closest(".game-line") : element;
        if (!measured) throw new Error("layout element is not inside a game line");
        const box = measured.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      }),
    mode,
  );
}

export function assertLayout(actual, expected) {
  if (expected.count != null && actual.count !== expected.count)
    throw new Error(
      `assertion failed at layout.count: expected ${expected.count}, got ${actual.count}`,
    );
  if (expected.visible != null && actual.visible !== expected.visible)
    throw new Error(
      `assertion failed at layout.visible: expected ${expected.visible}, got ${actual.visible}`,
    );
  if (!actual.boxes.length) return;

  const first = actual.boxes[0];
  if (expected.same_left_within != null)
    assertSpread(
      "left",
      actual.boxes.map((item) => item.left),
      expected.same_left_within,
    );
  if (expected.same_top_within != null)
    assertSpread(
      "top",
      actual.boxes.map((item) => item.top),
      expected.same_top_within,
    );

  const reference = actual.reference_boxes?.[0];
  if (!reference) {
    if (
      expected.above ||
      expected.below ||
      expected.no_overlap ||
      expected.inside ||
      expected.horizontal_centered_within != null ||
      expected.vertical_centered_within != null ||
      expected.left_aligned_within != null ||
      expected.right_aligned_within != null ||
      expected.top_aligned_within != null ||
      expected.bottom_aligned_within != null
    )
      throw new Error(
        "assertion failed at layout.relative_to: relationship requires a matching element",
      );
    return;
  }

  if (expected.above) assertGap("above", reference.top - first.bottom, expected.above);
  if (expected.below) assertGap("below", first.top - reference.bottom, expected.below);
  if (expected.no_overlap) {
    const overlaps =
      first.left < reference.right &&
      first.right > reference.left &&
      first.top < reference.bottom &&
      first.bottom > reference.top;
    if (overlaps)
      throw new Error("assertion failed at layout.no_overlap: subject intersects relative_to");
  }
  if (expected.inside) {
    const tolerance = Number(expected.inside.tolerance ?? 0);
    if (
      first.left < reference.left - tolerance ||
      first.top < reference.top - tolerance ||
      first.right > reference.right + tolerance ||
      first.bottom > reference.bottom + tolerance
    )
      throw new Error(
        `assertion failed at layout.inside: subject ${JSON.stringify(first)} exceeds ` +
          `relative_to ${JSON.stringify(reference)} by more than ${tolerance}px`,
      );
  }
  if (expected.horizontal_centered_within != null)
    assertDistance(
      "horizontal_center",
      (first.left + first.right) / 2,
      (reference.left + reference.right) / 2,
      expected.horizontal_centered_within,
    );
  if (expected.vertical_centered_within != null)
    assertDistance(
      "vertical_center",
      (first.top + first.bottom) / 2,
      (reference.top + reference.bottom) / 2,
      expected.vertical_centered_within,
    );
  if (expected.left_aligned_within != null)
    assertDistance("left_aligned", first.left, reference.left, expected.left_aligned_within);
  if (expected.right_aligned_within != null)
    assertDistance("right_aligned", first.right, reference.right, expected.right_aligned_within);
  if (expected.top_aligned_within != null)
    assertDistance("top_aligned", first.top, reference.top, expected.top_aligned_within);
  if (expected.bottom_aligned_within != null)
    assertDistance(
      "bottom_aligned",
      first.bottom,
      reference.bottom,
      expected.bottom_aligned_within,
    );
}

function assertSpread(label, values, tolerance) {
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > Number(tolerance))
    throw new Error(
      `assertion failed at layout.same_${label}: spread ${spread}px exceeds ${tolerance}px`,
    );
}

function assertGap(label, gap, expected) {
  const minimum = Number(expected.min ?? 0);
  const maximum = expected.max == null ? Number.POSITIVE_INFINITY : Number(expected.max);
  if (gap < minimum || gap > maximum)
    throw new Error(
      `assertion failed at layout.${label}: gap ${gap}px is outside [${minimum}, ${maximum}]`,
    );
}

function assertDistance(label, actual, expected, tolerance) {
  const distance = Math.abs(actual - expected);
  if (distance > Number(tolerance))
    throw new Error(
      `assertion failed at layout.${label}: distance ${distance}px exceeds ${tolerance}px`,
    );
}

export async function queryLocator(locator, fields = ["count", "text", "visible", "enabled"]) {
  const count = await locator.count();
  const first = locator.first();
  const result = { count };
  if (count) {
    if (fields.includes("text")) result.text = await first.textContent();
    if (fields.includes("html")) result.html = await first.innerHTML();
    if (fields.includes("value")) result.value = await first.inputValue();
    if (fields.includes("visible")) result.visible = await first.isVisible();
    if (fields.includes("enabled")) result.enabled = await first.isEnabled();
    if (fields.includes("checked")) result.checked = await first.isChecked();
    if (fields.includes("attributes"))
      result.attributes = await first.evaluate((element) =>
        Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])),
      );
    if (fields.includes("computed_style"))
      result.computed_style = await first.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return { color: style.color, font_family: style.fontFamily, font_size: style.fontSize };
      });
    if (fields.includes("scroll_top"))
      result.scroll_top = await first.evaluate((element) => element.scrollTop);
    if (fields.includes("scroll_height"))
      result.scroll_height = await first.evaluate((element) => element.scrollHeight);
    if (fields.includes("client_height"))
      result.client_height = await first.evaluate((element) => element.clientHeight);
    if (fields.includes("scrollable_y"))
      result.scrollable_y = await first.evaluate((element) => {
        const overflowY = window.getComputedStyle(element).overflowY;
        return (
          ["auto", "scroll"].includes(overflowY) && element.scrollHeight > element.clientHeight
        );
      });
    if (fields.includes("at_scroll_bottom"))
      result.at_scroll_bottom = await first.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
      );
    if (fields.includes("box"))
      result.box = await first.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      });
    if (fields.includes("square_grid"))
      result.square_grid = await locator.evaluateAll((elements) => {
        const SHRINE_LABEL = "■博麗神社";
        const BORDER_CHARACTER = "■";
        const MAP_ROW_COUNT = 25;
        const SHRINE_EDGE_ROW_COUNT = 10;
        const SHRINE_INTERIOR_START_ROW = 11;
        const SHRINE_INTERIOR_ROW_COUNT = 5;
        const SHRINE_INTERIOR_EDGE = "║";
        const characterBoxes = (element, selectedCharacter) => {
          const boxes = [];
          const ownerDocument = element.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            element,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const character = text[index];
              if (character !== selectedCharacter) continue;
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height) boxes.push(rect.left);
            }
          }
          return boxes;
        };
        const tolerance = 1;
        const rows = elements.map((element) => ({
          element,
          text: element.textContent?.trim() ?? "",
          top: element.getBoundingClientRect().top,
          squares: characterBoxes(element, BORDER_CHARACTER),
        }));
        const labelIndex = rows.findLastIndex((row) => row.text === SHRINE_LABEL);
        let mapEnd = labelIndex - 1;
        while (mapEnd >= 0 && rows[mapEnd].squares.length < 2) mapEnd -= 1;
        const mapStart = mapEnd - MAP_ROW_COUNT + 1;
        if (labelIndex < 0 || mapStart < 0)
          return { aligned: false, reason: "latest shrine map was not found" };
        const map = rows.slice(mapStart, mapEnd + 1);
        const top = map[0];
        const bottom = map.at(-1);
        if (top.squares.length < 8 || bottom.squares.length < 8)
          return { aligned: false, reason: "shrine border rows were incomplete" };
        const left = top.squares[0];
        const right = top.squares.at(-1);
        const alignedBottom =
          Math.abs(bottom.squares[0] - left) <= tolerance &&
          Math.abs(bottom.squares.at(-1) - right) <= tolerance;
        // The shrine's upper outer wall is a ten-row vertical edge. Lower rows
        // intentionally open into paths and adjacent areas, so their last square
        // is not the outer wall and must not be treated as a rectangular edge.
        const borderedRows = map
          .slice(0, SHRINE_EDGE_ROW_COUNT)
          .filter((row) => row.squares.length >= 2);
        const leftEdges = borderedRows.map((row) => row.squares[0]);
        const rightEdges = borderedRows.map((row) => row.squares.at(-1));
        const edgeRows = borderedRows.filter(
          (row) =>
            Math.abs(row.squares[0] - left) <= tolerance &&
            Math.abs(row.squares.at(-1) - right) <= tolerance,
        );
        const interiorRows = map.slice(
          SHRINE_INTERIOR_START_ROW,
          SHRINE_INTERIOR_START_ROW + SHRINE_INTERIOR_ROW_COUNT,
        );
        const interiorEdges = interiorRows.map((row) =>
          characterBoxes(row.element, SHRINE_INTERIOR_EDGE),
        );
        const interiorCounts = interiorEdges.map((edges) => edges.length);
        const completeInterior = interiorCounts.every((count) => count === 1);
        const interiorPositions = completeInterior ? interiorEdges.map((edges) => edges[0]) : [];
        const interiorSpread = completeInterior
          ? Math.max(...interiorPositions) - Math.min(...interiorPositions)
          : null;
        return {
          aligned:
            alignedBottom &&
            edgeRows.length === SHRINE_EDGE_ROW_COUNT &&
            interiorRows.length === SHRINE_INTERIOR_ROW_COUNT &&
            completeInterior &&
            interiorSpread != null &&
            interiorSpread <= tolerance,
          left: Math.round(left * 100) / 100,
          right: Math.round(right * 100) / 100,
          left_spread: Math.round((Math.max(...leftEdges) - Math.min(...leftEdges)) * 100) / 100,
          right_spread: Math.round((Math.max(...rightEdges) - Math.min(...rightEdges)) * 100) / 100,
          top: Math.round(top.top * 100) / 100,
          bottom: Math.round(bottom.top * 100) / 100,
          rows: map.length,
          edge_rows: edgeRows.length,
          interior_left:
            interiorPositions.length > 0 ? Math.round(interiorPositions[0] * 100) / 100 : null,
          interior_spread: interiorSpread == null ? null : Math.round(interiorSpread * 100) / 100,
          interior_rows: interiorRows.length,
          interior_counts: interiorCounts,
        };
      });
    if (fields.includes("dialog_border"))
      result.dialog_border = await first.evaluate((element) => {
        const characterBoxes = (subject) => {
          const boxes = [];
          const ownerDocument = subject.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            subject,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height)
                boxes.push({ character: text[index], left: rect.left });
            }
          }
          return boxes;
        };
        const target = element.closest(".game-line") ?? element;
        const parent = target.parentElement;
        const lines = parent ? [...parent.querySelectorAll(":scope > .game-line")] : [target];
        const index = Math.max(0, lines.indexOf(target));
        const lineText = (line) => line.textContent?.trim() ?? "";
        const isTopBorder = (line) =>
          /^[┌┏╔]/u.test(lineText(line)) && /[┐┓╗]$/u.test(lineText(line));
        const isBottomBorder = (line) =>
          /^[└┗╚]/u.test(lineText(line)) && /[┘┛╝]$/u.test(lineText(line));
        let tableStart = index;
        while (tableStart > 0 && !isTopBorder(lines[tableStart])) {
          tableStart -= 1;
          if (isBottomBorder(lines[tableStart])) break;
        }
        let tableEnd = index;
        while (tableEnd + 1 < lines.length && !isBottomBorder(lines[tableEnd])) {
          tableEnd += 1;
          if (isTopBorder(lines[tableEnd])) break;
        }
        const boundedTable = isTopBorder(lines[tableStart]) && isBottomBorder(lines[tableEnd]);
        const nearby = boundedTable
          ? lines.slice(tableStart, tableEnd + 1)
          : lines.slice(Math.max(0, index - 5), index + 6);
        const borderCharacters = new Set(["│", "┃", "┐", "┘", "┤", "┓", "┛"]);
        const rightEdges = nearby
          .map((line) =>
            characterBoxes(line)
              .filter((box) => borderCharacters.has(box.character))
              .map((box) => box.left)
              .at(-1),
          )
          .filter((value) => value != null);
        const targetEdge = characterBoxes(target)
          .filter((box) => borderCharacters.has(box.character))
          .map((box) => box.left)
          .at(-1);
        if (targetEdge == null || rightEdges.length < 2)
          return { aligned: false, count: rightEdges.length };
        const spread = Math.max(...rightEdges) - Math.min(...rightEdges);
        return {
          aligned: spread <= 1,
          count: rightEdges.length,
          rows: nearby.length,
          right: Math.round(targetEdge * 100) / 100,
          spread: Math.round(spread * 100) / 100,
        };
      });
    if (fields.includes("footer_corner"))
      result.footer_corner = await first.evaluate((element) => {
        const characterBoxes = (subject) => {
          const boxes = [];
          const ownerDocument = subject.ownerDocument;
          const walker = ownerDocument.createTreeWalker(
            subject,
            ownerDocument.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue ?? "";
            for (let index = 0; index < text.length; index += 1) {
              const range = ownerDocument.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width || rect.height)
                boxes.push({ character: text[index], left: rect.left });
            }
          }
          return boxes;
        };
        const target = element.closest(".game-line") ?? element;
        const elementRight = element.getBoundingClientRect().right;
        const corner = characterBoxes(target)
          .filter((box) => ["┘", "┛", "╝"].includes(box.character) && box.left >= elementRight - 1)
          .sort((left, right) => left.left - right.left)[0];
        const parent = target.parentElement;
        const lines = parent ? [...parent.querySelectorAll(":scope > .game-line")] : [target];
        const targetIndex = Math.max(0, lines.indexOf(target));
        const edgeCharacters = new Set(["│", "┃", "║", "┐", "┓", "╗", "┤", "┫", "╣"]);
        const edges = lines.slice(Math.max(0, targetIndex - 24), targetIndex).flatMap((line) =>
          characterBoxes(line)
            .filter((box) => edgeCharacters.has(box.character))
            .map((box) => box.left),
        );
        if (!corner || edges.length === 0) return { aligned: false, count: edges.length };
        const edge = edges.reduce((closest, value) =>
          Math.abs(value - corner.left) < Math.abs(closest - corner.left) ? value : closest,
        );
        const offset = corner.left - edge;
        return {
          aligned: Math.abs(offset) <= 1,
          corner: Math.round(corner.left * 100) / 100,
          edge: Math.round(edge * 100) / 100,
          offset: Math.round(offset * 100) / 100,
        };
      });
    if (fields.includes("content_signature"))
      result.content_signature = await locator.evaluateAll((elements) => {
        const content = elements.map((element) => element.outerHTML).join("\u0000");
        let hash = 0x811c9dc5;
        for (let index = 0; index < content.length; index += 1) {
          hash ^= content.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193);
        }
        return `${content.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
      });
    if (fields.includes("image_loaded"))
      result.image_loaded = await first.evaluate((element) => {
        const image = element instanceof HTMLImageElement ? element : element.querySelector("img");
        return Boolean(
          image?.complete && Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0,
        );
      });
  }
  return result;
}

export function assertSubset(actual, expected, prefix = "") {
  for (const [key, value] of Object.entries(expected)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value))
      assertSubset(actual?.[key], value, label);
    else if (JSON.stringify(actual?.[key]) !== JSON.stringify(value))
      throw new Error(
        `assertion failed at ${label}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`,
      );
  }
}

export function assertStringPrefixes(actual, expected, prefix = "") {
  for (const [key, value] of Object.entries(expected)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertStringPrefixes(actual?.[key], value, label);
    } else if (typeof actual?.[key] !== "string" || !actual[key].startsWith(String(value))) {
      throw new Error(
        `assertion failed at ${label}: expected prefix ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`,
      );
    }
  }
}
