import { blake3 } from "@noble/hashes/blake3.js";

import type { BrowserManifest } from "@/platform/browserProject";

export interface BrowserProjectFileRuntime {
  projectFileManifest(bytes: Uint8Array): unknown;
  loadProjectWithCompiledCache(manifest: unknown, cache: Uint8Array): unknown;
}

export function loadBrowserProjectFile(
  runtime: BrowserProjectFileRuntime,
  bytes: Uint8Array,
): { manifest: BrowserManifest; storageKey: string } {
  const manifest = runtime.projectFileManifest(bytes) as BrowserManifest;
  runtime.loadProjectWithCompiledCache(manifest, bytes);
  return { manifest, storageKey: hex(blake3(bytes)) };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
