import type { ProjectProgress } from "@/core/types";

export interface DiagnosisLogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warning" | "error";
  message: string;
}

const PROJECT_PROGRESS_LABELS: Record<ProjectProgress["stage"], string> = {
  importing: "正在复制项目文件",
  scanning: "正在读取项目文件",
  normalizing: "正在整理项目文件",
  loading_data: "正在加载项目数据",
  parsing: "正在解析脚本文件",
  analyzing: "正在分析脚本函数",
  compiling: "正在编译脚本函数",
  validating: "正在验证编译结果",
};

export function formatProjectProgress(progress: ProjectProgress): string {
  const label = PROJECT_PROGRESS_LABELS[progress.stage] ?? "正在处理项目";
  if (progress.stage === "scanning" && progress.total <= 0) return "正在枚举项目文件…";
  if (progress.total <= 0) return `${label}…`;
  const completed = Math.min(progress.completed, progress.total);
  const percent = Math.min(100, Math.round((completed * 100) / progress.total));
  return `${label}：${completed}/${progress.total}（${percent}%）`;
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
  return source
    ? `${source.relative_path}:${Number(source.line ?? 0) + 1}:${Number(source.byte_column ?? 0) + 1}: [${value.code}] ${value.message}`
    : `[${value.code}] ${value.message}`;
}

export function snapshotFileName(now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}`;
  const time = `${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  return `runtime_${date}-${time}.snapshot`;
}
