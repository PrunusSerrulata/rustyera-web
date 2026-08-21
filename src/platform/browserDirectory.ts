import { blake3 } from "@noble/hashes/blake3.js";
import type { ProjectSelectionPreparation } from "@/core/types";
import { runBounded } from "@/platform/browserProject";
import type {
  BrowserManifest,
  BrowserProjectScanMetrics,
  ScannedFile,
} from "@/platform/browserProject";
import { scanBrowserProjectFilesOffThread } from "@/platform/browserProjectScanPool";
import { hex, safePath } from "@/platform/browserProjectFilesystem";
import {
  fileSnapshot,
  isPickerCancellation,
  pickFileBytes,
  pickFiles,
  pickRetainedFiles,
  selectedProjectFiles,
} from "@/platform/browserDirectory/fileSelection";
import {
  overlayBrowserDirectory,
  type PortableBrowserFile,
} from "@/platform/browserDirectoryOverlay";

export interface PickedBrowserDirectory {
  handle: FileSystemDirectoryHandle;
  persistHandle: boolean;
  projectName?: string;
  manifest?: BrowserManifest;
  scanMetrics?: BrowserProjectScanMetrics;
  /** Keeps provider-backed directory files readable until the selected project is replaced. */
  release?: () => void;
}

export type BrowserDirectoryProgress = (
  stage: "importing" | "scanning",
  completed: number,
  total: number,
) => void;
export type BrowserDirectorySubmitted = () => void;

export { selectedProjectFiles };

const IMPORT_ROOT = ".rustyera-imports";
const SOURCE_MANIFEST = "imported-sources.json";
const PROJECT_CONFIGURATION = "reraconfig.toml";

export async function pickBrowserDirectory(
  progress?: BrowserDirectoryProgress,
  submitted?: BrowserDirectorySubmitted,
  prepareAfterSelection?: ProjectSelectionPreparation,
): Promise<PickedBrowserDirectory | undefined> {
  if (window.showDirectoryPicker) {
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      if (isPickerCancellation(error)) return undefined;
      throw error;
    }
    submitted?.();
    const permission = await handle.requestPermission?.({ mode: "readwrite" });
    if (permission && permission !== "granted")
      throw new Error("运行完整游戏需要项目目录的读写权限。");
    await prepareAfterSelection?.();
    progress?.("scanning", 0, 0);
    return {
      handle,
      persistHandle: true,
    };
  }
  if (!navigator.storage.getDirectory) {
    throw new Error("此浏览器无法创建项目存储空间，请更新 Firefox 或 Safari 后重试。");
  }

  const selection = await pickDirectoryFiles();
  if (!selection) return undefined;
  try {
    submitted?.();
    await prepareAfterSelection?.();
    progress?.("importing", 0, 0);
    const storageRoot = await navigator.storage.getDirectory();
    return {
      ...(await importBrowserDirectory(selection.files, storageRoot, progress)),
      release: selection.release,
    };
  } catch (error) {
    selection.release();
    throw error;
  }
}

export async function pickBrowserFile(accept?: string): Promise<File | undefined> {
  return (await pickFiles({ accept }))?.[0];
}

export function pickBrowserFileBytes(accept?: string): Promise<Uint8Array | undefined> {
  return pickFileBytes(accept);
}

export interface PickedBrowserProjectFile {
  file: File;
  handle?: FileSystemFileHandle;
}

export async function pickBrowserProjectFile(): Promise<PickedBrowserProjectFile | undefined> {
  if (window.showOpenFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "RustyEra 项目",
            accept: { "application/octet-stream": [".reraproj"] },
          },
        ],
      });
    } catch (error) {
      if (isPickerCancellation(error)) return undefined;
      throw error;
    }
    const permission = await handle.requestPermission?.({ mode: "readwrite" });
    const file = await handle.getFile();
    return permission && permission !== "granted" ? { file } : { file, handle };
  }
  const file = await pickBrowserFile(".reraproj,application/octet-stream");
  return file ? { file } : undefined;
}

