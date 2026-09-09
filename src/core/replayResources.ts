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
  current_alias?: boolean | null;
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

/** HTML names resolve the current alias, while draw commands retain an exact revision. */
export function resolveCurrentSpriteReplay<T extends RevisionedSpriteReplay>(
  sprites: readonly T[] | undefined,
  name: string,
): T | undefined {
  const key = name.toUpperCase();
  const matches =
    sprites?.filter((candidate) => String(candidate.name).toUpperCase() === key) ?? [];
  const current = matches.filter((candidate) => candidate.current_alias === true);
  if (current.length > 1) throw new Error("HTML image has multiple current sprite aliases");
  if (current.length === 1) return current[0];
  if (matches.some((candidate) => candidate.current_alias != null)) return undefined;
  // Older projections did not distinguish aliases; only an unambiguous name is safe.
  if (matches.length > 1) throw new Error("HTML image sprite revision is ambiguous");
  return matches[0];
}
