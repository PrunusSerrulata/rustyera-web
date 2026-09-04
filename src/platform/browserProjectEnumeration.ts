import { classify } from "@/platform/browserProjectFilesystem";
import { browserProjectDirectoryReadConcurrency } from "@/platform/browserMemoryPolicy";

export interface BrowserProjectFileCandidate {
  relativePath: string;
  category: string;
  handle: FileSystemFileHandle;
}

export interface BrowserProjectEnumeration {
  files: BrowserProjectFileCandidate[];
  topLevel: Set<string>;
}

export async function enumerateBrowserProject(
  root: FileSystemDirectoryHandle,
  progress?: (visitedEntries: number) => void,
): Promise<BrowserProjectEnumeration> {
  const topLevel = new Set<string>();
  const rawFiles: Array<Omit<BrowserProjectFileCandidate, "category">> = [];
  const directories: PendingDirectory[] = [];
  let visitedEntries = 0;
  const visit = () => {
    visitedEntries += 1;
    if (visitedEntries % 32 === 0) progress?.(visitedEntries);
  };
  for await (const [name, handle] of root.entries()) {
    visit();
    if (name.toLowerCase() === ".rustyera") continue;
    const relativePath = name.normalize("NFC");
    if (handle.kind === "directory") {
      topLevel.add(name.toLowerCase());
      directories.push({ handle, prefix: `${relativePath}/` });
    } else {
      rawFiles.push({ relativePath, handle });
    }
  }
  await walkProjectDirectories(
    directories,
    typeof navigator === "undefined" ? 1 : browserProjectDirectoryReadConcurrency(navigator),
    rawFiles,
    visit,
  );
  if (visitedEntries % 32 !== 0) progress?.(visitedEntries);
  const files = rawFiles.flatMap((file) => {
    const category = classify(file.relativePath, topLevel);
    return category ? [{ ...file, category }] : [];
  });
  const paths = new Set<string>();
  for (const file of files) {
    const identity = file.relativePath.toLowerCase();
    if (paths.has(identity)) throw new Error(`项目路径归一化冲突：${file.relativePath}`);
    paths.add(identity);
  }
  return { files, topLevel };
}

interface PendingDirectory {
  handle: FileSystemDirectoryHandle;
  prefix: string;
}

async function walkProjectDirectories(
  queue: PendingDirectory[],
  maximumConcurrency: number,
  output: Array<Omit<BrowserProjectFileCandidate, "category">>,
  visited: () => void,
): Promise<void> {
  if (queue.length === 0) return;
  let next = 0;
  let active = 0;
  let settled = false;
  let firstError: { value: unknown } | undefined;
  await new Promise<void>((resolve, reject) => {
    const finishIfComplete = () => {
      if (active !== 0) return false;
      settled = true;
      if (firstError) reject(firstError.value);
      else resolve();
      return true;
    };
    const schedule = () => {
      if (settled || firstError) {
        finishIfComplete();
        return;
      }
      while (active < maximumConcurrency && next < queue.length) {
        const directory = queue[next++]!;
        active += 1;
        void readProjectDirectory(directory, queue, output, visited).then(
          () => {
            active -= 1;
            if (firstError || next >= queue.length) finishIfComplete();
            if (!settled) schedule();
          },
          (error: unknown) => {
            active -= 1;
            firstError ??= { value: error };
            finishIfComplete();
          },
        );
      }
    };
    schedule();
  });
}

async function readProjectDirectory(
  directory: PendingDirectory,
  queue: PendingDirectory[],
  output: Array<Omit<BrowserProjectFileCandidate, "category">>,
  visited: () => void,
): Promise<void> {
  for await (const [name, handle] of directory.handle.entries()) {
    visited();
    if (name.toLowerCase() === ".rustyera") continue;
    const relativePath = `${directory.prefix}${name}`.normalize("NFC");
    if (handle.kind === "directory") queue.push({ handle, prefix: `${relativePath}/` });
    else output.push({ relativePath, handle });
  }
}
