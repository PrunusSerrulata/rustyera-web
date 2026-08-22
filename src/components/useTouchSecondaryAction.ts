import { onBeforeUnmount } from "vue";

const TAP_TIMEOUT_MS = 350;
const LONG_PRESS_MS = 600;
const MOVE_TOLERANCE_PX = 12;
const SYNTHETIC_CLICK_TIMEOUT_MS = 800;

interface TouchPoint {
  x: number;
  y: number;
}

export function useTouchSecondaryAction(
  enabled: () => boolean,
  action: () => void,
): {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  pointerCancel: (event: PointerEvent) => void;
  consumeClick: () => boolean;
} {
  const active = new Map<number, TouchPoint>();
  let startedAt = 0;
  let touchCount = 0;
  let invalid = false;
  let longPressTriggered = false;
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;
  let suppressClickTimer: ReturnType<typeof setTimeout> | undefined;

  function pointerDown(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;
    if (active.size === 0) {
      clearClickSuppression();
      resetSequence();
    }
    if (touchCount === 0) startedAt = Date.now();
    active.set(event.pointerId, { x: event.clientX, y: event.clientY });
    touchCount += 1;

    if (touchCount === 1) {
      longPressTimer = setTimeout(() => {
        longPressTimer = undefined;
        if (invalid || active.size !== 1 || !enabled()) return;
        longPressTriggered = true;
        action();
      }, LONG_PRESS_MS);
    } else {
      cancelLongPress();
      if (touchCount > 2 || Date.now() - startedAt > TAP_TIMEOUT_MS) invalid = true;
    }
  }

  function pointerMove(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;
    const point = active.get(event.pointerId);
    if (!point) return;
    if (Math.hypot(event.clientX - point.x, event.clientY - point.y) <= MOVE_TOLERANCE_PX) return;
    invalid = true;
    cancelLongPress();
  }

  function pointerUp(event: PointerEvent): void {
    if (event.pointerType !== "touch" || !active.delete(event.pointerId)) return;
    if (longPressTriggered) {
      if (active.size === 0) armClickSuppression();
    } else if (
      active.size === 0 &&
      !invalid &&
      touchCount === 2 &&
      Date.now() - startedAt <= TAP_TIMEOUT_MS &&
      enabled()
    ) {
      action();
      armClickSuppression();
    }
    if (active.size === 0) resetSequence();
  }

  function pointerCancel(event: PointerEvent): void {
    if (event.pointerType !== "touch" || !active.delete(event.pointerId)) return;
    invalid = true;
    cancelLongPress();
    if (active.size === 0) resetSequence();
  }

  function consumeClick(): boolean {
    if (!suppressClick) return false;
    clearClickSuppression();
    return true;
  }

  function resetSequence(): void {
    cancelLongPress();
    active.clear();
    startedAt = 0;
    touchCount = 0;
    invalid = false;
    longPressTriggered = false;
  }

  function cancelLongPress(): void {
    if (longPressTimer != null) clearTimeout(longPressTimer);
    longPressTimer = undefined;
  }

  function armClickSuppression(): void {
    clearClickSuppression();
    suppressClick = true;
    // Some touch engines delay their compatibility click. A new touch sequence clears this window
    // immediately, so it cannot consume the user's next independent tap.
    suppressClickTimer = setTimeout(clearClickSuppression, SYNTHETIC_CLICK_TIMEOUT_MS);
  }

  function clearClickSuppression(): void {
    if (suppressClickTimer != null) clearTimeout(suppressClickTimer);
    suppressClickTimer = undefined;
    suppressClick = false;
  }

  onBeforeUnmount(() => {
    resetSequence();
    clearClickSuppression();
  });

  return { pointerDown, pointerMove, pointerUp, pointerCancel, consumeClick };
}
