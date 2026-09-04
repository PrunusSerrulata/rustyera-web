import { serviceInteger } from "@/core/runtimeServiceProtocol";
import type { SceneInteractionV1 } from "@/core/scene";

const pending = new Set<string>();

export interface SceneInteractionGate {
  useMouse: boolean;
  canInteract: boolean;
  interactionEnabled(interaction: SceneInteractionV1): boolean;
}

export function sceneInteractionEligible(
  interaction: SceneInteractionV1 | null | undefined,
  gate: SceneInteractionGate,
): interaction is SceneInteractionV1 {
  return (
    interaction?.enabled === true &&
    gate.useMouse !== false &&
    gate.canInteract &&
    gate.interactionEnabled(interaction)
  );
}

export function submitSceneInteraction(
  scope: string,
  interaction: SceneInteractionV1,
  submit: (token: SceneInteractionV1["token"]) => unknown,
): boolean {
  const epoch = serviceInteger(interaction.token.epoch, "scene interaction epoch");
  const id = serviceInteger(interaction.token.id, "scene interaction identity");
  const key = `${scope}:${String(epoch)}:${String(id)}`;
  if (pending.has(key)) return false;
  pending.add(key);
  try {
    Promise.resolve(submit(interaction.token)).finally(() => pending.delete(key));
  } catch (error) {
    pending.delete(key);
    throw error;
  }
  return true;
}
