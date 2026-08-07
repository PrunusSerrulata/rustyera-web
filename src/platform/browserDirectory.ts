import { blake3 } from "@noble/hashes/blake3.js";
import { runBounded, scanBrowserProjectFile } from "@/platform/browserProject";
import type { BrowserManifest, ScannedFile } from "@/platform/browserProject";
import {
  overlayBrowserDirectory,
  type PortableBrowserFile,
} from "@/platform/browserDirectoryOverlay";

export interface PickedBrowserDirectory {
  handle: FileSystemDirectoryHandle;
  persistHandle: boolean;
  projectName?: string;
  manifest?: BrowserManifest;
}

export type BrowserDirectoryProgress = (
  stage: "importing" | "scanning",
  completed: number,
  total: number,
) => void;
export type BrowserDirectorySubmitted = () => void;

const IMPORT_ROOT = ".rustyera-imports";
const SOURCE_MANIFEST = "imported-sources.json";

export async function pickBrowserDirectory(
  progress?: BrowserDirectoryProgress,
  submitted?: BrowserDirectorySubmitted,
): Promise<PickedBrowserDirectory | undefined> {
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      submitted?.();
      progress?.("scanning", 0, 0);
      return {
        handle,
        persistHandle: true,
      };
    } catch (error) {
      if (isPickerCancellation(error)) return undefined;
      throw error;
    }
  }
  if (!navigator.storage.getDirectory) {
    throw new Error("此浏览器无法创建项目存储空间，请更新 Firefox 或 Safari 后重试。");
  }

  const files = await pickDirectoryFiles();
  if (!files) return undefined;
  submitted?.();
  progress?.("importing", 0, 0);
  const storageRoot = await navigator.storage.getDirectory();
  return importBrowserDirectory(files, storageRoot, progress);
}

export async function pickBrowserFile(accept?: string): Promise<File | undefined> {
  return (await pickFiles({ accept }))?.[0];
}

export async function importBrowserDirectory(
  selectedFiles: Iterable<File>,
  storageRoot: FileSystemDirectoryHandle,
  progress?: BrowserDirectoryProgress,
): Promise<PickedBrowserDirectory> {
  progress?.("importing", 0, 0);
  const { projectName, files } = selectedProjectFiles(selectedFiles);
  const imports = await storageRoot.getDirectoryHandle(IMPORT_ROOT, { create: true });
  const projectKey = hex(
    blake3(new TextEncoder().encode(projectName.normalize("NFC").toLowerCase())),
  );
  const project = await imports.getDirectoryHandle(projectKey, { create: true });
  const privateDirectory = await project.getDirectoryHandle(".rustyera", { create: true });
  const previousSources = await readSourceManifest(privateDirectory);
  const topLevel = new Set(
    files
      .map(({ path }) => path.split("/", 1)[0]?.toLocaleLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  for await (const [name, handle] of project.entries()) {
    if (handle.kind === "directory") topLevel.add(name.toLocaleLowerCase());
  }
  const scannedFiles = new Map<string, ScannedFile>();
  const portableFiles: PortableBrowserFile[] = [];
  progress?.("importing", 0, files.length);

  for (const path of previousSources) {
    await removeFile(project, path);
  }
  await runBounded(
    files.map(({ path, file }) => async () => {
      const runtimeStorage = isRuntimeStoragePath(path);
      const preserveRuntimeFile = runtimeStorage && (await fileExists(project, path));
      const bytes = preserveRuntimeFile ? await readFile(project, path) : await fileBytes(file);
      if (runtimeStorage) {
        if (!preserveRuntimeFile) await writeFile(project, path, bytes);
      } else {
        portableFiles.push({ path, file });
      }
      const scanned = scanBrowserProjectFile(path, bytes, topLevel);
      if (scanned) scannedFiles.set(scanned.relative_path, scanned);
    }),
    8,
    (completed, total) => progress?.("importing", completed, total),
  );
  await writeFile(privateDirectory, SOURCE_MANIFEST, new TextEncoder().encode("[]"));
  const manifest = {
    project_revision: 1,
    files: [...scannedFiles.values()].sort((left, right) =>
      left.relative_path.localeCompare(right.relative_path, undefined, { sensitivity: "base" }),
    ),
  };
  return {
    handle: overlayBrowserDirectory(project, portableFiles),
    persistHandle: false,
    projectName,
    manifest,
  };
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function selectedProjectFiles(selectedFiles: Iterable<File>): {
  projectName: string;
  files: Array<{ path: string; file: File }>;
} {
  const files = [...selectedFiles];
  if (!files.length) throw new Error("选择的目录中没有文件。");
  const firstPath = files[0].webkitRelativePath;
  const root = firstPath.split("/")[0]?.normalize("NFC");
  if (!root || !firstPath.includes("/")) throw new Error("浏览器没有提供所选文件的目录信息。");
  const normalized = files.map((file) => {
    const parts = file.webkitRelativePath.replaceAll("\\", "/").normalize("NFC").split("/");
    if (parts.shift() !== root) throw new Error("所选文件必须来自同一个项目目录。");
    const path = safeRelativePath(parts.join("/"));
    if (!path) throw new Error("项目文件路径不能为空。");
    return { path, file };
  });
  const uniquePaths = new Set(normalized.map(({ path }) => path));
  if (uniquePaths.size !== normalized.length) {
    throw new Error("所选目录包含重复的项目文件路径。");
  }
  return { projectName: root, files: normalized };
}

async function pickDirectoryFiles(): Promise<File[] | undefined> {
  return pickFiles({ directory: true, multiple: true });
}

function pickFiles(options: {
  accept?: string;
  directory?: boolean;
  multiple?: boolean;
}): Promise<File[] | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? false;
    input.webkitdirectory = options.directory ?? false;
    if (options.accept) input.accept = options.accept;
    input.hidden = true;
    let settled = false;
    const finish = (files?: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () =>
      finish(input.files?.length ? [...input.files] : undefined),
    );
    input.addEventListener("cancel", () => finish());
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      settled = true;
      input.remove();
      reject(error);
    }
  });
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function readSourceManifest(directory: FileSystemDirectoryHandle): Promise<string[]> {
  try {
    const handle = await directory.getFileHandle(SOURCE_MANIFEST);
    const value = JSON.parse(await (await handle.getFile()).text());
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return [];
    throw error;
  }
}

async function writeFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const parts = safeRelativePath(relativePath).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const handle = await directory.getFileHandle(parts.at(-1)!, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(bytes as FileSystemWriteChunkType);
  await writable.close();
}

async function removeFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<void> {
  const parts = safeRelativePath(relativePath).split("/");
  let directory = root;
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    await directory.removeEntry(parts.at(-1)!);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}

async function readFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<Uint8Array> {
  const parts = safeRelativePath(relativePath).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function fileExists(root: FileSystemDirectoryHandle, relativePath: string): Promise<boolean> {
  const parts = safeRelativePath(relativePath).split("/");
  let directory = root;
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    await directory.getFileHandle(parts.at(-1)!);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    throw error;
  }
}

function isRuntimeStoragePath(path: string): boolean {
  const first = path.split("/", 1)[0].toLowerCase();
  return [".rustyera", "sav", "data", "logs", "project"].includes(first);
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..")) {
    throw new Error("路径必须位于项目目录内");
  }
  return parts.join("/");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
