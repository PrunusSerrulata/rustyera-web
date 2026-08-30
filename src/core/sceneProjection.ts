import type { SceneLayerV1 } from "@/core/scene";
import { RuntimeServiceError, serviceInteger } from "@/core/runtimeServiceProtocol";

export interface SceneProjectionSpace {
  lineTops: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ProjectedSceneLayer {
  top: number;
  left: number;
  bottomAligned: boolean;
  visible: boolean;
}

export function projectSceneLayer(
  layer: SceneLayerV1,
  space: SceneProjectionSpace,
): ProjectedSceneLayer | undefined {
  const left = logicalPixels(layer.offset.x, "scene layer x");
  const y = logicalPixels(layer.offset.y, "scene layer y");
  const width = absoluteLogicalPixels(layer.size.width, "scene layer width");
  const height = absoluteLogicalPixels(layer.size.height, "scene layer height");
  const bottomAligned = layer.anchor.type === "viewport";
  let top: number;
  if (layer.anchor.type === "display_line") {
    const anchor = space.lineTops.get(String(layer.anchor.line_id));
    if (anchor == null) return undefined;
    top = anchor + y;
  } else {
    top =
      layer.scroll_policy === "fixed"
        ? space.viewportHeight + y + space.scrollTop
        : logicalPixels(layer.document_origin_y, "scene document origin") + y;
  }
  const screenAnchorTop = top - space.scrollTop;
  const screenTop = screenAnchorTop - (bottomAligned ? height : 0);
  const hasKnownBox = width > 0 && height > 0;
  const visible =
    !hasKnownBox ||
    (left + width > 0 &&
      left < space.viewportWidth &&
      screenTop + height > 0 &&
      screenTop < space.viewportHeight);
  return { top, left, bottomAligned, visible };
}

export function logicalPixels(value: unknown, name: string): number {
  const integer = serviceInteger(value, name, true);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
  if (BigInt(integer) < -maximum || BigInt(integer) > maximum)
    throw new RuntimeServiceError(
      "invalid_request",
      `${name} exceeds the exact DOM projection range`,
    );
  return Number(integer) / 1000;
}

function absoluteLogicalPixels(value: unknown, name: string): number {
  return Math.abs(logicalPixels(value, name));
}
