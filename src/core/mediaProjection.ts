import { projectPresentationLength } from "@/core/shapeProjection";
import type { PresentationLength } from "@/core/types";

export interface MediaDimensionInput {
  requestedWidth?: PresentationLength;
  requestedHeight?: PresentationLength;
  placementWidth?: unknown;
  placementHeight?: unknown;
  spriteWidth?: unknown;
  spriteHeight?: unknown;
  fontSizePx: number;
}

export function projectMediaLength(
  value: PresentationLength | undefined,
  fontSizePx: number,
): number | undefined {
  const projected = projectPresentationLength(value, fontSizePx);
  return projected == null ? undefined : Math.abs(projected);
}

export function projectMediaOffset(
  value: PresentationLength | undefined,
  fontSizePx: number,
): number | undefined {
  return projectPresentationLength(value, fontSizePx);
}

export function projectMediaDimensions(input: MediaDimensionInput): {
  width?: number;
  height?: number;
} {
  const spriteWidth = positive(input.spriteWidth);
  const spriteHeight = positive(input.spriteHeight);
  let width =
    projectMediaLength(input.requestedWidth, input.fontSizePx) ??
    projectLogicalPixels(input.placementWidth);
  let height =
    projectMediaLength(input.requestedHeight, input.fontSizePx) ??
    projectLogicalPixels(input.placementHeight);
  if (width == null && height == null) {
    width = spriteWidth;
    height = spriteHeight;
  }
  if (width != null && height == null && spriteWidth && spriteHeight) {
    height = (width * spriteHeight) / spriteWidth;
  } else if (height != null && width == null && spriteWidth && spriteHeight) {
    width = (height * spriteWidth) / spriteHeight;
  }
  return { width, height };
}

export function projectPositionedMediaVerticalSpan(input: {
  y: PresentationLength | undefined;
  height: PresentationLength | undefined;
  fontSizePx: number;
  imageScale: number;
  bottomAnchored: boolean;
  lineHeightPx: number;
}): { top: number; bottom: number } | undefined {
  const y = projectMediaOffset(input.y, input.fontSizePx);
  const height = projectMediaLength(input.height, input.fontSizePx);
  if (y == null || height == null || height === 0) return undefined;
  const top = y * input.imageScale - (input.bottomAnchored ? input.lineHeightPx : 0);
  return { top, bottom: top + height * input.imageScale };
}

export function projectLogicalPixels(value: unknown): number | undefined {
  const result = Math.abs(Number(value)) / 1000;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function positive(value: unknown): number | undefined {
  const result = Math.abs(Number(value));
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