export async function importBrowserDirectory(
  selectedFiles: Iterable<File>,
  storageRoot: FileSystemDirectoryHandle,
  progress?: BrowserDirectoryProgress,
): Promise<PickedBrowserDirectory> {
  const enumerateStarted = performance.now();
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
  const enumerateMs = performance.now() - enumerateStarted;
  const scannedFiles = new Map<string, ScannedFile>();
  const portableFiles: PortableBrowserFile[] = [];
  const scanRequests = new Array<{ relativePath: string; file: File }>(files.length);
  const selectedConfiguration = files.some(({ path }) => isProjectConfigurationPath(path));
  progress?.("importing", 0, files.length);

  for (const path of previousSources) {
    await removeFile(project, path);
  }
  const statAndCopyStarted = performance.now();
  await runBounded(
    files.map(({ path, file }, index) => async () => {
      const runtimeStorage = isRuntimeStoragePath(path);
      const effectivePath = isProjectConfigurationPath(path) ? PROJECT_CONFIGURATION : path;
      const preserveStoredFile =
        (runtimeStorage || effectivePath === PROJECT_CONFIGURATION) &&
        (await fileExists(project, effectivePath));
      if (runtimeStorage || preserveStoredFile) {
        const bytes = preserveStoredFile
          ? await readFile(project, effectivePath)
          : await fileBytes(file);
        if (!preserveStoredFile) await writeFile(project, effectivePath, bytes);
        scanRequests[index] = {
          relativePath: effectivePath,
          file: preserveStoredFile ? fileSnapshot(file, bytes) : file,
        };
        if (!runtimeStorage) portableFiles.push({ path: effectivePath, file });
      } else {
        portableFiles.push({ path: effectivePath, file });
        scanRequests[index] = { relativePath: effectivePath, file };
      }
    }),
    8,
    (completed, total) => progress?.("importing", completed, total),
  );
  if (!selectedConfiguration && (await fileExists(project, PROJECT_CONFIGURATION))) {
    scanRequests.push({
      relativePath: PROJECT_CONFIGURATION,
      file: await readFileEntry(project, PROJECT_CONFIGURATION),
    });
  }
  const statMs = performance.now() - statAndCopyStarted;
  const scanStarted = performance.now();
  const scans = await scanBrowserProjectFilesOffThread(scanRequests, topLevel);
  for (const scanned of scans) {
    if (scanned) scannedFiles.set(scanned.relative_path, scanned);
  }
  const sourceReadDecodeHashMs = performance.now() - scanStarted;
  const indexWriteStarted = performance.now();
  await writeFile(privateDirectory, SOURCE_MANIFEST, new TextEncoder().encode("[]"));
  const indexWriteMs = performance.now() - indexWriteStarted;
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
    scanMetrics: {
      enumerateMs,
      indexReadMs: 0,
      indexWriteMs,
      statMs,
      sourceReadDecodeHashMs,
      sourceIndexPresent: false,
      sourceIndexTrusted: false,
      sourceIndexReusedFiles: 0,
      sourceIndexHashedFiles: manifest.files.length,
    },
  };
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function pickDirectoryFiles() {
  return pickRetainedFiles({ directory: true, multiple: true });
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
  const parts = safePath(relativePath).split("/");
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
  const parts = safePath(relativePath).split("/");
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
  const parts = safePath(relativePath).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function readFileEntry(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const parts = safePath(relativePath).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  return (await directory.getFileHandle(parts.at(-1)!)).getFile();
}

async function fileExists(root: FileSystemDirectoryHandle, relativePath: string): Promise<boolean> {
  const parts = safePath(relativePath).split("/");
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

function isProjectConfigurationPath(path: string): boolean {
  return path.toLowerCase() === PROJECT_CONFIGURATION;
}
