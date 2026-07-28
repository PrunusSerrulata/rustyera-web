export function isViewportContinuationClick(event: MouseEvent, viewport: HTMLElement): boolean {
  if (event.button !== 0) return false;
  const target = event.target;
  if (!(target instanceof Element) || !viewport.contains(target)) return false;
  return !target.closest("button, a, input, select, textarea, [role='button'], [data-no-continue]");
}
