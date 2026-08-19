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

const PROJECT_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ProjectFileReadOptions {
  chunkBytes?: number;
  preferSynchronousReader?: boolean;
}

export async function loadProjectFileInWorker(
  runtime: ProjectFileUploadRuntime,
  file: File,
  report: (progress: ProjectFileReadProgress) => void,
  options: ProjectFileReadOptions = {},
  yieldTurn: () => Promise<void> = yieldWorkerTurn,
): Promise<unknown> {
  if (!Number.isSafeInteger(file.size) || file.size > 0xffff_ffff) {
    throw new Error("项目文件大小超出浏览器可处理范围。");
  }
  const chunkBytes = options.chunkBytes ?? PROJECT_FILE_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("项目文件分块大小无效。");
  }
  runtime.beginProjectFile(file.size);
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const end = Math.min(file.size, offset + chunkBytes);
      const bytes = new Uint8Array(
        await readBlob(file.slice(offset, end), options.preferSynchronousReader ?? false),
      );
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

function readBlob(blob: Blob, preferSynchronousReader: boolean): Promise<ArrayBuffer> {
  const SyncReader = (
    globalThis as typeof globalThis & {
      FileReaderSync?: new () => { readAsArrayBuffer(value: Blob): ArrayBuffer };
    }
  ).FileReaderSync;
  if (preferSynchronousReader && SyncReader)
    return Promise.resolve(new SyncReader().readAsArrayBuffer(blob));
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
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
