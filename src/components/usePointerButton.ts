import { onBeforeUnmount, type ComponentPublicInstance } from "vue";
import { registerPointerButton, type PointerButtonModel } from "@/platform/pointerObservation";

/** Registration follows Vue element lifetime while the getter reads the current canonical model. */
export function usePointerButton(model: () => PointerButtonModel | undefined) {
  let registered: Element | undefined;
  let unregister: (() => void) | undefined;
  const setElement = (value: Element | ComponentPublicInstance | null): void => {
    const element = value instanceof Element ? value : undefined;
    if (element === registered) return;
    unregister?.();
    registered = element;
    unregister = element ? registerPointerButton(element, model) : undefined;
  };
  onBeforeUnmount(() => setElement(null));
  // A function ref also permits measurement-only renderers to omit registration entirely.
  return setElement;
}
