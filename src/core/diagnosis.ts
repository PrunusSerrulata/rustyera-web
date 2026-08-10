export interface DiagnosisArchiveInput {
  projectName: string;
  snapshot: Uint8Array;
  logs: string;
  projectFile: Uint8Array;
  exportedAt: Date;
}

const TAR_BLOCK_BYTES = 512;
const ZSTD_BLOCK_BYTES = 128 * 1024;
const INVALID_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');
const encoder = new TextEncoder();

export function diagnosisArchiveName(projectName: string, now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  return `${diagnosisProjectName(projectName)}-diagnosis_${stamp}.tar.zst`;
}

export function diagnosisProjectName(projectName: string): string {
  const sanitized = [...projectName.trim()]
    .map((character) =>
      INVALID_FILENAME_CHARACTERS.has(character) || character.codePointAt(0)! < 32
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, "");
  return sanitized || "project";
}

export function createDiagnosisArchive(input: DiagnosisArchiveInput): Uint8Array {
  return concatenate([...diagnosisArchiveChunks(input)]);
}

export function* diagnosisArchiveChunks(input: DiagnosisArchiveInput): Generator<Uint8Array> {
  const timestamp = Math.floor(input.exportedAt.getTime() / 1000);
  const projectName = diagnosisProjectName(input.projectName);
  const tarParts = [
    ...tarMemberParts("runtime.snapshot", input.snapshot, timestamp),
    ...tarMemberParts("runtime.log", encoder.encode(input.logs), timestamp),
    ...tarMemberParts(`${projectName}.reraproj`, input.projectFile, timestamp),
    new Uint8Array(TAR_BLOCK_BYTES * 2),
  ];
  const contentSize = tarParts.reduce((total, part) => total + part.length, 0);
  if (contentSize > 0xffff_ffff) throw new Error("诊断归档超过 Zstandard 单帧大小限制");

  const frameHeader = new Uint8Array(9);
  frameHeader.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0], 0);
  new DataView(frameHeader.buffer).setUint32(5, contentSize, true);
  yield frameHeader;

  let remaining = contentSize;
  for (const part of tarParts) {
    for (let offset = 0; offset < part.length; offset += ZSTD_BLOCK_BYTES) {
      const payload = part.subarray(offset, offset + ZSTD_BLOCK_BYTES);
      remaining -= payload.length;
      const output = new Uint8Array(3 + payload.length);
      const header = (payload.length << 3) | (remaining === 0 ? 1 : 0);
      output[0] = header & 0xff;
      output[1] = (header >>> 8) & 0xff;
      output[2] = (header >>> 16) & 0xff;
      output.set(payload, 3);
      yield output;
    }
  }
}

function tarMemberParts(name: string, payload: Uint8Array, timestamp: number): Uint8Array[] {
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 100 || nameBytes.some((byte) => byte > 0x7f)) {
    const pathRecord = paxRecord("path", name);
    return [
      ...basicTarMemberParts("././@PaxHeader", pathRecord, timestamp, 0x78),
      ...basicTarMemberParts("PaxPayload", payload, timestamp, 0x30),
    ];
  }
  return basicTarMemberParts(name, payload, timestamp, 0x30);
}

function basicTarMemberParts(
  name: string,
  payload: Uint8Array,
  timestamp: number,
  type: number,
): Uint8Array[] {
  const header = tarHeader(name, payload.length, timestamp, type);
  const padding = (TAR_BLOCK_BYTES - (payload.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
  return padding === 0 ? [header, payload] : [header, payload, new Uint8Array(padding)];
}

function tarHeader(
  name: string,
  payloadLength: number,
  timestamp: number,
  type: number,
): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  const nameBytes = encoder.encode(name);
  header.set(nameBytes, 0);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, payloadLength);
  writeOctal(header, 136, 12, timestamp);
  header.fill(0x20, 148, 156);
  header[156] = type;
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeChecksum(header, checksum);
  return header;
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

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
