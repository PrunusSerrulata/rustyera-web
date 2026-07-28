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

interface ScannedFile {
  relative_path: string;
  category: string;
  payload: { type: "utf8" | "bytes"; value: string | Uint8Array };
  content_hash: Uint8Array;
}

export interface BrowserManifest {
  project_revision: number;
  files: ScannedFile[];
}

export class BrowserProject {
  private readonly files = new Map<string, FileSystemFileHandle>();
  private manifestValue?: BrowserManifest;

  constructor(
    readonly root: FileSystemDirectoryHandle,
    private revision = 1,
  ) {}

  async scan(): Promise<BrowserManifest> {
    this.files.clear();
    const topLevel = new Set<string>();
    for await (const [name, handle] of this.root.entries()) {
      if (handle.kind === "directory") topLevel.add(name.toLocaleLowerCase());
    }
    const files: ScannedFile[] = [];
    await this.walk(this.root, "", topLevel, files);
    files.sort((left, right) =>
      left.relative_path.localeCompare(right.relative_path, undefined, { sensitivity: "base" }),
    );
    this.manifestValue = { project_revision: this.revision, files };
    return this.manifestValue;
  }

  async reloadRequest(): Promise<any> {
    const previous = this.manifestValue ?? (await this.scan());
    this.revision += 1;
    const current = await this.scan();
    const oldByPath = new Map(previous.files.map((file) => [file.relative_path, file]));
    const newByPath = new Map(current.files.map((file) => [file.relative_path, file]));
    const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort();
    const changes: any[] = [];
    for (const path of paths) {
      const oldFile = oldByPath.get(path);
      const newFile = newByPath.get(path);
      if (
        oldFile &&
        newFile &&
        oldFile.category === newFile.category &&
        equalBytes(oldFile.content_hash, newFile.content_hash)
      ) {
        continue;
      }
      if (newFile) changes.push({ type: "upsert", file: newFile });
      else if (oldFile)
        changes.push({
          type: "remove",
          category: oldFile.category,
          relative_path: oldFile.relative_path,
        });
    }
    return {
      base_revision: previous.project_revision,
      target_revision: current.project_revision,
      changes,
    };
  }

  async readResource(relativePath: string): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const handle = this.files.get(normalized.toLocaleLowerCase());
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async readResourcePrefix(relativePath: string, maximumBytes: number): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const handle = this.files.get(normalized.toLocaleLowerCase());
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const file = await handle.getFile();
    return new Uint8Array(await file.slice(0, maximumBytes).arrayBuffer());
  }

  async storage(request: any): Promise<any> {
    try {
      const root = await this.namespace(request.namespace);
      const parts = request.relative_path ? safePath(request.relative_path).split("/") : [];
      const operation = request.operation;
      let result: any;
      if (operation.type === "read") {
        const file = await getFile(root, parts);
        const bytes = new Uint8Array(await file.arrayBuffer());
        result = { type: "read", data: bytes, revision: hex(blake3(bytes)) };
      } else if (operation.type === "write") {
        const handle = await getFileHandle(root, parts, true);
        const current = await optionalFile(handle);
        await checkPrecondition(current, operation.precondition);
        const writable = await handle.createWritable({ keepExistingData: false });
        const bytes = new Uint8Array(operation.data);
        await writable.write(bytes);
        await writable.close();
        result = { type: "written", revision: hex(blake3(bytes)) };
      } else if (operation.type === "delete") {
        const parent = await getDirectory(root, parts.slice(0, -1), false);
        const handle = await parent.getFileHandle(parts.at(-1)!);
        await checkPrecondition(await optionalFile(handle), operation.precondition);
        await parent.removeEntry(parts.at(-1)!);
        result = { type: "deleted" };
      } else if (operation.type === "stat") {
        const file = await getFile(root, parts);
        const bytes = new Uint8Array(await file.arrayBuffer());
        result = {
          type: "metadata",
          byte_length: file.size,
          revision: hex(blake3(bytes)),
        };
      } else if (operation.type === "read_range") {
        const file = await getFile(root, parts);
        const token = `${file.size}:${file.lastModified}`;
        if (operation.change_token && operation.change_token !== token) throw conflict();
        const end = Math.min(file.size, operation.offset + operation.maximum_bytes);
        const data = new Uint8Array(await file.slice(operation.offset, end).arrayBuffer());
        result = {
          type: "read_chunk",
          data,
          offset: operation.offset,
          complete: end >= file.size,
          change_token: token,
        };
      } else if (operation.type === "list") {
        const directory = await getDirectory(root, parts, false);
        const entries: any[] = [];
        await collectEntries(directory, root, "", operation.recursive, operation.pattern, entries);
        result = { type: "listed", entries };
      } else {
        throw new Error(`不支持的存储操作：${operation.type}`);
      }
      return { request_id: request.request_id, result };
    } catch (error) {
      return {
        request_id: request.request_id,
        result: {
          type: "error",
          error: { kind: errorKind(error), message: String(error) },
        },
      };
    }
  }

  private async walk(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    topLevel: Set<string>,
    output: ScannedFile[],
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      if (name.toLocaleLowerCase() === ".rustyera") continue;
      const relative = `${prefix}${name}`.normalize("NFC");
      if (handle.kind === "directory") {
        await this.walk(handle, `${relative}/`, topLevel, output);
        continue;
      }
      const category = classify(relative, topLevel);
      if (!category) continue;
      this.files.set(relative.toLocaleLowerCase(), handle);
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      if (category === "resource") {
        output.push({
          relative_path: relative,
          category,
          payload: { type: "bytes", value: bytes },
          content_hash: blake3(bytes),
        });
      } else {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
        } catch {
          throw new Error(`${relative} 不是有效的 UTF-8 文件`);
        }
        const normalized = new TextEncoder().encode(text);
        output.push({
          relative_path: relative,
          category,
          payload: { type: "utf8", value: text },
          content_hash: blake3(normalized),
        });
      }
    }
  }

  private async namespace(namespace: string): Promise<FileSystemDirectoryHandle> {
    if (namespace === "resource") return this.root;
    const names: Record<string, string> = {
      project: "project",
      save: "save",
      global_save: "global",
      data: "data",
      log: "logs",
    };
    return this.root.getDirectoryHandle(names[namespace] ?? "data", { create: true });
  }
}

