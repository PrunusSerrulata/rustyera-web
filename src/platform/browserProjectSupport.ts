import { blake3 } from "@noble/hashes/blake3.js";
import { equalBytes, normalizeLineEndings } from "@/platform/browserProjectFilesystem";
import { runBounded } from "@/platform/browserProjectUtilities";
import type {
  BrowserManifest,
  BrowserProjectScanMetrics,
  FileScanProgress,
} from "@/platform/browserProject";
import type { ScannedFile } from "@/platform/browserProjectScanner";

interface BrowserProjectFilePrefetch {
  files: Promise<File>[];
  completed: Promise<void>;
}

export function runtimeReloadChange(change: any): any {
  return change.type === "upsert" ? runtimeReloadUpsert(change.file) : change;
}

export function prefetchBrowserProjectFiles(
  candidates: readonly { handle: FileSystemFileHandle }[],
  maximumConcurrency: number,
  loaded: (index: number, file: File, completed: number) => void,
): BrowserProjectFilePrefetch {
  const deferred = candidates.map(() => deferredFile());
  let loadedCount = 0;
  const completed = runBounded(
    candidates.map((candidate, index) => async () => {
      try {
        const file = await candidate.handle.getFile();
        deferred[index]!.resolve(file);
        loaded(index, file, ++loadedCount);
      } catch (error) {
        deferred[index]!.reject(error);
        throw error;
      }
    }),
    maximumConcurrency,
  );
  // The scan consumes every individual rejection. Keep the aggregate promise observed while the
  // scan is still running, then await it explicitly before committing the snapshot.
  void completed.catch(() => undefined);
  return { files: deferred.map(({ promise }) => promise), completed };
}

