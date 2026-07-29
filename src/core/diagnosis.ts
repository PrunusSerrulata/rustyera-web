export interface DiagnosisArchiveInput {
  projectName: string;
  snapshot: Uint8Array;
  logs: string;
  compiledArtifact: Uint8Array;
  exportedAt: Date;
}

const TAR_BLOCK_BYTES = 512;
const ZSTD_BLOCK_BYTES = 128 * 1024;
const encoder = new TextEncoder();

export function diagnosisArchiveName(projectName: string, now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  return `${projectName || "project"}-diagnosis_${stamp}.tar.zst`;
}

export function createDiagnosisArchive(input: DiagnosisArchiveInput): Uint8Array {
  const timestamp = Math.floor(input.exportedAt.getTime() / 1000);
  const tar = concatenate([
    tarMember("runtime.snapshot", input.snapshot, timestamp),
    tarMember("runtime.log", encoder.encode(input.logs), timestamp),
    tarMember(`${input.projectName}-compiled-project.bin.zst`, input.compiledArtifact, timestamp),
    new Uint8Array(TAR_BLOCK_BYTES * 2),
  ]);
  return encodeRawZstdFrame(tar);
}

function tarMember(name: string, payload: Uint8Array, timestamp: number): Uint8Array {
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 100 || nameBytes.some((byte) => byte > 0x7f)) {
    const pathRecord = paxRecord("path", name);
    return concatenate([
      basicTarMember("././@PaxHeader", pathRecord, timestamp, 0x78),
      basicTarMember("PaxPayload", payload, timestamp, 0x30),
    ]);
  }
  return basicTarMember(name, payload, timestamp, 0x30);
}

function basicTarMember(
  name: string,
  payload: Uint8Array,
  timestamp: number,
  type: number,
): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const nameBytes = encoder.encode(name);
  header.set(nameBytes, 0);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, payload.length);
  writeOctal(header, 136, 12, timestamp);
  header.fill(0x20, 148, 156);
  header[156] = type;
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeChecksum(header, checksum);
  const padding = (TAR_BLOCK_BYTES - (payload.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
  return concatenate([header, payload, new Uint8Array(padding)]);
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = `${key}=${value}\n`;
  let length = encoder.encode(`0 ${body}`).length;
  while (true) {
    const record = encoder.encode(`${length} ${body}`);
    if (record.length === length) return record;
    length = record.length;
  }
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number): void {
  const encoded = encoder.encode(
    Math.max(0, value)
      .toString(8)
      .padStart(width - 1, "0"),
  );
  target.set(encoded.slice(-(width - 1)), offset);
  target[offset + width - 1] = 0;
}

function writeChecksum(target: Uint8Array, value: number): void {
  const encoded = encoder.encode(value.toString(8).padStart(6, "0"));
  target.set(encoded.slice(-6), 148);
  target[154] = 0;
  target[155] = 0x20;
}

// A standards-compliant Zstandard frame may contain raw blocks. This keeps archive creation
// dependency-free and fast while the snapshot and compiler artifact remain compressed inside.
function encodeRawZstdFrame(input: Uint8Array): Uint8Array {
  if (input.length > 0xffff_ffff) throw new Error("诊断归档超过 Zstandard 单帧大小限制");
  const blockCount = Math.max(1, Math.ceil(input.length / ZSTD_BLOCK_BYTES));
  const output = new Uint8Array(4 + 1 + 4 + blockCount * 3 + input.length);
  output.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0], 0);
  const view = new DataView(output.buffer);
  view.setUint32(5, input.length, true);
  let sourceOffset = 0;
  let outputOffset = 9;
  for (let index = 0; index < blockCount; index += 1) {
    const length = Math.min(ZSTD_BLOCK_BYTES, input.length - sourceOffset);
    const last = index === blockCount - 1 ? 1 : 0;
    const header = (length << 3) | last;
    output[outputOffset] = header & 0xff;
    output[outputOffset + 1] = (header >>> 8) & 0xff;
    output[outputOffset + 2] = (header >>> 16) & 0xff;
    outputOffset += 3;
    output.set(input.subarray(sourceOffset, sourceOffset + length), outputOffset);
    sourceOffset += length;
    outputOffset += length;
  }
  return output;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
