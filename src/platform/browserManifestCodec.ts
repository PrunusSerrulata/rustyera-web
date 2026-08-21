import type { BrowserManifest, ScannedFile } from "@/platform/browserProject";
import { yieldToMainThread } from "@/platform/mainThread";

const MAGIC = new TextEncoder().encode("RERMAN01");
const HEADER_BYTES = MAGIC.byteLength + 8 + 4;
const RECORD_HEADER_BYTES = 1 + 4 + 1 + 8 + 1;
const PREPARE_PROGRESS = 25;
const PROGRESS_TOTAL = 100;
const FILES_PER_YIELD = 128;
const BYTES_PER_YIELD = 1024 * 1024;
const EXTERNAL_DESCRIPTOR_BYTES = 18;
const CATEGORY_CODES: Record<string, number> = {
  csv: 0,
  erh: 1,
  erb: 2,
  resource_manifest: 3,
  resource: 4,
  configuration: 5,
};

interface EncodedFile {
  source: ScannedFile;
  path: Uint8Array;
  payloadBytes: number;
}

export interface StreamedBrowserManifestFile {
  source: ScannedFile;
  category: number;
  payloadTag: number;
  payload: Uint8Array;
  contentHash: Uint8Array;
}

export async function streamBrowserManifestFiles(
  manifest: BrowserManifest,
  append: (file: StreamedBrowserManifestFile) => Promise<void>,
  progress?: (completed: number, total: number) => void,
): Promise<void> {
  const encoder = new TextEncoder();
  progress?.(0, manifest.files.length);
  for (let index = 0; index < manifest.files.length; index += 1) {
    const source = manifest.files[index]!;
    const category = CATEGORY_CODES[source.category];
    if (category == null) throw new Error(`未知项目文件类别：${source.category}`);
    if (source.content_hash.byteLength !== 32) throw new Error("项目文件内容哈希必须为 32 字节");
    const payloadTag = source.payload.type === "utf8" ? 0 : source.payload.type === "bytes" ? 1 : 2;
    const payload =
      source.payload.type === "utf8"
        ? encoder.encode(source.payload.value)
        : source.payload.type === "bytes"
          ? source.payload.value
          : encodeExternalDescriptor(source.payload);
    await append({
      source,
      category,
      payloadTag,
      payload,
      // The manifest retains its identity after the transferred hash buffer is detached.
      contentHash: source.content_hash.slice(),
    });
    progress?.(index + 1, manifest.files.length);
    if ((index + 1) % FILES_PER_YIELD === 0) await yieldToMainThread();
  }
}

export async function encodeBrowserManifest(
  manifest: BrowserManifest,
  progress?: (completed: number, total: number) => void,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const report = progressReporter(progress);
  report(0);
  const encoded: EncodedFile[] = [];
  let totalBytes = HEADER_BYTES;
  let bytesSinceYield = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const source = manifest.files[index];
    const path = encoder.encode(source.relative_path);
    const payloadBytes =
      source.payload.type === "utf8"
        ? utf8ByteLength(source.payload.value)
        : source.payload.type === "bytes"
          ? source.payload.value.byteLength
          : EXTERNAL_DESCRIPTOR_BYTES;
    if (!(source.category in CATEGORY_CODES))
      throw new Error(`未知项目文件类别：${source.category}`);
    if (source.content_hash.byteLength !== 32) throw new Error("项目文件内容哈希必须为 32 字节");
    totalBytes = checkedAdd(
      totalBytes,
      RECORD_HEADER_BYTES + path.byteLength + payloadBytes + source.content_hash.byteLength,
    );
    encoded.push({ source, path, payloadBytes });
    bytesSinceYield += path.byteLength + payloadBytes;
    report(
      manifest.files.length === 0
        ? PREPARE_PROGRESS
        : Math.floor(((index + 1) * PREPARE_PROGRESS) / manifest.files.length),
    );
    if ((index + 1) % FILES_PER_YIELD === 0 || bytesSinceYield >= BYTES_PER_YIELD) {
      bytesSinceYield = 0;
      await yieldToMainThread();
    }
  }
  report(PREPARE_PROGRESS);

  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  output.set(MAGIC, 0);
  let offset = MAGIC.byteLength;
  view.setBigUint64(offset, BigInt(manifest.project_revision), true);
  offset += 8;
  view.setUint32(offset, encoded.length, true);
  offset += 4;
  const copyTotal = totalBytes - HEADER_BYTES;
  const copyState = { copied: 0, yieldedAt: 0 };
  for (let index = 0; index < encoded.length; index += 1) {
    const { source, path, payloadBytes } = encoded[index];
    view.setUint8(offset, CATEGORY_CODES[source.category]);
    offset += 1;
    view.setUint32(offset, path.byteLength, true);
    offset += 4;
    view.setUint8(
      offset,
      source.payload.type === "utf8" ? 0 : source.payload.type === "bytes" ? 1 : 2,
    );
    offset += 1;
    view.setBigUint64(offset, BigInt(payloadBytes), true);
    offset += 8;
    view.setUint8(offset, source.content_hash.byteLength);
    offset += 1;
    copyState.copied += RECORD_HEADER_BYTES;
    offset = await copyBytes(output, path, offset, copyState, copyTotal, report);
    if (source.payload.type === "utf8") {
      const target = output.subarray(offset, offset + payloadBytes);
      const result = encoder.encodeInto(source.payload.value, target);
      if (result.read !== source.payload.value.length || result.written !== payloadBytes) {
        throw new Error("项目文本 UTF-8 编码长度不一致");
      }
      offset += payloadBytes;
      copyState.copied += payloadBytes;
      reportCopyProgress(copyState.copied, copyTotal, report);
      if (copyState.copied - copyState.yieldedAt >= BYTES_PER_YIELD) {
        copyState.yieldedAt = copyState.copied;
        await yieldToMainThread();
      }
    } else if (source.payload.type === "bytes") {
      offset = await copyBytes(output, source.payload.value, offset, copyState, copyTotal, report);
    } else {
      const descriptor = encodeExternalDescriptor(source.payload);
      offset = await copyBytes(output, descriptor, offset, copyState, copyTotal, report);
    }
    offset = await copyBytes(output, source.content_hash, offset, copyState, copyTotal, report);
  }
  report(PROGRESS_TOTAL);
  return output;
}

