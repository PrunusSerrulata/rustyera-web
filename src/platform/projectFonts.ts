import { blake3 } from "@noble/hashes/blake3.js";
import {
  checkedAdd,
  checkedMultiply,
  decodeUtf16Be,
  requireRange,
  requireSubrange,
} from "@/platform/projectFonts/bounds";

import type { ProjectFontLoadResult } from "@/core/types";

export interface ProjectFontSource {
  relativePath: string;
  contentHash: Uint8Array;
  read(): Promise<Uint8Array>;
}

interface ParsedProjectFont {
  families: string[];
  descriptors: FontFaceDescriptors;
}

interface TableRange {
  start: number;
  end: number;
}

const REGISTERED_FONT_SUFFIXES = new Set(["otf", "ttf"]);
const PACKAGED_FONT_SUFFIXES = new Set(["otf", "ttc", "ttf", "woff", "woff2"]);
const SFNT_SIGNATURES = new Set([0x0001_0000, 0x4f54_544f, 0x7472_7565, 0x7479_7031]);
const MAXIMUM_PROJECT_FONT_FILES = 32;
const MAXIMUM_FONT_ALIASES = 8;
const MAXIMUM_REGISTERED_FACES = 64;
const NAME_TAG = 0x6e61_6d65;
const OS2_TAG = 0x4f53_2f32;

export class ProjectFontRegistry {
  private active = new Set<FontFace>();

  async replace(sources: ProjectFontSource[]): Promise<ProjectFontLoadResult> {
    const errors: string[] = [];
    const candidates: Array<{ face: FontFace; family: string; relativePath: string }> = [];
    if (sources.length > MAXIMUM_PROJECT_FONT_FILES) {
      errors.push(
        `项目字体文件超过 ${MAXIMUM_PROJECT_FONT_FILES} 个，仅加载排序后的前 ${MAXIMUM_PROJECT_FONT_FILES} 个`,
      );
    }
    if (sources.length > 0 && (typeof FontFace !== "function" || !document.fonts)) {
      errors.push("当前 WebView 不支持加载项目字体");
    } else {
      for (const source of sources.slice(0, MAXIMUM_PROJECT_FONT_FILES)) {
        if (candidates.length >= MAXIMUM_REGISTERED_FACES) {
          errors.push(`项目字体别名超过 ${MAXIMUM_REGISTERED_FACES} 个，其余别名未加载`);
          break;
        }
        await prepareSource(source, candidates, errors);
      }
    }

    for (const face of this.active) {
      try {
        document.fonts.delete(face);
      } catch (error) {
        errors.push(`无法卸载旧项目字体：${errorMessage(error)}`);
      }
    }
    const active = new Set<FontFace>();
    const families = new Map<string, string>();
    for (const candidate of candidates) {
      try {
        document.fonts.add(candidate.face);
        active.add(candidate.face);
        const key = candidate.family.toLowerCase();
        if (!families.has(key)) families.set(key, candidate.family);
      } catch (error) {
        errors.push(
          `${candidate.relativePath}（${candidate.family}）：无法注册字体：${errorMessage(error)}`,
        );
      }
    }
    this.active = active;
    return {
      fonts: [...families.values()].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
      ),
      errors,
    };
  }

  clear(): void {
    for (const face of this.active) {
      try {
        document.fonts.delete(face);
      } catch {
        // Host shutdown must continue even if the WebView has already detached its FontFaceSet.
      }
    }
    this.active.clear();
  }
}

export function isPackagedProjectFontPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const suffix = parts.at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  return parts[0]?.toLowerCase() === "font" && PACKAGED_FONT_SUFFIXES.has(suffix);
}

export function parseProjectFont(bytes: Uint8Array): ParsedProjectFont {
  if (bytes.byteLength < 12) throw new Error("字体文件过短");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) === 0x7474_6366) throw new Error("暂不支持加载 TTC 字体集合");
  if (!SFNT_SIGNATURES.has(view.getUint32(0))) throw new Error("不是受支持的 TTF/OTF 字体");
  const tables = sfntTables(view);
  const name = tables.get(NAME_TAG);
  if (!name) throw new Error("字体缺少 name 表");
  const families = nameTableFamilies(view, name);
  if (families.length === 0) throw new Error("字体 name 表不包含可用 family 名称");
  return { families, descriptors: fontFaceDescriptors(view, tables.get(OS2_TAG)) };
}

