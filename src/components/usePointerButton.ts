import { ref, watchEffect } from "vue";
import { registerPointerButton, type PointerButtonModel } from "@/platform/pointerObservation";

/** Registration follows Vue element lifetime while the getter reads the current canonical model. */
export function usePointerButton(model: () => PointerButtonModel | undefined) {
  const element = ref<Element>();
  watchEffect((cleanup) => {
    if (element.value) cleanup(registerPointerButton(element.value, model));
  });
  return element;
}
