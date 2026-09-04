import {
  sameServiceInteger,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";

export interface RevisionedCanvasReplay {
  canvas_id: unknown;
  revision: unknown;
}

export interface RevisionedSpriteReplay {
  name: unknown;
  revision: unknown;
}

export function replayIntegerKey(value: unknown, name = "canvas identity"): string {
  return String(serviceInteger(value, name, true));
}

export function resolveCanvasReplay<T extends RevisionedCanvasReplay>(
  canvases: readonly T[] | undefined,
  canvasId: ServiceInteger,
  revision: ServiceInteger,
): T | undefined {
  return canvases?.find(
    (candidate) =>
      sameServiceInteger(candidate.canvas_id, canvasId) &&
      sameServiceInteger(candidate.revision, revision),
  );
}

export function resolveSpriteReplay<T extends RevisionedSpriteReplay>(
  sprites: readonly T[] | undefined,
  name: string,
  revision: ServiceInteger,
): T | undefined {
  const key = name.toUpperCase();
  return sprites?.find(
    (candidate) =>
      String(candidate.name).toUpperCase() === key &&
      sameServiceInteger(candidate.revision, revision),
  );
}
