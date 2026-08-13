import { classify } from "@/platform/browserProjectFilesystem";

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
): Promise<BrowserProjectEnumeration> {
  const topLevel = new Set<string>();
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "directory" && name.toLowerCase() !== ".rustyera") {
      topLevel.add(name.toLowerCase());
    }
  }
  const files: BrowserProjectFileCandidate[] = [];
  await walkProjectDirectory(root, "", topLevel, files);
  return { files, topLevel };
}

async function walkProjectDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  topLevel: Set<string>,
  output: BrowserProjectFileCandidate[],
): Promise<void> {
  for await (const [name, handle] of directory.entries()) {
    if (name.toLowerCase() === ".rustyera") continue;
    const relativePath = `${prefix}${name}`.normalize("NFC");
    if (handle.kind === "directory") {
      await walkProjectDirectory(handle, `${relativePath}/`, topLevel, output);
      continue;
    }
    const category = classify(relativePath, topLevel);
    if (category) output.push({ relativePath, category, handle });
  }
}