function classify(path: string, roots: Set<string>): string | undefined {
  const parts = path.split("/");
  const first = parts[0].toLocaleLowerCase();
  const suffix = parts.at(-1)?.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  if (first === "resources") {
    if (suffix === "csv") return "resource_manifest";
    return RESOURCE_SUFFIXES.has(suffix) ? "resource" : undefined;
  }
  if ((suffix === "erb" || suffix === "erh") && roots.has("erb") && first !== "erb") return;
  if (suffix === "csv" && roots.has("csv") && first !== "csv") return;
  if (suffix === "config" && roots.has("csv") && parts.length > 1 && first !== "csv") return;
  const categories: Record<string, string> = {
    csv: "csv",
    erb: "erb",
    erh: "erh",
    config: "configuration",
  };
  return categories[suffix];
}

function safePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..")) {
    throw new Error("路径必须位于项目目录内");
  }
  return parts.join("/");
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current;
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  if (!parts.length) throw new Error("文件路径不能为空");
  const directory = await getDirectory(root, parts.slice(0, -1), create);
  return directory.getFileHandle(parts.at(-1)!, { create });
}

async function getFile(root: FileSystemDirectoryHandle, parts: string[]): Promise<File> {
  return (await getFileHandle(root, parts, false)).getFile();
}

async function optionalFile(handle: FileSystemFileHandle): Promise<File | undefined> {
  try {
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

async function checkPrecondition(file: File | undefined, precondition: any): Promise<void> {
  if (precondition.type === "missing" && file) throw conflict();
  if (precondition.type === "revision") {
    if (!file) throw conflict();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hex(blake3(bytes)) !== precondition.revision) throw conflict();
  }
}

async function collectEntries(
  directory: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
  prefix: string,
  recursive: boolean,
  pattern: string | null,
  entries: any[],
): Promise<void> {
  void root;
  for await (const [name, handle] of directory.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === "directory") {
      if (recursive) await collectEntries(handle, root, `${path}/`, true, pattern, entries);
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

function conflict(): DOMException {
  return new DOMException("存储前置条件不成立", "InvalidModificationError");
}

function errorKind(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotFoundError") return "not_found";
    if (error.name === "NotAllowedError") return "permission_denied";
    if (error.name === "InvalidModificationError") return "conflict";
  }
  return "other";
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
