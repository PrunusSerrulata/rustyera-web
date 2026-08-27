import { blake3 } from "@noble/hashes/blake3.js";
import {
  resolveNormalizedDataPath,
  storageTraversalError,
  validateNormalizedDataPath,
} from "@/platform/browserDataPath";

import {
  checkPrecondition,
  collectEntries,
  conflict,
  errorKind,
  getDirectory,
  getFile,
  getFileHandle,
  hex,
  optionalFile,
  optionalFileHandle,
  safePath,
} from "@/platform/browserProjectFilesystem";
import { storagePattern, type StoragePatternProfile } from "@/platform/storagePattern";
import { decodeProtocolBytes, storageDirectoryName } from "@/platform/browserProjectUtilities";
import {
  operateBrowserResourceStorage,
  type BrowserStorageResource,
} from "@/platform/browserResourceStorage";

export async function dispatchBrowserStorage(
  projectRoot: FileSystemDirectoryHandle,
  namespace: string,
  relativePath: string | undefined,
  operation: any,
  dataRoot: FileSystemDirectoryHandle = projectRoot,
  allowRootReadFallback = true,
  resources: readonly BrowserStorageResource[] = [],
  dataPathIdentity: "literal" | "nfc_lower" = "literal",
  profile: StoragePatternProfile = "emuera.em",
): Promise<any> {
  if (namespace === "resource")
    return operateBrowserResourceStorage(resources, relativePath ?? "", operation, profile);
  const normalizedIdentity = namespace === "data" && dataPathIdentity === "nfc_lower";
  if (normalizedIdentity && new TextEncoder().encode(relativePath ?? "").length > 4096)
    throw new DOMException("存储路径超过限额", "DataError");
  const parts = relativePath ? safePath(relativePath).split("/") : [];
  if (normalizedIdentity) validateNormalizedDataPath(parts);
  const readOnly = ["read", "stat", "read_range", "list"].includes(operation.type);
  const rootReadFallback =
    allowRootReadFallback && readOnly && ["project", "data"].includes(namespace);
  if (operation.type === "list") {
    const matches = storagePattern(
      operation.pattern,
      normalizedIdentity ? "emuera.skia.snake" : "emuera.em",
    );
    let root: FileSystemDirectoryHandle;
    let actual = parts;
    let directory: FileSystemDirectoryHandle;
    let found = false;
    try {
      root = await storageNamespace(
        dataRoot,
        namespace,
        normalizedIdentity ? false : !rootReadFallback,
      );
      if (normalizedIdentity) {
        const resolved = await resolveNormalizedDataPath(root, parts, true);
        actual = resolved.parts;
        found = resolved.found;
      }
      try {
        directory = await getDirectory(root, actual, false);
      } catch (error) {
        throw found ? storageTraversalError(error) : error;
      }
    } catch (error) {
      if (errorKind(error) !== "not_found") throw error;
      if (!rootReadFallback) {
        if (normalizedIdentity) return { type: "listed", entries: [] };
        throw error;
      }
      root = projectRoot;
      actual = parts;
      directory = await getDirectory(root, actual, false);
    }
    // Once a target is open, missing children are conflicts, never namespace fallback.
    const entries: any[] = [];
    await collectEntries(
      directory,
      actual.length ? `${actual.join("/")}/` : "",
      operation.recursive,
      operation.pattern,
      entries,
      normalizedIdentity,
      undefined,
      undefined,
      root,
      matches,
    );
    return { type: "listed", entries };
  }
  try {
    const primary = await storageNamespace(
      dataRoot,
      namespace,
      normalizedIdentity ? operation.type === "write" : !rootReadFallback,
    );
    const resolved = normalizedIdentity
      ? await resolveNormalizedDataPath(primary, parts, false)
      : undefined;
    try {
      return await operateBrowserStorage(
        primary,
        resolved?.parts ?? parts,
        operation,
        normalizedIdentity,
      );
    } catch (error) {
      throw resolved?.found ? storageTraversalError(error) : error;
    }
  } catch (error) {
    if (!rootReadFallback || errorKind(error) !== "not_found") throw error;
    return operateBrowserStorage(projectRoot, parts, operation);
  }
}

async function storageNamespace(
  root: FileSystemDirectoryHandle,
  namespace: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(storageDirectoryName(namespace), { create });
}

async function operateBrowserStorage(
  root: FileSystemDirectoryHandle,
  parts: string[],
  operation: any,
  normalizedIdentity = false,
): Promise<any> {
  if (operation.type === "read") {
    const file = await getFile(root, parts);
    if (file.size > 64 * 1024 * 1024) throw new DOMException("存储读取超过限额", "DataError");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { type: "read", data: [...bytes], revision: hex(blake3(bytes)) };
  }
  if (operation.type === "write") {
    const existingHandle = await optionalFileHandle(root, parts);
    const current = existingHandle ? await existingHandle.getFile() : undefined;
    await checkPrecondition(current, operation.precondition);
    const handle = existingHandle ?? (await getFileHandle(root, parts, true));
    const writable = await handle.createWritable({ keepExistingData: false });
    const bytes = decodeProtocolBytes(operation.data);
    await writable.write(bytes as FileSystemWriteChunkType);
    await writable.close();
    return { type: "written", revision: hex(blake3(bytes)) };
  }
  if (operation.type === "delete") {
    const parent = await getDirectory(root, parts.slice(0, -1), false);
    const handle = await parent.getFileHandle(parts.at(-1)!);
    await checkPrecondition(
      normalizedIdentity ? await handle.getFile() : await optionalFile(handle),
      operation.precondition,
    );
    await parent.removeEntry(parts.at(-1)!);
    return { type: "deleted" };
  }
  if (operation.type === "stat") {
    const file = await getFile(root, parts);
    const hasher = blake3.create();
    for (let offset = 0; offset < file.size; offset += 64 * 1024)
      hasher.update(new Uint8Array(await file.slice(offset, offset + 64 * 1024).arrayBuffer()));
    return { type: "metadata", byte_length: file.size, revision: hex(hasher.digest()) };
  }
  if (operation.type === "read_range") {
    const file = await getFile(root, parts);
    const token = `${file.size}:${file.lastModified}`;
    if (operation.change_token && operation.change_token !== token) throw conflict();
    const offset = Number(operation.offset);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(Number(operation.maximum_bytes)) ||
      Number(operation.maximum_bytes) <= 0 ||
      Number(operation.maximum_bytes) > 4 * 1024 * 1024
    )
      throw new DOMException("存储读取范围超过限额或无效", "DataError");
    const end = Math.min(file.size, offset + Number(operation.maximum_bytes));
    const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    return {
      type: "read_chunk",
      data: [...data],
      offset: operation.offset,
      complete: end >= file.size,
      change_token: token,
    };
  }
  throw new Error(`不支持的存储操作：${operation.type}`);
}
