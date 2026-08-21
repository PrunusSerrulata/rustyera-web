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
  return pickRetainedFiles(options).then((selection) => {
    if (!selection) return undefined;
    selection.release();
    return selection.files;
  });
}

export interface RetainedFileSelection {
  files: File[];
  release(): void;
}

export function pickRetainedFiles(options: {
  accept?: string;
  directory?: boolean;
  multiple?: boolean;
}): Promise<RetainedFileSelection | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? false;
    input.webkitdirectory = options.directory ?? false;
    if (options.accept) input.accept = options.accept;
    input.hidden = true;
    let state: "selecting" | "retained" | "settled" = "selecting";
    const release = () => {
      if (state === "settled") return;
      state = "settled";
      input.remove();
    };
    const finish = (files?: File[]) => {
      if (state !== "selecting") return;
      if (!files?.length) {
        release();
        resolve(undefined);
        return;
      }
      state = "retained";
      resolve({ files, release });
    };
    input.addEventListener("change", () =>
      finish(input.files?.length ? [...input.files] : undefined),
    );
    input.addEventListener("cancel", () => finish());
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      release();
      reject(error);
    }
  });
}

export function pickFileBytes(accept?: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.hidden = true;
    let state: "selecting" | "reading" | "settled" = "selecting";
    const cleanup = () => {
      state = "settled";
      input.remove();
    };
    const finish = (result: Uint8Array | undefined) => {
      if (state === "settled") return;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (state === "settled") return;
      cleanup();
      reject(error);
    };
    input.addEventListener("change", () => {
      if (state !== "selecting") return;
      const file = input.files?.[0];
      if (!file) {
        finish(undefined);
        return;
      }
      state = "reading";
      // iOS File values may be backed by security-scoped document-provider resources. Keep their
      // owning picker control alive until WebKit has finished reading the resource.
      try {
        void file.arrayBuffer().then((bytes) => finish(new Uint8Array(bytes)), fail);
      } catch (error) {
        fail(error);
      }
    });
    input.addEventListener("cancel", () => {
      if (state === "selecting") finish(undefined);
    });
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

export function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
