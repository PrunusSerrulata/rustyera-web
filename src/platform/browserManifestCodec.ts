import type { BrowserManifest, ScannedFile } from "@/platform/browserProject";

const MAGIC = new TextEncoder().encode("RERMAN01");
const HEADER_BYTES = MAGIC.byteLength + 8 + 4;
const RECORD_HEADER_BYTES = 1 + 4 + 1 + 8 + 1;
const PREPARE_PROGRESS = 25;
const PROGRESS_TOTAL = 100;
const FILES_PER_YIELD = 128;
const BYTES_PER_YIELD = 1024 * 1024;
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
  payload: Uint8Array;
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
    const payload =
      source.payload.type === "utf8" ? encoder.encode(source.payload.value) : source.payload.value;
    if (!(source.category in CATEGORY_CODES))
      throw new Error(`未知项目文件类别：${source.category}`);
    if (source.content_hash.byteLength !== 32) throw new Error("项目文件内容哈希必须为 32 字节");
    totalBytes = checkedAdd(
      totalBytes,
      RECORD_HEADER_BYTES + path.byteLength + payload.byteLength + source.content_hash.byteLength,
    );
    encoded.push({ source, path, payload });
    bytesSinceYield += path.byteLength + payload.byteLength;
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
    const { source, path, payload } = encoded[index];
    view.setUint8(offset, CATEGORY_CODES[source.category]);
    offset += 1;
    view.setUint32(offset, path.byteLength, true);
    offset += 4;
    view.setUint8(offset, source.payload.type === "utf8" ? 0 : 1);
    offset += 1;
    view.setBigUint64(offset, BigInt(payload.byteLength), true);
    offset += 8;
    view.setUint8(offset, source.content_hash.byteLength);
    offset += 1;
    copyState.copied += RECORD_HEADER_BYTES;
    offset = await copyBytes(output, path, offset, copyState, copyTotal, report);
    offset = await copyBytes(output, payload, offset, copyState, copyTotal, report);
    offset = await copyBytes(output, source.content_hash, offset, copyState, copyTotal, report);
  }
  report(PROGRESS_TOTAL);
  return output;
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
    report(
      PREPARE_PROGRESS +
        (total === 0
          ? PROGRESS_TOTAL - PREPARE_PROGRESS
          : Math.floor((state.copied * (PROGRESS_TOTAL - PREPARE_PROGRESS)) / total)),
    );
    if (state.copied - state.yieldedAt >= BYTES_PER_YIELD) {
      state.yieldedAt = state.copied;
      await yieldToMainThread();
    }
  }
  return outputOffset;
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

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("项目 manifest 太大，无法编码");
  return result;
}
