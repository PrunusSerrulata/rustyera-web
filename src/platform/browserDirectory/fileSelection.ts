import { safePath } from "@/platform/browserProjectFilesystem";

export function fileSnapshot(source: File, bytes: Uint8Array): File {
  const snapshot = new Uint8Array(bytes);
  return {
    name: source.name,
    type: source.type,
    size: snapshot.byteLength,
    lastModified: source.lastModified,
    arrayBuffer: async () => snapshot.buffer.slice(0),
  } as File;
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
    const path = safePath(parts.join("/"));
    if (!path) throw new Error("项目文件路径不能为空。");
    return { path, file };
  });
  const uniquePaths = new Set(normalized.map(({ path }) => path));
  if (uniquePaths.size !== normalized.length) {
    throw new Error("所选目录包含重复的项目文件路径。");
  }
  return { projectName: root, files: normalized };
}

export function pickFiles(options: {
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

export function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
