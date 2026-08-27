import { blake3 } from "@noble/hashes/blake3.js";

const RESOURCE_SUFFIXES = new Set([
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
  "wav",
  "mp3",
  "ogg",
  "opus",
  "aac",
  "m4a",
  "flac",
]);
const AUDIO_SUFFIXES = new Set(["wav", "mp3", "ogg", "opus", "aac", "m4a", "flac"]);
const FONT_SUFFIXES = new Set(["otf", "ttc", "ttf", "woff", "woff2"]);
const DATA_RESOURCE_SUFFIXES = new Set(["xml", "txt", "db", "sqlite"]);
const MUTABLE_RESOURCE_ROOTS = new Set([
  ".git",
  ".rustyera",
  "sav",
  "save",
  "saves",
  "data",
  "logs",
  "log",
]);

export function classify(path: string, roots: ReadonlySet<string>): string | undefined {
  const parts = path.split("/");
  const first = parts[0].toLowerCase();
  const suffix = parts.at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  const name = parts.at(-1)?.toLowerCase() ?? "";
  if (name === "reraconfig.toml" || name === "setting.json") return "configuration";
  if (DATA_RESOURCE_SUFFIXES.has(suffix) && !MUTABLE_RESOURCE_ROOTS.has(first)) return "resource";
  if (first === "resources") {
    if (suffix === "csv") return "resource_manifest";
    return RESOURCE_SUFFIXES.has(suffix) ? "resource" : undefined;
  }
  if (first === "sound") return AUDIO_SUFFIXES.has(suffix) ? "resource" : undefined;
  if (first === "font") return FONT_SUFFIXES.has(suffix) ? "resource" : undefined;
  if (["erb", "erh", "erd"].includes(suffix) && roots.has("erb") && first !== "erb") return;
  if (
    suffix === "als" &&
    (roots.has("csv") || roots.has("erb")) &&
    first !== "csv" &&
    first !== "erb"
  )
    return;
  if (suffix === "csv" && roots.has("csv") && first !== "csv") return;
  if (suffix === "config" && roots.has("csv") && parts.length > 1 && first !== "csv") return;
  const categories: Record<string, string> = {
    csv: "csv",
    erb: "erb",
    erh: "erh",
    als: "als",
    erd: "erd",
    config: "configuration",
  };
  return categories[suffix];
}

export function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function nativeLineEndings(contents: string): string {
  const normalized = normalizeLineEndings(contents);
  const windows =
    /^win/i.test(navigator.platform ?? "") || /\bwindows(?: nt)?\b/i.test(navigator.userAgent);
  return windows ? normalized.replaceAll("\n", "\r\n") : normalized;
}

export function safePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..")) {
    throw new Error("路径必须位于项目目录内");
  }
  return parts.join("/");
}

export async function getDirectory(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current;
}

export async function getFileHandle(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  if (!parts.length) throw new Error("文件路径不能为空");
  const directory = await getDirectory(root, parts.slice(0, -1), create);
  return directory.getFileHandle(parts.at(-1)!, { create });
}

export async function getFile(root: FileSystemDirectoryHandle, parts: string[]): Promise<File> {
  return (await getFileHandle(root, parts, false)).getFile();
}

export async function optionalFile(handle: FileSystemFileHandle): Promise<File | undefined> {
  try {
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

export async function optionalFileHandle(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await getFileHandle(root, parts, false);
  } catch (error) {
    if (errorKind(error) === "not_found") return undefined;
    throw error;
  }
}

export async function checkPrecondition(file: File | undefined, precondition: any): Promise<void> {
  if (precondition.type === "missing" && file) throw conflict();
  if (precondition.type === "revision") {
    if (!file) throw conflict();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hex(blake3(bytes)) !== precondition.revision) throw conflict();
  }
}

export async function collectEntries(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  recursive: boolean,
  pattern: string | null,
  entries: any[],
): Promise<void> {
  for await (const [name, handle] of directory.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === "directory") {
      if (recursive) await collectEntries(handle, `${path}/`, true, pattern, entries);
      continue;
    }
    if (pattern && !wildcard(pattern, name)) continue;
    const file = await handle.getFile();
    entries.push({
      relative_path: path,
      byte_length: file.size,
      revision: null,
      change_token: `${file.size}:${file.lastModified}`,
    });
  }
}

function wildcard(pattern: string, name: string): boolean {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${source}$`, "i").test(name);
}

export function conflict(): DOMException {
  return new DOMException("存储前置条件不成立", "InvalidModificationError");
}

export function errorKind(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotFoundError") return "not_found";
    if (error.name === "NotAllowedError") return "permission_denied";
    if (error.name === "InvalidModificationError") return "conflict";
  }
  return "other";
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
