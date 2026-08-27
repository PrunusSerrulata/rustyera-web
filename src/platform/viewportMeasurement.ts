export interface GameViewportMeasurement {
  width: number;
  height: number;
  lineColumns: number;
  chromeWidth: number;
  chromeHeight: number;
}

export function measureGameViewport(
  viewport: HTMLElement,
  history?: HTMLElement | null,
): GameViewportMeasurement {
  const probe = document.createElement("span");
  const sample = "0000000000";
  probe.className = "column-width-probe";
  probe.textContent = sample;
  viewport.append(probe);
  const columnWidth = probe.getBoundingClientRect().width / sample.length;
  probe.remove();
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const availableWidth = history?.clientWidth || width;
  return {
    width,
    height,
    lineColumns:
      columnWidth > 0 && availableWidth > 0
        ? Math.max(1, Math.floor(availableWidth / columnWidth))
        : Math.max(1, Math.floor(width / 8)),
    chromeWidth: Math.max(0, window.innerWidth - width),
    chromeHeight: Math.max(0, window.innerHeight - height),
  };
}

export function currentGameViewport(): HTMLElement | undefined {
  const viewport = document.querySelector(".game-viewport");
  return viewport instanceof HTMLElement ? viewport : undefined;
}

export function currentGameViewportMeasurement(): GameViewportMeasurement | undefined {
  const viewport = currentGameViewport();
  if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return undefined;
  const history = viewport.querySelector(".virtual-history");
  return measureGameViewport(viewport, history instanceof HTMLElement ? history : undefined);
}
