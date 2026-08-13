import type { ProjectConfigurationSnapshot } from "@/core/types";

export function configurationValue(
  snapshot: ProjectConfigurationSnapshot | null,
  code: string,
): string | undefined {
  return snapshot?.entries.find((entry) => entry.code === code)?.effective_value;
}

export function configurationBoolean(
  snapshot: ProjectConfigurationSnapshot | null,
  code: string,
  fallback: boolean,
): boolean {
  const value = configurationValue(snapshot, code)?.toUpperCase();
  if (value == null) return fallback;
  return value === "YES" || value === "TRUE" || value === "1";
}

export function sameMessageId(
  messageId: number | bigint | undefined,
  correlationId: number | bigint | undefined,
): boolean {
  return String(messageId) === String(correlationId);
}
