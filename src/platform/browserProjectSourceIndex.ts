import type { ImageMetadata } from "@/core/imageMetadata";
import { errorKind } from "@/platform/browserProjectFilesystem";

export const SOURCE_INDEX_VERSION = 3;
// v3 deliberately uses the browser-common size/mtime-ms signature. Callers must only
// reuse it when their project-file-metadata trust policy permits stat-based indexing.
const SOURCE_INDEX_NAME = "source-index-v1.json";

export interface BrowserSourceIndexEntry {
  category: string;
  signature: string;
  hash: string;
  size: number;
  imageMetadata?: ImageMetadata;
}

export interface BrowserSourceIndex {
  files: Record<string, BrowserSourceIndexEntry>;
  present: boolean;
  valid: boolean;
  portable: boolean;
}

type BrowserSourceIndexIdentity = Omit<BrowserSourceIndexEntry, "imageMetadata"> & {
  imageMetadata?: unknown;
};

export async function readBrowserSourceIndex(
  root: FileSystemDirectoryHandle,
): Promise<BrowserSourceIndex> {
  let file: File;
  try {
    const privateDirectory = await root.getDirectoryHandle(".rustyera");
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
    const handle = await cacheDirectory.getFileHandle(SOURCE_INDEX_NAME);
    file = await handle.getFile();
  } catch {
    return { files: {}, present: false, valid: false, portable: false };
  }
  try {
    const value = JSON.parse(await file.text()) as { version?: unknown; files?: unknown };
    const valid =
      [1, 2, SOURCE_INDEX_VERSION].includes(Number(value.version)) && isRecord(value.files);
    const files: Record<string, BrowserSourceIndexEntry> = {};
    if (valid) {
      for (const [path, entry] of Object.entries(value.files as Record<string, unknown>)) {
        const normalized = normalizeSourceIndexEntry(entry);
        if (normalized) files[path] = normalized;
      }
    }
    return {
      files,
      present: true,
      valid,
      portable: value.version === SOURCE_INDEX_VERSION,
    };
  } catch {
    return { files: {}, present: true, valid: false, portable: false };
  }
}

export async function writeBrowserSourceIndex(
  root: FileSystemDirectoryHandle,
  files: Record<string, BrowserSourceIndexEntry>,
): Promise<void> {
  const privateDirectory = await root.getDirectoryHandle(".rustyera", { create: true });
  const cacheDirectory = await privateDirectory.getDirectoryHandle("cache", { create: true });
  const handle = await cacheDirectory.getFileHandle(SOURCE_INDEX_NAME, { create: true });
  const writer = await handle.createWritable({ keepExistingData: false });
  try {
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          version: SOURCE_INDEX_VERSION,
          files: Object.fromEntries(
            Object.entries(files).map(([path, entry]) => [
              path,
              {
                category: categoryCode(entry.category),
                signature: entry.signature,
                hash: entry.hash,
                size: entry.size,
                ...(entry.imageMetadata ? { image_metadata: entry.imageMetadata } : {}),
              },
            ]),
          ),
        }),
      ) as FileSystemWriteChunkType,
    );
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

export async function removeBrowserSourceIndex(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const privateDirectory = await root.getDirectoryHandle(".rustyera");
    const cacheDirectory = await privateDirectory.getDirectoryHandle("cache");
    await cacheDirectory.removeEntry(SOURCE_INDEX_NAME);
  } catch (error) {
    if (errorKind(error) !== "not_found") throw error;
  }
}

export function decodeSourceIndexHash(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

export function sourceIndexesEqual(
  left: Record<string, BrowserSourceIndexEntry>,
  right: Record<string, BrowserSourceIndexEntry>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(([path, entry]) => {
      const previous = left[path];
      return (
        isBrowserSourceIndexEntry(previous) &&
        previous.category === entry.category &&
        previous.signature === entry.signature &&
        previous.hash.toLowerCase() === entry.hash.toLowerCase() &&
        previous.size === entry.size &&
        JSON.stringify(previous.imageMetadata) === JSON.stringify(entry.imageMetadata)
      );
    })
  );
}

export function isBrowserSourceIndexEntry(value: unknown): value is BrowserSourceIndexEntry {
  return (
    isBrowserSourceIndexIdentity(value) &&
    (value.imageMetadata === undefined || isImageMetadata(value.imageMetadata))
  );
}

export function isBrowserSourceIndexIdentity(value: unknown): value is BrowserSourceIndexIdentity {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    typeof value.signature === "string" &&
    typeof value.hash === "string" &&
    /^[0-9a-f]{64}$/i.test(value.hash) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}

export function validIndexedImageMetadata(value: unknown): ImageMetadata | undefined {
  const normalized =
    Array.isArray(value) && value.length === 4
      ? { width: value[0], height: value[1], format: value[2], animated: value[3] }
      : value;
  return isImageMetadata(normalized) ? normalized : undefined;
}

function normalizeSourceIndexEntry(value: unknown): BrowserSourceIndexEntry | undefined {
  if (!isRecord(value)) return undefined;
  const category = categoryName(value.category);
  const signature = portableSignature(value.signature);
  const imageMetadata = validIndexedImageMetadata(value.image_metadata ?? value.imageMetadata);
  const normalized = {
    category,
    signature,
    hash: value.hash,
    size: value.size,
    imageMetadata,
  };
  return isBrowserSourceIndexEntry(normalized) ? normalized : undefined;
}

function categoryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return ["csv", "erh", "erb", "resource_manifest", "resource", "configuration"][value];
}

function categoryCode(value: string): number {
  const code = ["csv", "erh", "erb", "resource_manifest", "resource", "configuration"].indexOf(
    value,
  );
  if (code < 0) throw new Error(`unknown project source-index category: ${value}`);
  return code;
}

function portableSignature(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  )
    return undefined;
  return `${value[0]}:${Math.floor(value[1] / 1_000_000)}`;
}

function isImageMetadata(value: unknown): value is ImageMetadata {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    value.width <= 0xffff_ffff &&
    typeof value.height === "number" &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.height <= 0xffff_ffff &&
    typeof value.format === "string" &&
    ["png", "bmp", "gif", "jpeg", "webp"].includes(value.format) &&
    typeof value.animated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
