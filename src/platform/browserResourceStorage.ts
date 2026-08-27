import { blake3 } from "@noble/hashes/blake3.js";
import { conflict, equalBytes, hex, safePath } from "@/platform/browserProjectFilesystem";

import { storageTraversalError } from "@/platform/browserDataPath";
import { storagePattern, type StoragePatternProfile } from "@/platform/storagePattern";

export const maximumResourceReadBytes = 64 * 1024 * 1024;
const maximumRangeBytes = 4 * 1024 * 1024;
const maximumPathBytes = 4096;
const maximumListEntries = 100_000;
const maximumListPathBytes = 8 * 1024 * 1024;

export interface BrowserStorageResource {
  path: string;
  byteLength: number;
  contentHash: Uint8Array;
  signature?: string;
  open(): Promise<Blob | Uint8Array>;
}

function boundedPath(path: string): string {
  const normalized = safePath(path);
  if (new TextEncoder().encode(normalized).length > maximumPathBytes || normalized.includes("\0"))
    throw new DOMException("资源路径超过限额或无效", "DataError");
  return normalized;
}

export async function operateBrowserResourceStorage(
  resources: readonly BrowserStorageResource[],
  relativePath: string,
  operation: any,
  profile: StoragePatternProfile,
): Promise<any> {
  if (["write", "delete"].includes(operation.type))
    throw new DOMException("Resource 存储只读", "NoModificationAllowedError");
  const relative = boundedPath(relativePath);
  const index = new Map<string, BrowserStorageResource>();
  let manifestPathBytes = 0;
  for (const resource of resources) {
    const path = boundedPath(resource.path);
    manifestPathBytes += new TextEncoder().encode(path).length;
    if (index.size >= maximumListEntries || manifestPathBytes > maximumListPathBytes)
      throw new DOMException("资源清单超过限额", "DataError");
    const key = path.toLowerCase();
    if (index.has(key)) throw new DOMException("资源清单包含重复规范路径", "DataError");
    index.set(key, { ...resource, path });
  }
  if (operation.type === "list") {
    const matches = storagePattern(operation.pattern, profile);
    const prefix = relative ? `${relative.toLowerCase()}/` : "";
    const entries: any[] = [];
    let pathBytes = 0;
    const ordered = [...index.entries()].sort((a, b) =>
      a[1].path < b[1].path ? -1 : a[1].path > b[1].path ? 1 : 0,
    );
    for (const [key, resource] of ordered) {
      if (!key.startsWith(prefix)) continue;
      const tail = resource.path
        .split("/")
        .slice(relative ? relative.split("/").length : 0)
        .join("/");
      if (!tail || (!operation.recursive && tail.includes("/"))) continue;
      if (!matches(tail.split("/").at(-1)!)) continue;
      pathBytes += new TextEncoder().encode(resource.path).length;
      if (entries.length >= maximumListEntries || pathBytes > maximumListPathBytes)
        throw new DOMException("资源枚举超过限额", "DataError");
      const observed = await verifiedResource(resource, 0, 0);
      entries.push({
        relative_path: resource.path,
        byte_length: resource.byteLength,
        revision: observed.revision,
        change_token: observed.token,
      });
    }
    return { type: "listed", entries };
  }
  const resource = index.get(relative.toLowerCase());
  if (!resource) throw new DOMException("资源不在活动项目清单中", "NotAllowedError");
  let offset = 0;
  let maximum = 0;
  if (operation.type === "read") {
    if (resource.byteLength > maximumResourceReadBytes)
      throw new DOMException("资源读取超过限额，请使用 ReadRange", "DataError");
    maximum = resource.byteLength;
  } else if (operation.type === "read_range") {
    offset = Number(operation.offset);
    maximum = Number(operation.maximum_bytes);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum <= 0 ||
      maximum > maximumRangeBytes
    )
      throw new DOMException("资源读取范围超过限额或无效", "DataError");
  } else if (operation.type !== "stat") {
    throw new DOMException("资源操作无效", "DataError");
  }
  const observed = await verifiedResource(resource, offset, maximum, operation.change_token);
  if (operation.type === "read")
    return { type: "read", data: [...observed.data], revision: observed.revision };
  if (operation.type === "stat")
    return { type: "metadata", byte_length: resource.byteLength, revision: observed.revision };
  return {
    type: "read_chunk",
    data: [...observed.data],
    offset: operation.offset,
    complete: offset + observed.data.length >= resource.byteLength,
    change_token: observed.token,
  };
}

async function verifiedResource(
  resource: BrowserStorageResource,
  offset: number,
  maximum: number,
  expected?: string | null,
) {
  const file = await resource.open().catch((error: unknown) => {
    throw storageTraversalError(error);
  });
  if (file instanceof Uint8Array) {
    const digest = blake3(file);
    const token = `resource:${hex(digest)}`;
    if (
      file.length !== resource.byteLength ||
      !equalBytes(digest, resource.contentHash) ||
      (expected != null && expected !== token)
    )
      throw conflict();
    return { data: file.slice(offset, offset + maximum), revision: hex(digest), token };
  }
  const token =
    "lastModified" in file
      ? `${file.size}:${file.lastModified}`
      : `resource:${hex(resource.contentHash)}`;
  if (
    file.size !== resource.byteLength ||
    (resource.signature != null && token !== resource.signature) ||
    (expected != null && expected !== token)
  )
    throw conflict();
  const hasher = blake3.create();
  const data = new Uint8Array(Math.min(maximum, Math.max(0, file.size - offset)));
  for (let position = 0; position < file.size; position += 64 * 1024) {
    const chunk = new Uint8Array(await file.slice(position, position + 64 * 1024).arrayBuffer());
    if (chunk.length !== Math.min(64 * 1024, file.size - position)) throw conflict();
    hasher.update(chunk);
    const start = Math.max(position, offset);
    const end = Math.min(position + chunk.length, offset + data.length);
    if (start < end) data.set(chunk.subarray(start - position, end - position), start - offset);
  }
  const digest = hasher.digest();
  if (!equalBytes(digest, resource.contentHash)) throw conflict();
  // Native File snapshots may be invalidated or replaced while asynchronous reads are in flight.
  const after = await resource.open();
  if (after instanceof Uint8Array) throw conflict();
  if (
    after.size !== file.size ||
    ("lastModified" in file && "lastModified" in after && file.lastModified !== after.lastModified)
  )
    throw conflict();
  return { data, revision: hex(digest), token };
}
