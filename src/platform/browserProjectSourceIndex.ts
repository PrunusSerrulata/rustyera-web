import { errorKind } from "@/platform/browserProjectFilesystem";

const SOURCE_INDEX_VERSION = 1;
const SOURCE_INDEX_NAME = "source-index-v1.json";

export interface BrowserSourceIndexEntry {
  category: string;
  signature: string;
  hash: string;
  size: number;
}

export interface BrowserSourceIndex {
  files: Record<string, BrowserSourceIndexEntry>;
  present: boolean;
  valid: boolean;
}

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
    return { files: {}, present: false, valid: false };
  }
  try {
    const value = JSON.parse(await file.text()) as { version?: unknown; files?: unknown };
    const valid = value.version === SOURCE_INDEX_VERSION && isRecord(value.files);
    return {
      files: valid ? (value.files as Record<string, BrowserSourceIndexEntry>) : {},
      present: true,
      valid,
    };
  } catch {
    return { files: {}, present: true, valid: false };
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
        JSON.stringify({ version: SOURCE_INDEX_VERSION, files }),
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
        previous.size === entry.size
      );
    })
  );
}

export function isBrowserSourceIndexEntry(value: unknown): value is BrowserSourceIndexEntry {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
