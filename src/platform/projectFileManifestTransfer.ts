import type { BrowserManifest } from "@/platform/browserProject";

export function projectFileManifestTransfers(manifest: BrowserManifest): ArrayBuffer[] {
  const transfers = new Set<ArrayBuffer>();
  for (const file of manifest.files) {
    if (file.category !== "resource" || file.payload.type !== "bytes") continue;
    const buffer = file.payload.value.buffer;
    if (buffer instanceof ArrayBuffer) transfers.add(buffer);
  }
  return [...transfers];
}

export function takeProjectFileManifestOwnership(manifest: BrowserManifest): BrowserManifest {
  const owned = structuredClone(manifest, { transfer: projectFileManifestTransfers(manifest) });
  for (const file of owned.files) {
    if (file.category !== "resource" || file.payload.type !== "bytes") continue;
    const value = file.payload.value;
    file.payload.value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return owned;
}

export function runtimeWorkerResultTransfers(method: string, result: unknown): ArrayBuffer[] {
  if (method === "pump" || method === "create") {
    return ((result as { events?: Array<{ dataBytes?: Uint8Array }> })?.events ?? [])
      .map((item) => item.dataBytes?.buffer)
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
  }
  if (method !== "finishProjectFile") return [];
  return projectFileManifestTransfers((result as { manifest: BrowserManifest }).manifest);
}
