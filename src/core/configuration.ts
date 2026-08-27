import { requireCompatibilityIdentity } from "@/core/compatibility";
import type {
  PreparedProjectConfiguration,
  ProjectConfigurationChange,
  ProjectConfigurationEntry,
  ProjectConfigurationSnapshot,
} from "@/core/types";

const CLIENT_BROWSER = 1 << 2;
const CLIENT_TAURI = 1 << 3;
const VALUE_KINDS = new Set([
  "boolean",
  "integer",
  "string",
  "enum",
  "color",
  "character",
  "integer_list",
  "string_list",
]);

export function parseProjectConfiguration(value: unknown): ProjectConfigurationSnapshot {
  if (!isRecord(value)) throw new Error("项目配置不是对象");
  const revision = unsignedIntegerField(value, "project_revision");
  const digest = bytesField(value, "source_digest");
  if (!Array.isArray(value.entries)) throw new Error("项目配置条目不是数组");
  return {
    project_revision: revision,
    ...(value.compatibility == null
      ? {}
      : { compatibility: requireCompatibilityIdentity(value.compatibility) }),
    source_digest: digest,
    entries: value.entries.map(parseEntry),
    restart_pending: value.restart_pending == null ? false : booleanField(value, "restart_pending"),
    generated_source:
      value.generated_source == null ? null : stringField(value, "generated_source"),
  };
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`项目配置 ${field} 字段无效`);
  return result;
}

export function parsePreparedConfiguration(value: unknown): PreparedProjectConfiguration {
  if (!isRecord(value)) throw new Error("待保存项目配置不是对象");
  if (typeof value.contents !== "string" || typeof value.restart_required !== "boolean")
    throw new Error("待保存项目配置字段无效");
  return {
    project_revision: unsignedIntegerField(value, "project_revision"),
    expected_source_digest: bytesField(value, "expected_source_digest"),
    contents: value.contents,
    restart_required: value.restart_required,
    prepared_source_digest: bytesField(value, "prepared_source_digest"),
  };
}

export function clientConfigurationEntries(
  snapshot: ProjectConfigurationSnapshot | null,
  client: "browser" | "tauri",
): ProjectConfigurationEntry[] {
  const flag = client === "tauri" ? CLIENT_TAURI : CLIENT_BROWSER;
  return snapshot?.entries.filter((entry) => (entry.applicability & flag) !== 0) ?? [];
}

export function equalConfigurationIdentity(
  prepared: PreparedProjectConfiguration,
  snapshot: ProjectConfigurationSnapshot,
): boolean {
  return (
    prepared.project_revision === snapshot.project_revision &&
    equalBytes(prepared.expected_source_digest, snapshot.source_digest)
  );
}

export function prepareConfigurationUpdate(
  snapshot: ProjectConfigurationSnapshot,
  changes: ProjectConfigurationChange[],
): Record<string, unknown> {
  return {
    project_revision: snapshot.project_revision,
    expected_source_digest: [...snapshot.source_digest],
    changes,
  };
}

function parseEntry(value: unknown): ProjectConfigurationEntry {
  if (!isRecord(value)) throw new Error("项目配置条目不是对象");
  for (const field of ["code", "japanese", "english", "value"])
    if (typeof value[field] !== "string") throw new Error(`项目配置 ${field} 字段无效`);
  if (typeof value.kind !== "string" || !VALUE_KINDS.has(value.kind))
    throw new Error("项目配置值类型无效");
  if (!Array.isArray(value.allowed) || !value.allowed.every((item) => typeof item === "string"))
    throw new Error("项目配置候选值无效");
  if (typeof value.fixed !== "boolean") throw new Error("项目配置标志无效");
  if (value.application != null && value.application !== "hot" && value.application !== "restart")
    throw new Error("项目配置应用方式无效");
  const applicability = unsignedU32(value.applicability);
  return {
    code: value.code as string,
    japanese: value.japanese as string,
    english: value.english as string,
    value: value.value as string,
    kind: value.kind as ProjectConfigurationEntry["kind"],
    allowed: value.allowed as string[],
    fixed: value.fixed,
    applicability,
    default_value:
      typeof value.default_value === "string" ? value.default_value : (value.value as string),
    effective_value:
      typeof value.effective_value === "string" ? value.effective_value : (value.value as string),
    application: value.application === "hot" ? "hot" : "restart",
    preference_eligible: value.preference_eligible === true,
    client_effective_value:
      typeof value.client_effective_value === "string"
        ? value.client_effective_value
        : (value.effective_value as string) || (value.value as string),
  };
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  const result = value[field];
  if (typeof result !== "boolean") throw new Error(`项目配置 ${field} 字段无效`);
  return result;
}

function unsignedU32(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff)
    return value;
  if (typeof value === "bigint" && value >= 0n && value <= 0xffff_ffffn) return Number(value);
  throw new Error("项目配置标志无效");
}

function unsignedIntegerField(value: Record<string, unknown>, field: string): number | bigint {
  const result = value[field];
  if (typeof result === "bigint") {
    if (result < 0n || result > 0xffff_ffff_ffff_ffffn)
      throw new Error(`项目配置 ${field} 字段无效`);
    return result;
  }
  if (typeof result === "number" && Number.isSafeInteger(result) && result >= 0) return result;
  throw new Error(`项目配置 ${field} 字段无效`);
}

function bytesField(value: Record<string, unknown>, field: string): Uint8Array {
  const bytes = value[field];
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array))
    throw new Error(`项目配置 ${field} 字段无效`);
  if (
    Array.isArray(bytes) &&
    !bytes.every(
      (item) =>
        (typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 0xff) ||
        (typeof item === "bigint" && item >= 0n && item <= 0xffn),
    )
  )
    throw new Error(`项目配置 ${field} 包含无效字节`);
  const result =
    bytes instanceof Uint8Array ? new Uint8Array(bytes) : Uint8Array.from(bytes, Number);
  if (![0, 32].includes(result.length)) throw new Error(`项目配置 ${field} 长度无效`);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
