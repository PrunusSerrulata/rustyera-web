import {
  sameServiceInteger,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { InteractionToken } from "@/core/types";

export type SceneSourceV1 =
  | { type: "resource"; resource_id: string; resource_revision: ServiceInteger }
  | { type: "sprite"; sprite_name: string; resource_revision: ServiceInteger }
  | { type: "canvas"; canvas_id: ServiceInteger; resource_revision: ServiceInteger };

export type SceneAnchorV1 =
  { type: "viewport" } | { type: "display_line"; line_id: ServiceInteger };

export interface SceneInteractionV1 {
  token: InteractionToken;
  value: { type: "integer"; value: ServiceInteger } | { type: "string"; value: string };
  enabled: boolean;
  hover_source?: SceneSourceV1 | null;
  hit_map?: SceneSourceV1 | null;
  title?: string | null;
}

export interface SceneLayerV1 {
  layer_id: ServiceInteger;
  sequence: ServiceInteger;
  source: SceneSourceV1;
  depth: ServiceInteger;
  anchor: SceneAnchorV1;
  offset: { x: ServiceInteger; y: ServiceInteger };
  size: { width: ServiceInteger; height: ServiceInteger };
  opacity: number;
  color_matrix?: ServiceInteger[] | null;
  scroll_policy: "fixed" | "follow_content";
  interaction?: SceneInteractionV1 | null;
  scene_revision: ServiceInteger;
  document_origin_y: ServiceInteger;
}

export interface SceneStateV1 {
  revision: ServiceInteger;
  layers: SceneLayerV1[];
}

export interface SceneDeltaV1 {
  base_revision: ServiceInteger;
  new_revision: ServiceInteger;
  operations: Array<
    | { type: "upsert_layer"; layer: SceneLayerV1 }
    | { type: "remove_layer"; layer_id: ServiceInteger }
    | { type: "clear_depth"; depth: ServiceInteger }
    | { type: "clear_anchored_line"; line_id: ServiceInteger }
    | { type: "replace_scene"; scene: SceneStateV1 }
  >;
}

export function emptyScene(): SceneStateV1 {
  return { revision: 0, layers: [] };
}

/** Replay the public scene contract without exposing a partially-applied candidate. */
export function applySceneDelta(state: SceneStateV1, delta: SceneDeltaV1): SceneStateV1 {
  const base = sceneInteger(delta.base_revision, "scene delta base revision");
  const next = sceneInteger(delta.new_revision, "scene delta revision");
  if (!sameServiceInteger(state.revision, base)) throw new Error("scene revision mismatch");
  if (BigInt(next) <= BigInt(base)) throw new Error("scene revision is not monotonic");
  if (!Array.isArray(delta.operations)) throw new Error("scene delta operations are not an array");

  let layers = [...state.layers];
  for (const operation of delta.operations) {
    switch (operation.type) {
      case "upsert_layer": {
        validateLayer(operation.layer);
        const index = layers.findIndex((layer) =>
          sameServiceInteger(layer.layer_id, operation.layer.layer_id),
        );
        if (index >= 0) {
          const current = layers[index];
          if (!sameServiceInteger(current.sequence, operation.layer.sequence))
            throw new Error("scene layer sequence changed");
          if (BigInt(operation.layer.scene_revision) < BigInt(current.scene_revision))
            throw new Error("scene layer revision moved backwards");
          layers[index] = operation.layer;
        } else {
          const maximumSequence = layers.reduce<bigint | undefined>((maximum, layer) => {
            const sequence = BigInt(layer.sequence);
            return maximum == null || sequence > maximum ? sequence : maximum;
          }, undefined);
          if (maximumSequence != null && maximumSequence > BigInt(operation.layer.sequence))
            throw new Error("scene layer sequence is not monotonic");
          layers.push(operation.layer);
        }
        break;
      }
      case "remove_layer":
        sceneInteger(operation.layer_id, "removed scene layer identity");
        layers = layers.filter((layer) => !sameServiceInteger(layer.layer_id, operation.layer_id));
        break;
      case "clear_depth":
        sceneInteger(operation.depth, "cleared scene depth", true);
        layers = layers.filter((layer) => !sameServiceInteger(layer.depth, operation.depth));
        break;
      case "clear_anchored_line":
        sceneInteger(operation.line_id, "cleared scene line identity");
        layers = layers.filter(
          (layer) =>
            layer.anchor.type !== "display_line" ||
            !sameServiceInteger(layer.anchor.line_id, operation.line_id),
        );
        break;
      case "replace_scene":
        if (!sameServiceInteger(operation.scene.revision, next))
          throw new Error("replacement scene has the wrong revision");
        layers = [...operation.scene.layers];
        break;
      default:
        throw new Error(
          `unknown scene operation: ${String((operation as { type?: unknown }).type)}`,
        );
    }
  }
  layers.sort(compareLayerOrder);
  const candidate = { revision: next, layers };
  validateScene(candidate);
  return candidate;
}

export function validateScene(scene: SceneStateV1): void {
  sceneInteger(scene.revision, "scene revision");
  if (!Array.isArray(scene.layers)) throw new Error("scene layers are not an array");
  const layerIds = new Set<string>();
  const sequences = new Set<string>();
  for (const [index, layer] of scene.layers.entries()) {
    validateLayer(layer);
    const layerId = String(layer.layer_id);
    const sequence = String(layer.sequence);
    if (layerIds.has(layerId)) throw new Error("scene contains a duplicate layer identity");
    if (sequences.has(sequence)) throw new Error("scene contains a duplicate layer sequence");
    if (BigInt(layer.scene_revision) > BigInt(scene.revision))
      throw new Error("scene layer revision is newer than its scene");
    layerIds.add(layerId);
    sequences.add(sequence);
    if (index > 0 && compareLayerOrder(scene.layers[index - 1], layer) > 0)
      throw new Error("scene layers are outside runtime order");
  }
}

function validateLayer(layer: SceneLayerV1): void {
  sceneInteger(layer.layer_id, "scene layer identity");
  sceneInteger(layer.sequence, "scene layer sequence");
  sceneInteger(layer.depth, "scene layer depth", true);
  sceneInteger(layer.offset.x, "scene layer x", true);
  sceneInteger(layer.offset.y, "scene layer y", true);
  sceneInteger(layer.size.width, "scene layer width", true);
  sceneInteger(layer.size.height, "scene layer height", true);
  sceneInteger(layer.scene_revision, "scene layer revision");
  sceneInteger(layer.document_origin_y, "scene document origin", true);
  validateSource(layer.source, "scene layer source");
  if (layer.anchor.type === "display_line")
    sceneInteger(layer.anchor.line_id, "scene line anchor identity");
  else if (layer.anchor.type !== "viewport") throw new Error("unknown scene anchor");
  if (layer.scroll_policy !== "fixed" && layer.scroll_policy !== "follow_content")
    throw new Error("unknown scene scroll policy");
  if (!Number.isInteger(layer.opacity) || layer.opacity < 0 || layer.opacity > 255)
    throw new Error("scene layer opacity is outside u8");
  if (layer.color_matrix != null && layer.color_matrix.length !== 25)
    throw new Error("scene layer color matrix is not 5x5");
  for (const value of layer.color_matrix ?? []) sceneInteger(value, "scene color matrix", true);
  if (layer.interaction != null) validateInteraction(layer.interaction);
}

function validateInteraction(interaction: SceneInteractionV1): void {
  if (typeof interaction.enabled !== "boolean")
    throw new Error("scene interaction enabled is invalid");
  sceneInteger(interaction.token?.epoch, "scene interaction epoch");
  sceneInteger(interaction.token?.id, "scene interaction identity");
  if (!interaction.value || typeof interaction.value !== "object")
    throw new Error("scene interaction value is invalid");
  if (interaction.value.type === "integer")
    sceneInteger(interaction.value.value, "scene interaction integer", true);
  else if (interaction.value.type === "string") {
    if (typeof interaction.value.value !== "string")
      throw new Error("scene interaction string is invalid");
  } else throw new Error("scene interaction value type is invalid");
  if (interaction.title != null && typeof interaction.title !== "string")
    throw new Error("scene interaction title is invalid");
  if (interaction.hover_source) validateSource(interaction.hover_source, "scene hover source");
  if (interaction.hit_map) validateSource(interaction.hit_map, "scene hit map");
}

function validateSource(source: SceneSourceV1, name: string): void {
  if (!source || typeof source !== "object") throw new Error(`${name} is invalid`);
  if (source.type === "resource") {
    if (!source.resource_id) throw new Error(`${name} has no resource identity`);
  } else if (source.type === "sprite") {
    if (!source.sprite_name) throw new Error(`${name} has no sprite identity`);
  } else if (source.type === "canvas") {
    sceneInteger(source.canvas_id, `${name} canvas identity`, true);
  } else {
    throw new Error(`unknown ${name}`);
  }
  sceneInteger(source.resource_revision, `${name} revision`);
}

function sceneInteger(value: unknown, name: string, signed = false): ServiceInteger {
  return serviceInteger(value, name, signed);
}

function compareInteger(left: ServiceInteger, right: ServiceInteger): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLayerOrder(left: SceneLayerV1, right: SceneLayerV1): number {
  const depth = compareInteger(right.depth, left.depth);
  return depth || compareInteger(left.sequence, right.sequence);
}
