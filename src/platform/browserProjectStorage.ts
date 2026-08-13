import { blake3 } from "@noble/hashes/blake3.js";

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
import { decodeProtocolBytes, storageDirectoryName } from "@/platform/browserProjectUtilities";

export async function dispatchBrowserStorage(
  projectRoot: FileSystemDirectoryHandle,
  namespace: string,
  relativePath: string | undefined,
  operation: any,
): Promise<any> {
  const parts = relativePath ? safePath(relativePath).split("/") : [];
  const readOnly = ["read", "stat", "read_range", "list"].includes(operation.type);
  const rootReadFallback = readOnly && ["project", "data"].includes(namespace);
  try {
    const primary = await storageNamespace(projectRoot, namespace, !rootReadFallback);
    return await operateBrowserStorage(primary, parts, operation);
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
  if (namespace === "resource") return root;
  return root.getDirectoryHandle(storageDirectoryName(namespace), { create });
}

async function operateBrowserStorage(
  root: FileSystemDirectoryHandle,
  parts: string[],
  operation: any,
): Promise<any> {
  if (operation.type === "read") {
    const file = await getFile(root, parts);
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
    await checkPrecondition(await optionalFile(handle), operation.precondition);
    await parent.removeEntry(parts.at(-1)!);
    return { type: "deleted" };
  }
  if (operation.type === "stat") {
    const file = await getFile(root, parts);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { type: "metadata", byte_length: file.size, revision: hex(blake3(bytes)) };
  }
  if (operation.type === "read_range") {
    const file = await getFile(root, parts);
    const token = `${file.size}:${file.lastModified}`;
    if (operation.change_token && operation.change_token !== token) throw conflict();
    const offset = Number(operation.offset);
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
  if (operation.type === "list") {
    const directory = await getDirectory(root, parts, false);
    const entries: any[] = [];
    const prefix = parts.length ? `${parts.join("/")}/` : "";
    await collectEntries(directory, prefix, operation.recursive, operation.pattern, entries);
    return { type: "listed", entries };
  }
  throw new Error(`不支持的存储操作：${operation.type}`);
}
