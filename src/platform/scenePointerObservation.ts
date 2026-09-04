import { sameServiceInteger, type ServiceInteger } from "@/core/runtimeServiceProtocol";
import type { PointerButtonModel } from "@/platform/pointerObservation";

interface ScenePointerProvider {
  observe(clientX: number, clientY: number): PointerButtonModel | undefined;
  activate(clientX: number, clientY: number): boolean;
}

let provider: ScenePointerProvider | undefined;

export function registerScenePointerProvider(value: ScenePointerProvider): () => void {
  provider = value;
  return () => {
    if (provider === value) provider = undefined;
  };
}

export function scenePointerButton(
  epoch: ServiceInteger,
  clientX: number,
  clientY: number,
): string | undefined {
  const model = provider?.observe(clientX, clientY);
  return model && sameServiceInteger(model.epoch, epoch) ? model.value : undefined;
}

export function activateScenePointer(clientX: number, clientY: number): boolean {
  return provider?.activate(clientX, clientY) ?? false;
}
