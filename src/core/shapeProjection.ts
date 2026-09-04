import type { PresentationLength } from "@/core/types";

export interface ShapeBox {
  width: number;
  height: number;
}

export interface SpaceShapeProjection extends ShapeBox {
  /** Signed inline cursor movement used by the reference renderer. */
  advance: number;
}

export interface RectangleShapeProjection {
  slot: ShapeBox;
  visual: ShapeBox & { left: number; top: number };
}

export function projectPresentationLength(
  value: PresentationLength | undefined,
  fontSizePx: number,
): number | undefined {
  if (!value) return undefined;
  const raw = Number(value.value);
  let projected: number;
  switch (value.unit) {
    case "logical":
      projected = raw / 1000;
      break;
    case "pixels":
      projected = raw;
      break;
    case "font_height_hundredths":
      projected = (raw * fontSizePx) / 100;
      break;
    default:
      return undefined;
  }
  return Number.isFinite(projected) ? projected : undefined;
}

export function projectSpaceShape(
  width: PresentationLength | undefined,
  fontSizePx: number,
): SpaceShapeProjection | undefined {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return undefined;
  const projectedWidth = projectPresentationLength(width, fontSizePx);
  if (projectedWidth == null) return undefined;
  return {
    width: Math.max(0, projectedWidth),
    height: fontSizePx,
    advance: projectedWidth,
  };
}

export function projectRectangleShape(
  parameters: PresentationLength[],
  fontSizePx: number,
): RectangleShapeProjection | undefined {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return undefined;
  let x = 0;
  let y = 0;
  let width: number | undefined;
  let height = fontSizePx;
  if (parameters.length === 1) {
    width = projectPresentationLength(parameters[0], fontSizePx);
  } else if (parameters.length === 4) {
    const projected = parameters.map((value) => projectPresentationLength(value, fontSizePx));
    if (projected.some((value) => value == null)) return undefined;
    [x, y, width, height] = projected as [number, number, number, number];
  } else {
    return undefined;
  }
  if (
    width == null ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    width <= 0 ||
    height <= 0
  )
    return undefined;

  const top = Math.min(0, y);
  const bottom = Math.max(fontSizePx, y + height);
  if (![x + width, bottom - top, y - top].every(Number.isFinite)) return undefined;
  return {
    slot: { width: x + width, height: bottom - top },
    visual: { left: x, top: y - top, width, height },
  };
}
