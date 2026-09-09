import { serviceInteger } from "@/core/runtimeServiceProtocol";

/** Edits use original baseline offsets, so unchanged resources are copied only once. */
function editList(base: any[], edits: any[]): any[] {
  if (!Array.isArray(base) || !Array.isArray(edits)) throw new Error("invalid resource list edits");
  if (edits.length === 0) return base;
  const next: any[] = [];
  let cursor = 0;
  let previousStart = -1;
  for (const edit of edits) {
    const start = Number(serviceInteger(edit?.start, "resource edit start"));
    const count = Number(serviceInteger(edit?.delete_count, "resource edit deletion count"));
    if (
      start > 0xffff_ffff ||
      count > 0xffff_ffff ||
      start < cursor ||
      start <= previousStart ||
      start > base.length ||
      count > base.length - start ||
      !Array.isArray(edit?.insert) ||
      (count === 0 && edit.insert.length === 0)
    )
      throw new Error("resource list edit is out of bounds or overlapping");
    for (let index = cursor; index < start; index += 1) next.push(base[index]);
    for (const value of edit.insert) next.push(value);
    cursor = start + count;
    previousStart = start;
  }
  for (let index = cursor; index < base.length; index += 1) next.push(base[index]);
  return next;
}

function revision(value: unknown): string {
  const parsed = BigInt(serviceInteger(value, "resource revision"));
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error("resource revision exceeds u64");
  return String(parsed);
}

function canvasKey(id: unknown, rev: unknown): string {
  const parsed = BigInt(serviceInteger(id, "canvas identity", true));
  if (parsed < -(1n << 63n) || parsed >= 1n << 63n) throw new Error("canvas identity exceeds i64");
  return `${parsed}@${revision(rev)}`;
}

function spriteKey(name: unknown, rev: unknown): string {
  if (typeof name !== "string") throw new Error("invalid sprite identity");
  return `${name.replace(/[a-z]/g, (character) => character.toUpperCase())}@${revision(rev)}`;
}

function validateReferences(resources: any): void {
  const sprites = new Set<string>();
  const canvases = new Set<string>();
  for (const sprite of resources.sprites) {
    const key = spriteKey(sprite?.name, sprite?.revision);
    if (sprites.has(key)) throw new Error("duplicate exact sprite identity");
    if (!Array.isArray(sprite.frames)) throw new Error("invalid sprite frames");
    sprites.add(key);
  }
  for (const canvas of resources.canvases) {
    const key = canvasKey(canvas?.canvas_id, canvas?.revision);
    if (canvases.has(key)) throw new Error("duplicate exact canvas identity");
    if (!Array.isArray(canvas.commands)) throw new Error("invalid canvas commands");
    canvases.add(key);
  }
  const canvasEdge = (id: unknown, rev: unknown) => {
    if ((id == null) !== (rev == null)) throw new Error("partial exact canvas reference");
    if (id != null && !canvases.has(canvasKey(id, rev))) throw new Error("missing exact canvas");
  };
  for (const sprite of resources.sprites) {
    canvasEdge(sprite.canvas_id, sprite.canvas_revision);
    for (const frame of sprite.frames) canvasEdge(frame.canvas_id, frame.canvas_revision);
  }
  for (const canvas of resources.canvases) {
    for (const command of canvas.commands) {
      if (command.type === "draw_sprite") {
        if (!sprites.has(spriteKey(command.name, command.resource_revision)))
          throw new Error("missing exact sprite");
      } else if (command.type === "draw_canvas") {
        if (command.source_canvas_id == null || command.source_revision == null)
          throw new Error("missing canvas source identity");
        canvasEdge(command.source_canvas_id, command.source_revision);
        canvasEdge(command.mask_canvas_id, command.mask_revision);
      }
    }
  }
}

export function applyResourceReplayDelta(base: any, delta: any): any {
  const timer = Number(serviceInteger(delta?.animation_timer_ms, "animation timer", true));
  if (timer < -0x8000_0000 || timer > 0x7fff_ffff) throw new Error("animation timer exceeds i32");
  const next = {
    sprites: editList(base?.sprites, delta?.sprite_edits),
    canvases: editList(base?.canvases, delta?.canvas_edits),
    animation_timer_ms: timer,
  };
  validateReferences(next);
  return next;
}
