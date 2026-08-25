import { blake3 } from "@noble/hashes/blake3.js";
import type { ProjectSelectionPreparation } from "@/core/types";
import { runBounded } from "@/platform/browserProject";
import type {
  BrowserManifest,
  BrowserProjectScanMetrics,
  ScannedFile,
} from "@/platform/browserProject";
import { scanBrowserProjectFilesOffThread } from "@/platform/browserProjectScanPool";
import {
  browserProjectFileReadConcurrency,
  isAndroidFirefoxHost,
} from "@/platform/browserMemoryPolicy";
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
import { createBrowserSessionDirectory } from "@/platform/browserSessionFilesystem";

export interface PickedBrowserDirectory {
  handle: FileSystemDirectoryHandle;
  persistHandle: boolean;
  storagePersistent: boolean;
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
const PORTABLE_SOURCE_INDEX = ".rustyera/cache/source-index-v1.json";
const PORTABLE_SOURCE_INDEX_VERSION = 3;

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
      storagePersistent: true,
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
    const persistentRoot = await navigator.storage.getDirectory();
    const storagePersistent = await hasWritableFileHandles(persistentRoot);
    const storageRoot = storagePersistent
      ? persistentRoot
      : createBrowserSessionDirectory("directory-import");
    return {
      ...(await importBrowserDirectory(selection.files, storageRoot, progress, storagePersistent)),
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
  storagePersistent = true,
): Promise<PickedBrowserDirectory> {
  const enumerateStarted = performance.now();
  progress?.("importing", 0, 0);
  const { projectName, files } = selectedProjectFiles(selectedFiles);
  await rejectIncompleteAndroidFirefoxSelection(files);
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
    browserProjectFileReadConcurrency(),
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
  progress?.("scanning", 0, scanRequests.length);
  const scans = await scanBrowserProjectFilesOffThread(
    scanRequests,
    topLevel,
    undefined,
    undefined,
    (completed, total) => progress?.("scanning", completed, total),
  );
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
    storagePersistent,
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

async function hasWritableFileHandles(root: FileSystemDirectoryHandle): Promise<boolean> {
  const probeName = ".rustyera-write-capability";
  let created = false;
  try {
    const handle = await root.getFileHandle(probeName, { create: true });
    created = true;
    return typeof handle.createWritable === "function";
  } catch (error) {
    console.warn("Persistent browser project storage is unavailable", error);
    return false;
  } finally {
    if (created) await root.removeEntry(probeName).catch(() => undefined);
  }
}

async function rejectIncompleteAndroidFirefoxSelection(
  files: ReadonlyArray<{ path: string; file: File }>,
): Promise<void> {
  if (!isAndroidFirefoxHost(navigator)) return;
  const sourceIndex = files.find(
    ({ path }) => path.toLocaleLowerCase() === PORTABLE_SOURCE_INDEX,
  )?.file;
  if (!sourceIndex) return;
  let value: unknown;
  try {
    value = JSON.parse(await sourceIndex.text());
  } catch {
    return;
  }
  if (!isRecord(value) || value.version !== PORTABLE_SOURCE_INDEX_VERSION) return;
  if (!isRecord(value.files)) return;
  const selected = new Set(files.map(({ path }) => path.toLocaleLowerCase()));
  const missing = Object.keys(value.files)
    .map(normalizeIndexedPath)
    .filter((path): path is string => Boolean(path && !selected.has(path.toLocaleLowerCase())))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  if (!missing.length) return;
  const examples = missing.slice(0, 5).join("、");
  const exceedsFirefoxDepthLimit = missing.every((path) => path.split("/").length > 6);
  const depthHint = exceedsFirefoxDepthLimit
    ? "这些文件均位于所选目录下超过 5 层的子目录，超出当前 Android Firefox 的目录枚举上限。"
    : "这通常表示 Firefox 未完整上传目录；也可能是项目索引已过期。";
  throw new Error(
    `Android Firefox 选择结果与项目索引不一致：本次目录选择缺少 ${missing.length} 个源码或资源文件（例如 ${examples}）。` +
      `${depthHint}请改用 .reraproj、支持目录句柄的浏览器，或将相关文件移动到 5 层以内。`,
  );
}

function normalizeIndexedPath(path: string): string | undefined {
  try {
    return safePath(path) || undefined;
  } catch {
    // The index is a disposable cache. Ignore malformed entries instead of turning cache
    // corruption into a directory-selection failure unrelated to Firefox's missing files.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSourceManifest(directory: FileSystemDirectoryHandle): Promise<string[]> {
  let text: string;
  try {
    const handle = await directory.getFileHandle(SOURCE_MANIFEST);
    text = await (await handle.getFile()).text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return [];
    throw error;
  }
  try {
    const value = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    // This manifest only tracks obsolete imported copies and is replaced after every import. A
    // browser interrupted while creating it may leave an empty or partial file behind.
    return [];
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
