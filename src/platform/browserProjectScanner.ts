import { blake3 } from "@noble/hashes/blake3.js";

import { classify, safePath } from "@/platform/browserProjectFilesystem";
import { decodeProjectSource, normalizeResourceManifest } from "@/platform/browserProjectUtilities";

export interface ScannedFile {
  relative_path: string;
  category: string;
  payload: { type: "utf8"; value: string } | { type: "bytes"; value: Uint8Array };
  content_hash: Uint8Array;
}

export function scanBrowserProjectFile(
  relativePath: string,
  bytes: Uint8Array,
  topLevel: ReadonlySet<string>,
): ScannedFile | undefined {
  const relative = safePath(relativePath);
  if (relative.split("/", 1)[0]?.toLowerCase() === ".rustyera") return undefined;
  const category = classify(relative, topLevel);
  if (!category) return undefined;
  if (category === "resource") {
    return {
      relative_path: relative,
      category,
      payload: { type: "bytes", value: bytes },
      content_hash: blake3(bytes),
    };
  }
  const decoded = decodeProjectSource(bytes, relative);
  const text = category === "resource_manifest" ? normalizeResourceManifest(decoded) : decoded;
  const normalized = new TextEncoder().encode(text);
  return {
    relative_path: relative,
    category,
    payload: { type: "utf8", value: text },
    content_hash: blake3(normalized),
  };
}