function deferredFile(): {
  promise: Promise<File>;
  resolve: (file: File) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (file: File) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<File>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export function runtimeReloadUpsert(file: ScannedFile): any {
  return {
    type: "upsert",
    file: {
      ...file,
      payload:
        file.payload.type === "bytes"
          ? { type: "bytes", value: [...file.payload.value] }
          : file.payload.type === "external"
            ? {
                type: "external_resource",
                value: {
                  byte_length: file.payload.byteLength,
                  image_metadata: file.payload.imageMetadata
                    ? {
                        width: file.payload.imageMetadata.width,
                        height: file.payload.imageMetadata.height,
                        format: file.payload.imageMetadata.format,
                        animated: file.payload.imageMetadata.animated,
                      }
                    : null,
                },
              }
            : file.payload,
      content_hash: [...file.content_hash],
    },
  };
}

export async function applyProjectFileUpdate(
  handle: FileSystemFileHandle,
  expectedSize: number,
  expectedDigest: Uint8Array,
  update: Uint8Array,
): Promise<void> {
  if (update.byteLength < 8) throw new Error("Runtime 返回了无效的项目配置更新");
  const truncate = Number(new DataView(update.buffer, update.byteOffset, 8).getBigUint64(0, true));
  if (!Number.isSafeInteger(truncate) || truncate < 0 || truncate > expectedSize)
    throw new Error("Runtime 返回了无效的项目配置更新位置");
  const current = await handle.getFile();
  if (
    current.size !== expectedSize ||
    !equalBytes(blake3(new Uint8Array(await current.arrayBuffer())), expectedDigest)
  )
    throw new Error("项目文件已被其他程序修改，请重试");
  const writer = await handle.createWritable({ keepExistingData: true });
  try {
    await writer.truncate(truncate);
    await writer.seek(truncate);
    await writer.write(update.subarray(8) as FileSystemWriteChunkType);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

export async function readFileInChunks(
  file: File,
  progress?: FileScanProgress,
): Promise<Uint8Array> {
  progress?.(0, file.size);
  if (file.size === 0) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    progress?.(bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  const bytes = new Uint8Array(file.size);
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    bytes.set(chunk, offset);
    progress?.(Math.min(offset + chunk.byteLength, file.size), file.size);
  }
  return bytes;
}

export function checkedSaveSlotCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("存档槽位数量无效");
  return value;
}

export function cacheIdentityManifest(manifest: BrowserManifest): BrowserManifest {
  return {
    project_revision: manifest.project_revision,
    compatibility: manifest.compatibility,
    files: manifest.files.map((file) => ({
      ...file,
      payload: identityPayload(file),
    })),
  };
}

export function identityPayload(file: ScannedFile): ScannedFile["payload"] {
  if (file.relative_path.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml")
    return file.payload;
  return file.category === "resource"
    ? file.payload.type === "external"
      ? file.payload
      : {
          type: "external",
          byteLength: payloadByteLength(file.payload),
        }
    : { type: "utf8", value: "" };
}

export function payloadByteLength(payload: ScannedFile["payload"]): number {
  if (payload.type === "external") return payload.byteLength;
  if (payload.type === "bytes") return payload.value.byteLength;
  return new TextEncoder().encode(payload.value).byteLength;
}

export function emptyPayload(
  category: string,
  byteLength = 0,
  imageMetadata?: Extract<ScannedFile["payload"], { type: "external" }>["imageMetadata"],
): ScannedFile["payload"] {
  return category === "resource"
    ? { type: "external", byteLength, imageMetadata }
    : { type: "utf8", value: "" };
}

export function emptyScanMetrics(): BrowserProjectScanMetrics {
  return {
    enumerateMs: 0,
    indexReadMs: 0,
    indexWriteMs: 0,
    statMs: 0,
    sourceReadDecodeHashMs: 0,
    sourceIndexPresent: false,
    sourceIndexTrusted: false,
    sourceIndexReusedFiles: 0,
    sourceIndexHashedFiles: 0,
  };
}

export function compareScannedFiles(left: ScannedFile, right: ScannedFile): number {
  return comparePaths(left.relative_path, right.relative_path);
}

export function projectCategoryCode(category: string): number {
  const code = {
    csv: 0,
    erh: 1,
    erb: 2,
    resource_manifest: 3,
    resource: 4,
    configuration: 5,
    als: 6,
    erd: 7,
  }[category];
  if (code == null) throw new Error(`未知项目文件类别：${category}`);
  return code;
}

export function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const header = cborHead(3, encoded.byteLength);
  const result = new Uint8Array(header.byteLength + encoded.byteLength);
  result.set(header);
  result.set(encoded, header.byteLength);
  return result;
}

export function cborHead(major: number, value: number | bigint): Uint8Array {
  const integer = BigInt(value);
  if (integer < 0n) throw new Error("CBOR length cannot be negative");
  if (integer < 24n) return Uint8Array.of((major << 5) | Number(integer));
  if (integer <= 0xffn) return Uint8Array.of((major << 5) | 24, Number(integer));
  const bytes = integer <= 0xffffn ? 2 : integer <= 0xffff_ffffn ? 4 : 8;
  const result = new Uint8Array(1 + bytes);
  result[0] = (major << 5) | (bytes === 2 ? 25 : bytes === 4 ? 26 : 27);
  const view = new DataView(result.buffer);
  if (bytes === 2) view.setUint16(1, Number(integer));
  else if (bytes === 4) view.setUint32(1, Number(integer));
  else view.setBigUint64(1, integer);
  return result;
}

export function comparePaths(left: string, right: string): number {
  return (
    compareCodePoints(left.toLowerCase(), right.toLowerCase()) || compareCodePoints(left, right)
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftItem = leftPoints.next();
    const rightItem = rightPoints.next();
    if (leftItem.done || rightItem.done) {
      if (leftItem.done === rightItem.done) return 0;
      return leftItem.done ? -1 : 1;
    }
    const leftPoint = leftItem.value.codePointAt(0)!;
    const rightPoint = rightItem.value.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

export function equalStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function projectConfigurationDigest(manifest: BrowserManifest): Uint8Array | null {
  const config = manifest.files.find(
    (file) => file.relative_path.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml",
  );
  if (!config) return null;
  if (config.payload.type !== "utf8") throw new Error("项目根配置不是完整 UTF-8 文本");
  return blake3(
    new TextEncoder().encode(normalizeLineEndings(config.payload.value.replace(/^\uFEFF+/, ""))),
  );
}
