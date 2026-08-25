import type { DiagnosisProgress, ProjectGameInformation, ProjectProgress } from "@/core/types";

export interface DiagnosisLogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warning" | "error";
  message: string;
}

const PROJECT_PROGRESS_LABELS: Record<ProjectProgress["stage"], string> = {
  importing: "正在复制项目文件",
  loading_cache: "正在读取项目缓存",
  submitting: "正在准备项目数据",
  scanning: "正在读取项目文件",
  normalizing: "正在整理项目文件",
  loading_data: "正在加载项目数据",
  parsing: "正在解析脚本",
  analyzing: "正在分析脚本",
  compiling: "正在编译脚本函数",
  validating: "正在验证编译结果",
  finalizing: "正在整理编译结果",
  preparing: "正在准备 Runtime 资源",
  packaging: "正在打包全量项目文件",
  cache_parsing: "正在解析项目缓存",
  cache_decoding: "正在解码项目缓存",
  cache_validating: "正在校验项目缓存",
  initializing_memory: "正在初始化游戏内存",
  indexing_program: "正在建立程序索引",
};

export function formatProjectProgress(progress: ProjectProgress): string {
  const label = PROJECT_PROGRESS_LABELS[progress.stage] ?? "正在处理项目";
  if (progress.stage === "scanning" && progress.total <= 0) {
    return progress.completed > 0
      ? `正在枚举项目文件：已检查 ${progress.completed} 项…`
      : "正在枚举项目文件…";
  }
  if (progress.total <= 0) return `${label}…`;
  const completed = Math.min(progress.completed, progress.total);
  const percent = Math.min(100, Math.round((completed * 100) / progress.total));
  return `${label}：${completed}/${progress.total}（${percent}%）`;
}

const DIAGNOSIS_PROGRESS_LABELS: Record<DiagnosisProgress["stage"], string> = {
  waiting: "正在准备诊断信息",
  input_replay: "正在导出输入回放",
  vm_snapshot: "正在导出 VM 快照",
  project_scanning: "正在读取项目文件",
  project_preparing: "正在准备全量项目文件",
  project_packaging: "正在打包全量项目文件",
  project_transfer: "正在传输全量项目文件",
  archive: "正在写入诊断归档",
};

export function formatDiagnosisProgress(progress: DiagnosisProgress): string {
  const label = DIAGNOSIS_PROGRESS_LABELS[progress.stage];
  const percent = diagnosisProgressPercentage(progress);
  if (percent == null) return `${label}…`;
  return `${label}（${percent}%）`;
}

export function diagnosisProgressPercentage(progress: DiagnosisProgress): number | undefined {
  if (progress.total <= 0) return undefined;
  const completed = Math.min(progress.completed, progress.total);
  return Math.min(100, Math.floor((completed * 100) / progress.total));
}

export function at(value: any, key: number): any {
  return value instanceof Map ? value.get(key) : value?.[key];
}

export function isRecoverableStaleDebugLog(message: unknown): boolean {
  const text = String(message ?? "");
  return (
    text.includes("debug request failed") &&
    text.includes("debug grant is stale or belongs to another session generation")
  );
}

export function mapOf(...entries: [number, unknown][]): Map<number, unknown> {
  return new Map(entries);
}

export function safeNumber(value: number | bigint | undefined): number | undefined {
  return value == null ? undefined : Number(value);
}

export function projectGameInformation(value: unknown): ProjectGameInformation | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const text = (key: keyof ProjectGameInformation): string | undefined => {
    const field = source[key];
    return typeof field === "string" && field.trim() ? field : undefined;
  };
  const information = {
    title: text("title"),
    author: text("author"),
    version: text("version"),
    year: text("year"),
    information: text("information"),
  } satisfies ProjectGameInformation;
  return Object.values(information).some((field) => field != null) ? information : null;
}

export function concatenateChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function saveSlotFileName(slot: number): string {
  return `save${slot.toString().padStart(2, "0")}.sav`;
}

export function formatDiagnosisLogs(entries: DiagnosisLogEntry[]): string {
  if (!entries.length) return "";
  const level = { debug: "DEBUG", info: "INFO ", warning: "WARN ", error: "ERROR" } as const;
  const time = (value: Date) =>
    [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  return `${entries
    .map((entry) => `[${time(entry.timestamp)}] ${level[entry.level]} ${entry.message}`)
    .join("\n")}\n`;
}

export function formatDiagnostic(value: any): string {
  const source = value.source;
  const detail =
    value.code == null ? String(value.message ?? "") : `[${value.code}] ${value.message}`;
  if (!source) return detail;
  const line = source.line == null ? "?" : String(Number(source.line) + 1);
  const column = source.byte_column == null ? "?" : String(Number(source.byte_column) + 1);
  return `${source.relative_path}:${line}:${column}: ${detail}`;
}

export function snapshotFileName(now = new Date()): string {
  return timestampedFileName("runtime", "snapshot", now);
}

export function inputReplayFileName(now = new Date()): string {
  return timestampedFileName("input-replay", "jsonl", now);
}

function timestampedFileName(prefix: string, extension: string, now: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}`;
  const time = `${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  return `${prefix}_${date}-${time}.${extension}`;
}
