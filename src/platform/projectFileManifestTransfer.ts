import type { BrowserManifest } from "@/platform/browserProject";
import { requireCompatibilityIdentity } from "@/core/compatibility";

const PROJECT_FILE_CATEGORIES = new Set([
  "csv",
  "erh",
  "erb",
  "resource_manifest",
  "resource",
  "configuration",
  "als",
  "erd",
]);
const PROJECT_FILE_IMAGE_FORMATS = ["bmp", "gif", "jpeg", "png", "webp"] as const;
type ProjectFileImageFormat = (typeof PROJECT_FILE_IMAGE_FORMATS)[number];

export function normalizeProjectFileManifest(manifest: unknown): BrowserManifest {
  const record = requireRecord(manifest, "项目文件清单");
  if (!Array.isArray(record.files)) throw new Error("项目文件清单 files 不是数组");
  return {
    project_revision: requireSafeInteger(record.project_revision, "项目文件清单 revision"),
    compatibility: requireCompatibilityIdentity(record.compatibility),
    files: record.files.map((value, index) => normalizeProjectFile(value, index)),
  };
}

function normalizeProjectFile(value: unknown, index: number): BrowserManifest["files"][number] {
  const file = requireRecord(value, `项目文件清单文件 ${index}`);
  if (typeof file.relative_path !== "string" || file.relative_path.length === 0)
    throw new Error(`项目文件清单文件 ${index} 缺少路径`);
  const context = `项目文件清单 ${file.relative_path}`;
  if (typeof file.category !== "string" || !PROJECT_FILE_CATEGORIES.has(file.category))
    throw new Error(`${context} 的类别无效`);
  return {
    relative_path: file.relative_path,
    category: file.category,
    payload: normalizeProjectFilePayload(file.payload, context),
    content_hash: requireBytes(file.content_hash, `${context} 的内容哈希`, 32),
  };
}

function normalizeProjectFilePayload(
  value: unknown,
  context: string,
): BrowserManifest["files"][number]["payload"] {
  const payload = requireRecord(value, `${context} 的 payload`);
  if (payload.type === "external_resource") {
    const descriptor = requireRecord(payload.value, `${context} 的外部资源描述`);
    const metadata = descriptor.image_metadata;
    return {
      type: "external" as const,
      byteLength: requireSafeInteger(descriptor.byte_length, `${context} 的资源长度`),
      imageMetadata: normalizeImageMetadata(metadata, context),
    };
  }
  if (payload.type === "bytes") {
    return {
      type: "bytes" as const,
      value: requireBytes(payload.value, `${context} 的二进制数据`),
    };
  }
  if (payload.type === "utf8") {
    if (typeof payload.value !== "string") throw new Error(`${context} 的文本 payload 无效`);
    return { type: "utf8" as const, value: payload.value };
  }
  throw new Error(`${context} 的 payload 类型无效：${String(payload.type)}`);
}

function normalizeImageMetadata(value: unknown, context: string) {
  if (value == null) return undefined;
  const metadata = requireRecord(value, `${context} 的图片元数据`);
  if (!isProjectFileImageFormat(metadata.format) || typeof metadata.animated !== "boolean")
    throw new Error(`${context} 的图片元数据无效`);
  return {
    width: requireSafeInteger(metadata.width, `${context} 的图片宽度`),
    height: requireSafeInteger(metadata.height, `${context} 的图片高度`),
    format: metadata.format,
    animated: metadata.animated,
  };
}

function isProjectFileImageFormat(value: unknown): value is ProjectFileImageFormat {
  return (PROJECT_FILE_IMAGE_FORMATS as readonly unknown[]).includes(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value))
    throw new Error(`${context} 不是对象`);
  return value as Record<string, unknown>;
}

function requireSafeInteger(value: unknown, context: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${context} 不是非负安全整数`);
  return number;
}

function requireBytes(value: unknown, context: string, expectedLength?: number): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = new Uint8Array(value);
  else if (
    Array.isArray(value) &&
    value.every(
      (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    bytes = Uint8Array.from(value);
  else throw new Error(`${context} 不是有效二进制数据`);
  if (expectedLength != null && bytes.byteLength !== expectedLength)
    throw new Error(`${context} 长度必须为 ${expectedLength} 字节`);
  return bytes;
}

export function projectFileManifestTransfers(manifest: BrowserManifest): ArrayBuffer[] {
  const transfers = new Set<ArrayBuffer>();
  for (const file of manifest.files) {
    if (file.category !== "resource" || file.payload.type !== "bytes") continue;
    const buffer = file.payload.value.buffer;
    if (buffer instanceof ArrayBuffer) transfers.add(buffer);
  }
  return [...transfers];
}

export function takeProjectFileManifestOwnership(manifest: BrowserManifest): BrowserManifest {
  const owned = structuredClone(manifest, { transfer: projectFileManifestTransfers(manifest) });
  for (const file of owned.files) {
    if (file.category !== "resource" || file.payload.type !== "bytes") continue;
    const value = file.payload.value;
    file.payload.value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return owned;
}

export function runtimeWorkerResultTransfers(method: string, result: unknown): ArrayBuffer[] {
  if (method === "pump" || method === "create") {
    return ((result as { events?: Array<{ dataBytes?: Uint8Array }> })?.events ?? [])
      .map((item) => item.dataBytes?.buffer)
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
  }
  return [];
}
