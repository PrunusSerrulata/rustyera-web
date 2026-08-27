/** Test-build-only lifecycle inputs. No hook can supply a runtime or measurement result. */
export interface ServiceLifecycleConfiguration {
  gate?: { resourceId: string; sha256: string; byteLength: number; url: string };
  projectPaths?: string[];
}

type DecodeObservation = {
  phase: "start" | "settled" | "cancelled";
  resourceId: string;
  resourceGeneration: number;
  sourceUrl: string;
  outcome?: string;
};

let configuration: ServiceLifecycleConfiguration | undefined;
let sequence = 0;
let failure: string | null = null;
const records: Array<Record<string, unknown>> = [];
const projectPaths: string[] = [];

export function configureServiceLifecycle(value: ServiceLifecycleConfiguration): void {
  if (import.meta.env.VITE_RUSTYERA_TEST !== "1")
    throw new Error("service lifecycle configuration requires a test build");
  if (value.gate) {
    const gate = value.gate;
    const url = new URL(gate.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      !/^\/snake-lifecycle\/[a-f0-9]{64}\.png$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("lifecycle gate must be an isolated loopback image endpoint");
    if (
      gate.resourceId !== "resources/lifecycle-gate.png" ||
      !/^[a-f0-9]{64}$/.test(gate.sha256) ||
      !Number.isSafeInteger(gate.byteLength) ||
      gate.byteLength < 34 ||
      gate.byteLength > 1024 * 1024
    )
      throw new Error("lifecycle gate must identify the bounded fixture resource");
  }
  if (value.projectPaths) {
    if (
      value.projectPaths.length > 2 ||
      value.projectPaths.some(
        (path) => typeof path !== "string" || !path.startsWith("/") || path.includes("\0"),
      )
    )
      throw new Error("lifecycle picker needs at most two absolute isolated project paths");
    projectPaths.splice(0, projectPaths.length, ...value.projectPaths);
  }
  configuration = { gate: value.gate ? { ...value.gate } : undefined };
}

/** The real native open-project command still validates and reads the selected directory. */
export function nextServiceLifecycleProject(fallback: string): string {
  return import.meta.env.VITE_RUSTYERA_TEST === "1" ? (projectPaths.shift() ?? fallback) : fallback;
}

export function serviceLifecycleSnapshot(): Record<string, unknown> {
  return {
    enabled: import.meta.env.VITE_RUSTYERA_TEST === "1" && configuration !== undefined,
    failure,
    records: records.map((record) => ({ ...record })),
  };
}

function record(value: Record<string, unknown>): void {
  if (records.length >= 256) {
    failure = "lifecycle_observation_limit";
    return;
  }
  records.push({ index: sequence++, ...value });
}

export function observeServiceDecode(value: DecodeObservation): void {
  if (
    import.meta.env.VITE_RUSTYERA_TEST !== "1" ||
    !configuration?.gate ||
    !["resources/lifecycle-gate.png", "resources/lifecycle-next.png"].includes(value.resourceId)
  )
    return;
  record({ ...value });
}

/** CORS affects only the exact authorized test stream; ordinary Blob URLs are unchanged. */
export function serviceLifecycleImageCrossOrigin(
  resourceId: string,
  sourceUrl: string,
): "anonymous" | undefined {
  const gate = import.meta.env.VITE_RUSTYERA_TEST === "1" ? configuration?.gate : undefined;
  return gate?.resourceId === resourceId && gate.url === sourceUrl ? "anonymous" : undefined;
}

/** Called only after bridge.readResource performs the normal authorization/hash checks. */
export async function serviceLifecycleResourceUrl(
  resourceId: string,
  bytes: Uint8Array,
  generation: number,
): Promise<string | undefined> {
  const gate = import.meta.env.VITE_RUSTYERA_TEST === "1" ? configuration?.gate : undefined;
  if (!gate || resourceId !== gate.resourceId) return undefined;
  if (bytes.byteLength !== gate.byteLength)
    throw new Error("lifecycle gate source byte length changed");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const sha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 !== gate.sha256) throw new Error("lifecycle gate source SHA256 changed");
  record({
    phase: "resource_authorized",
    resourceId,
    resourceGeneration: generation,
    sha256,
    byteLength: bytes.byteLength,
    sourceUrl: gate.url,
  });
  return gate.url;
}
