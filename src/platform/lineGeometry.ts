import {
  RuntimeServiceError,
  sameServiceInteger,
  type LineGeometryQuery,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";

export interface ProjectedLineGeometry {
  top: number;
  height: number;
  viewportHeight: number;
}

type LineGeometryProvider = (
  query: LineGeometryQuery,
  signal: AbortSignal,
) => Promise<ProjectedLineGeometry>;
let provider: LineGeometryProvider | undefined;

export function registerLineGeometryProvider(value: LineGeometryProvider): () => void {
  provider = value;
  return () => {
    if (provider === value) provider = undefined;
  };
}

export async function projectLineGeometry(
  query: LineGeometryQuery,
  signal: AbortSignal,
): Promise<ProjectedLineGeometry> {
  if (!provider)
    throw new RuntimeServiceError("stale_projection", "line geometry provider is unavailable");
  if (signal.aborted)
    throw new RuntimeServiceError("stale_projection", "line geometry query was cancelled");
  return provider(query, signal);
}

/** Read only the currently committed compositor frame; virtual rows are never fabricated. */
export function currentLineGeometry(
  viewport: HTMLElement,
  lineId: ServiceInteger,
): ProjectedLineGeometry {
  if (!viewport.isConnected)
    throw new RuntimeServiceError("stale_projection", "game viewport is unavailable");
  const line = [...viewport.querySelectorAll<HTMLElement>(".game-line[data-line-id]")].find(
    (candidate) => sameServiceInteger(parseLineId(candidate.dataset.lineId), lineId),
  );
  if (!line || !line.isConnected)
    throw new RuntimeServiceError(
      "stale_projection",
      "the requested display line is not realized in the current projection",
    );
  const viewportRect = viewport.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  return {
    top: exactProjectionLength(lineRect.top - viewportRect.top - viewport.clientTop, "line top"),
    height: exactProjectionLength(lineRect.height, "line height"),
    viewportHeight: exactProjectionLength(viewport.clientHeight, "viewport height"),
  };
}

function parseLineId(value: string | undefined): ServiceInteger | undefined {
  if (value == null || !/^\d+$/.test(value)) return undefined;
  const integer = BigInt(value);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}

function exactProjectionLength(value: number, name: string): number {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer))
    throw new RuntimeServiceError(
      "backend_failure",
      `${name} is outside the exact projection range`,
    );
  return integer;
}
