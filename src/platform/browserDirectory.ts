import { blake3 } from "@noble/hashes/blake3.js";

export interface PickedBrowserDirectory {
  handle: FileSystemDirectoryHandle;
  persistHandle: boolean;
  projectName?: string;
}

const IMPORT_ROOT = ".rustyera-imports";
const SOURCE_MANIFEST = "imported-sources.json";

export async function pickBrowserDirectory(): Promise<PickedBrowserDirectory> {
  if (window.showDirectoryPicker) {
    return { handle: await window.showDirectoryPicker({ mode: "readwrite" }), persistHandle: true };
  }
  if (!navigator.storage.getDirectory) {
    throw new Error("此浏览器无法创建项目存储空间，请更新 Firefox 或 Safari 后重试。");
  }

  const files = await pickDirectoryFiles();
  if (!files) throw new DOMException("用户取消了目录选择", "AbortError");
  const storageRoot = await navigator.storage.getDirectory();
  return importBrowserDirectory(files, storageRoot);
}

export async function importBrowserDirectory(
  selectedFiles: Iterable<File>,
  storageRoot: FileSystemDirectoryHandle,
): Promise<PickedBrowserDirectory> {
  const { projectName, files } = selectedProjectFiles(selectedFiles);
  const imports = await storageRoot.getDirectoryHandle(IMPORT_ROOT, { create: true });
  const projectKey = hex(
    blake3(new TextEncoder().encode(projectName.normalize("NFC").toLowerCase())),
  );
  const project = await imports.getDirectoryHandle(projectKey, { create: true });
  const privateDirectory = await project.getDirectoryHandle(".rustyera", { create: true });
  const previousSources = await readSourceManifest(privateDirectory);
  const nextSources = files
    .filter(({ path }) => !isRuntimeStoragePath(path))
    .map(({ path }) => path);
  const nextSourceSet = new Set(nextSources);

  for (const path of previousSources) {
    if (!nextSourceSet.has(path)) await removeFile(project, path);
  }
  for (const { path, file } of files) {
    if (isRuntimeStoragePath(path) && (await fileExists(project, path))) continue;
    await writeFile(project, path, new Uint8Array(await file.arrayBuffer()));
  }
  await writeFile(
    privateDirectory,
    SOURCE_MANIFEST,
    new TextEncoder().encode(JSON.stringify(nextSources)),
  );
  return { handle: project, persistHandle: false, projectName };
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
  return { projectName: root, files: normalized };
}

async function pickDirectoryFiles(): Promise<File[] | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    let settled = false;
    const finish = (files?: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", focused);
      input.remove();
      resolve(files);
    };
    const focused = () =>
      setTimeout(() => finish(input.files?.length ? [...input.files] : undefined), 0);
    input.addEventListener("change", () =>
      finish(input.files?.length ? [...input.files] : undefined),
    );
    input.addEventListener("cancel", () => finish());
    window.addEventListener("focus", focused, { once: true });
    document.body.append(input);
    input.click();
  });
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
