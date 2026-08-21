export interface ProjectFileUploadRuntime {
  beginProjectFile(totalBytes: number): void;
  appendProjectFile(bytes: Uint8Array): void;
  finishProjectFile(): unknown;
  cancelProjectFile(): void;
}

export interface ProjectFileReadProgress {
  stage: "scanning";
  completed: number;
  total: number;
}

const WORKER_PROJECT_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BROWSER_PROJECT_FILE_BYTES = 0xffff_ffff;

export interface ProjectFileReadOptions {
  chunkBytes?: number;
}

export async function loadProjectFileInWorker(
  runtime: ProjectFileUploadRuntime,
  file: File,
  report: (progress: ProjectFileReadProgress) => void,
  options: ProjectFileReadOptions = {},
  yieldTurn: () => Promise<void> = yieldWorkerTurn,
): Promise<unknown> {
  validateBrowserProjectFileSize(file.size);
  const chunkBytes = options.chunkBytes ?? WORKER_PROJECT_FILE_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("项目文件分块大小无效。");
  }
  runtime.beginProjectFile(file.size);
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const end = Math.min(file.size, offset + chunkBytes);
      const bytes = new Uint8Array(await readBlob(file.slice(offset, end)));
      runtime.appendProjectFile(bytes);
      report({ stage: "scanning", completed: end, total: file.size });
      await yieldTurn();
    }
    return runtime.finishProjectFile();
  } catch (error) {
    runtime.cancelProjectFile();
    throw error;
  }
}

export function validateBrowserProjectFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAXIMUM_BROWSER_PROJECT_FILE_BYTES) {
    throw new Error("项目文件大小超出浏览器可处理范围。");
  }
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  // Disk-backed files selected on constrained browsers can be large. Keep this asynchronous so a
  // second buffer is not materialized synchronously while the same Worker owns Runtime/WASM.
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  const SyncReader = (
    globalThis as typeof globalThis & {
      FileReaderSync?: new () => { readAsArrayBuffer(value: Blob): ArrayBuffer };
    }
  ).FileReaderSync;
  if (SyncReader) return Promise.resolve(new SyncReader().readAsArrayBuffer(blob));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("项目文件读取失败"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("项目文件读取结果不是二进制数据"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function yieldWorkerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
