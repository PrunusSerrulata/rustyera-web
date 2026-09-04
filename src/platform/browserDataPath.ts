/** Snake Data names share Resource's NFC + Unicode lowercase identity, not host spelling. */
export async function resolveNormalizedDataPath(
  root: FileSystemDirectoryHandle,
  parts: string[],
  directoryTarget: boolean,
): Promise<{ parts: string[]; found: boolean }> {
  try {
    const normalized = parts.map((part) => part.normalize("NFC"));
    validateNormalizedDataPath(normalized);
    if (!normalized.length && !directoryTarget) throw invalid("文件路径不能为空");
    let directory = root;
    const ancestors = [root];
    const actual: string[] = [];
    let visited = 0;
    let pathBytes = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      const names = new Set<string>();
      let selected: [string, FileSystemFileHandle | FileSystemDirectoryHandle] | undefined;
      try {
        for await (const [name, handle] of directory.entries()) {
          const canonical = validateStorageBasename(name);
          validateNormalizedDataPath([...actual, canonical]);
          pathBytes += new TextEncoder().encode([...actual, canonical].join("/")).length;
          if (++visited > 100_000 || pathBytes > 8 * 1024 * 1024)
            throw invalid("存储路径查找超过扫描限额");
          const key = canonical.toLowerCase();
          if (names.has(key)) throw invalid("存储目录包含重复规范名称");
          names.add(key);
          if (key === normalized[index].toLowerCase()) selected = [name, handle];
        }
      } catch (error) {
        throw storageTraversalError(error);
      }
      if (!selected) {
        const result = [...actual, ...normalized.slice(index)];
        validateNormalizedDataPath(result);
        return { parts: result, found: false };
      }
      const [name, handle] = selected;
      actual.push(name);
      if (root.resolve && (await root.resolve(handle)) === null)
        throw new DOMException("存储路径逃逸项目授权目录", "NotAllowedError");
      const requiresDirectory = index < normalized.length - 1 || directoryTarget;
      if ((handle.kind === "directory") !== requiresDirectory)
        throw invalid("存储路径组件类型不匹配");
      if (handle.kind === "directory") {
        for (const ancestor of ancestors) {
          if (handle === ancestor || (handle.isSameEntry && (await handle.isSameEntry(ancestor))))
            throw invalid("存储路径包含目录循环链接");
        }
        ancestors.push(handle);
        directory = handle;
      }
    }
    return { parts: actual, found: true };
  } catch (error) {
    throw storageTraversalError(error);
  }
}

export function validateNormalizedDataPath(parts: string[]): void {
  if (parts.length > 256 || new TextEncoder().encode(parts.join("/")).length > 4096)
    throw invalid("存储路径超过限额");
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || /[\\/\0]/.test(part) || /^[A-Za-z]:/.test(part),
    )
  )
    throw invalid("存储目录包含无效路径");
}

function invalid(message: string): DOMException {
  return new DOMException(message, "DataError");
}

/** A real basename is never a path to normalize or split. */
export function validateStorageBasename(name: string): string {
  validateNormalizedDataPath([name]);
  return name.normalize("NFC");
}

export function storageTraversalError(error: unknown): unknown {
  return error instanceof DOMException && error.name === "NotFoundError"
    ? new DOMException("存储目录项在枚举期间消失或包含失效链接", "InvalidModificationError")
    : error;
}
