import { blake3 } from "@noble/hashes/blake3.js";

import type { BrowserManifest } from "@/platform/browserProject";
import { hex } from "@/platform/browserProjectFilesystem";

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