function encodeExternalDescriptor(
  payload: Extract<ScannedFile["payload"], { type: "external" }>,
): Uint8Array {
  const result = new Uint8Array(EXTERNAL_DESCRIPTOR_BYTES);
  const view = new DataView(result.buffer);
  view.setBigUint64(0, BigInt(payload.byteLength), true);
  const metadata = payload.imageMetadata;
  if (!metadata) {
    view.setUint8(16, 0xff);
    return result;
  }
  if (
    !Number.isInteger(metadata.width) ||
    metadata.width <= 0 ||
    metadata.width > 0xffff_ffff ||
    !Number.isInteger(metadata.height) ||
    metadata.height <= 0 ||
    metadata.height > 0xffff_ffff
  )
    throw new Error("图片元数据尺寸无效");
  const format = { png: 0, bmp: 1, gif: 2, jpeg: 3, webp: 4 }[metadata.format];
  if (format === undefined) throw new Error("图片元数据格式无效");
  view.setUint32(8, metadata.width, true);
  view.setUint32(12, metadata.height, true);
  view.setUint8(16, format);
  view.setUint8(17, metadata.animated ? 1 : 0);
  return result;
}

async function copyBytes(
  output: Uint8Array,
  source: Uint8Array,
  outputOffset: number,
  state: { copied: number; yieldedAt: number },
  total: number,
  report: (completed: number) => void,
): Promise<number> {
  let sourceOffset = 0;
  while (sourceOffset < source.byteLength) {
    const untilYield = Math.max(1, BYTES_PER_YIELD - (state.copied - state.yieldedAt));
    const chunkLength = Math.min(source.byteLength - sourceOffset, untilYield);
    output.set(source.subarray(sourceOffset, sourceOffset + chunkLength), outputOffset);
    sourceOffset += chunkLength;
    outputOffset += chunkLength;
    state.copied += chunkLength;
    reportCopyProgress(state.copied, total, report);
    if (state.copied - state.yieldedAt >= BYTES_PER_YIELD) {
      state.yieldedAt = state.copied;
      await yieldToMainThread();
    }
  }
  return outputOffset;
}

function reportCopyProgress(
  totalCopied: number,
  total: number,
  report: (completed: number) => void,
) {
  report(
    PREPARE_PROGRESS +
      (total === 0
        ? PROGRESS_TOTAL - PREPARE_PROGRESS
        : Math.floor((totalCopied * (PROGRESS_TOTAL - PREPARE_PROGRESS)) / total)),
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function progressReporter(
  progress: ((completed: number, total: number) => void) | undefined,
): (completed: number) => void {
  let last = -1;
  return (completed) => {
    const bounded = Math.max(0, Math.min(PROGRESS_TOTAL, completed));
    if (bounded <= last) return;
    last = bounded;
    progress?.(bounded, PROGRESS_TOTAL);
  };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("项目 manifest 太大，无法编码");
  return result;
}
