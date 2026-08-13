export interface PortableDirectoryNode {
  readonly directories: Map<string, PortableDirectoryNode>;
  readonly files: Map<string, File>;
}

function directoryNode(): PortableDirectoryNode {
  return { directories: new Map(), files: new Map() };
}

export function portableDirectoryTree(
  files: readonly { path: string; file: File }[],
): PortableDirectoryNode {
  const root = directoryNode();
  for (const { path, file } of files) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.get(part);
      if (!child) {
        child = directoryNode();
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.set(parts.at(-1)!, file);
  }
  return root;
}