async function prepareSource(
  source: ProjectFontSource,
  candidates: Array<{ face: FontFace; family: string; relativePath: string }>,
  errors: string[],
): Promise<void> {
  try {
    const suffix = source.relativePath.split(".").at(-1)?.toLowerCase() ?? "";
    if (!REGISTERED_FONT_SUFFIXES.has(suffix)) {
      errors.push(`${source.relativePath}：该字体格式会打包，但当前 WebView 暂不支持项目内加载`);
      return;
    }
    const bytes = await source.read();
    if (!equalBytes(blake3(bytes), source.contentHash)) {
      errors.push(`${source.relativePath}：字体在项目扫描后发生变化，未加载`);
      return;
    }
    const parsed = parseProjectFont(bytes);
    const aliases = parsed.families.slice(0, MAXIMUM_FONT_ALIASES);
    if (parsed.families.length > aliases.length)
      errors.push(
        `${source.relativePath}：字体别名超过 ${MAXIMUM_FONT_ALIASES} 个，其余别名未加载`,
      );
    const buffer = exactArrayBuffer(bytes);
    for (const family of aliases) {
      if (candidates.length >= MAXIMUM_REGISTERED_FACES) return;
      try {
        const face = new FontFace(family, buffer, parsed.descriptors);
        await face.load();
        candidates.push({ face, family, relativePath: source.relativePath });
      } catch (error) {
        errors.push(`${source.relativePath}（${family}）：${errorMessage(error)}`);
      }
    }
  } catch (error) {
    errors.push(`${source.relativePath}：${errorMessage(error)}`);
  }
}

function sfntTables(view: DataView): Map<number, TableRange> {
  const tableCount = view.getUint16(4);
  if (tableCount > 4_096) throw new Error("字体表数量无效");
  const directoryLength = checkedMultiply(tableCount, 16);
  requireRange(view, 12, directoryLength, "字体表目录越界");
  const tables = new Map<number, TableRange>();
  for (let index = 0; index < tableCount; index += 1) {
    const record = checkedAdd(12, checkedMultiply(index, 16));
    const tag = view.getUint32(record);
    const start = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    requireRange(view, start, length, "字体表越界");
    tables.set(tag, { start, end: checkedAdd(start, length) });
  }
  return tables;
}

function nameTableFamilies(view: DataView, table: TableRange): string[] {
  requireSubrange(table, table.start, 6, "name 表头越界");
  const count = view.getUint16(table.start + 2);
  if (count > 256) throw new Error("name 表记录过多");
  const recordsStart = checkedAdd(table.start, 6);
  const recordsLength = checkedMultiply(count, 12);
  requireSubrange(table, recordsStart, recordsLength, "name 表记录越界");
  const stringsStart = checkedAdd(table.start, view.getUint16(table.start + 4));
  requireSubrange(table, stringsStart, 0, "name 表字符串区越界");
  if (stringsStart < checkedAdd(recordsStart, recordsLength))
    throw new Error("name 表字符串区与记录重叠");
  const preferred: string[] = [];
  const legacy: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = checkedAdd(recordsStart, checkedMultiply(index, 12));
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const nameId = view.getUint16(record + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    if (platform !== 0 && !(platform === 3 && [0, 1, 10].includes(encoding))) continue;
    const length = view.getUint16(record + 8);
    const start = checkedAdd(stringsStart, view.getUint16(record + 10));
    requireSubrange(table, start, length, "name 表字符串越界");
    if (start < stringsStart || length % 2 !== 0) continue;
    const decoded = decodeUtf16Be(view, start, length);
    if (decoded) (nameId === 16 ? preferred : legacy).push(decoded);
  }
  const unique = new Map<string, string>();
  for (const family of [...preferred, ...legacy]) {
    const key = family.toLowerCase();
    if (!unique.has(key)) unique.set(key, family);
  }
  return [...unique.values()];
}

function fontFaceDescriptors(view: DataView, os2?: TableRange): FontFaceDescriptors {
  if (!os2 || os2.end - os2.start < 8) return {};
  const weight = Math.min(1_000, Math.max(1, view.getUint16(os2.start + 4)));
  const width = view.getUint16(os2.start + 6);
  const stretches = [
    "ultra-condensed",
    "extra-condensed",
    "condensed",
    "semi-condensed",
    "normal",
    "semi-expanded",
    "expanded",
    "extra-expanded",
    "ultra-expanded",
  ];
  const selection = os2.end - os2.start >= 64 ? view.getUint16(os2.start + 62) : 0;
  return {
    weight: String(weight),
    stretch: stretches[width - 1] ?? "normal",
    style: selection & 1 ? "italic" : "normal",
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
