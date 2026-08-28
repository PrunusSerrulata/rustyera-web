import {
  RuntimeServiceError,
  sameServiceInteger,
  serviceInteger,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";

export interface PointerButtonModel {
  epoch: ServiceInteger;
  value: string;
}

const buttons = new WeakMap<Element, () => PointerButtonModel | undefined>();

/** DOM elements only identify a canonical model; their text and physical button flags are irrelevant. */
export function registerPointerButton(
  element: Element,
  model: () => PointerButtonModel | undefined,
): () => void {
  buttons.set(element, model);
  return () => {
    if (buttons.get(element) === model) buttons.delete(element);
  };
}

export function pointerButtonValue(value: unknown): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const scalar = value as { type?: unknown; value?: unknown };
  if (scalar.type === "string" && typeof scalar.value === "string") return scalar.value;
  if (scalar.type === "integer") {
    try {
      return String(serviceInteger(scalar.value, "button value", true));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function htmlPointerButtonValue(interaction: {
  string_value?: unknown;
  integer_value?: unknown;
}): string | undefined {
  if (typeof interaction.string_value === "string") return interaction.string_value;
  if (interaction.integer_value != null)
    return pointerButtonValue({ type: "integer", value: interaction.integer_value });
  return undefined;
}

export interface PointerObservation {
  x: number;
  y: number;
  buttonValue: string;
}

export class RuntimePointerObservation {
  private position: { x: number; y: number } | undefined;
  private listening = false;

  constructor(private readonly viewport: () => HTMLElement | undefined) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("pointermove", this.observe, true);
    window.addEventListener("pointerdown", this.observe, true);
    window.addEventListener("pointerup", this.observe, true);
    window.addEventListener("pointerout", this.outside, true);
    window.addEventListener("pointercancel", this.clear, true);
    window.addEventListener("blur", this.clear);
    document.addEventListener("visibilitychange", this.visibility);
  }

  stop(): void {
    this.clear();
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("pointermove", this.observe, true);
    window.removeEventListener("pointerdown", this.observe, true);
    window.removeEventListener("pointerup", this.observe, true);
    window.removeEventListener("pointerout", this.outside, true);
    window.removeEventListener("pointercancel", this.clear, true);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("visibilitychange", this.visibility);
  }

  readonly clear = (): void => {
    this.position = undefined;
  };
  private readonly visibility = (): void => {
    if (document.visibilityState !== "visible") this.clear();
  };
  private readonly observe = (event: PointerEvent): void => {
    if (!document.hasFocus() || document.visibilityState !== "visible") {
      this.clear();
      return;
    }
    if (event.pointerType === "touch") return;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY))
      this.position = { x: event.clientX, y: event.clientY };
  };
  private readonly outside = (event: PointerEvent): void => {
    // Layout/scroll can emit boundary events with an older position (notably in Firefox).
    // Only move/down/up update coordinates; a boundary event can only invalidate them.
    if (event.relatedTarget == null) this.clear();
  };

  sample(epoch: ServiceInteger): PointerObservation {
    const viewport = this.viewport();
    if (!viewport?.isConnected || viewport.clientWidth <= 0 || viewport.clientHeight <= 0)
      throw new RuntimeServiceError("stale_projection", "game viewport is unavailable");
    if (!this.position || !document.hasFocus() || document.visibilityState !== "visible")
      return { x: 0, y: 0, buttonValue: "" };
    // Recompute both geometry and hit testing on every query, including after scroll/resize.
    const rect = viewport.getBoundingClientRect();
    const localX = this.position.x - rect.left - viewport.clientLeft;
    const localY = this.position.y - rect.top - viewport.clientTop;
    let buttonValue = "";
    if (
      localX >= 0 &&
      localY >= 0 &&
      localX < viewport.clientWidth &&
      localY < viewport.clientHeight
    ) {
      let element = document.elementFromPoint(this.position.x, this.position.y);
      if (element && viewport.contains(element)) {
        while (element && element !== viewport) {
          const model = buttons.get(element)?.();
          if (model) {
            // MOUSEB observes PointingString, not the reference's selectable input button.
            if (sameServiceInteger(model.epoch, epoch)) buttonValue = model.value;
            break;
          }
          element = element.parentElement;
        }
      }
    }
    // The reference subtracts ClientHeight, giving negative y coordinates inside the client area.
    return { x: Math.trunc(localX), y: Math.trunc(localY - viewport.clientHeight), buttonValue };
  }
}
