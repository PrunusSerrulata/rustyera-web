export type WebLogLevel = "debug" | "info" | "warning" | "error";
export type LogNotificationLevel = Extract<WebLogLevel, "warning" | "error">;

import type { PumpBatch, RuntimeMessage } from "@/core/types";

export interface LogNotificationState {
  id: number;
  level: LogNotificationLevel;
  message: string;
}

export function runtimeDebugVariant(value: unknown): string {
  return String(value ?? "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

export function suppressedMirroredLogNotificationIndexes(events: PumpBatch["events"]): Set<number> {
  const suppressed = new Set<number>();
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];
    if (
      event.channel === "runtime" &&
      event.message.type === "fault" &&
      previous.channel === "runtime" &&
      previous.message.type === "log" &&
      (previous.message as RuntimeMessage).value.level === "error"
    ) {
      suppressed.add(index - 1);
      continue;
    }
    if (
      event.channel === "runtime" &&
      event.message.type === "log" &&
      previous.channel === "runtime" &&
      previous.message.type === "command_rejected"
    ) {
      const rejection = (previous.message as RuntimeMessage).value as {
        code?: unknown;
        message?: unknown;
      };
      const entry = (event.message as RuntimeMessage).value as {
        level?: unknown;
        message?: unknown;
      };
      const expected = `command rejected [${runtimeDebugVariant(rejection.code)}]: ${String(rejection.message ?? "")}`;
      if (
        ["warning", "error"].includes(String(entry.level ?? "")) &&
        String(entry.message ?? "") === expected
      )
        suppressed.add(index);
      continue;
    }
    if (
      event.channel === "runtime" &&
      event.message.type === "state_export_ready" &&
      previous.channel === "runtime" &&
      previous.message.type === "log"
    ) {
      const ready = (event.message as RuntimeMessage).value as {
        result?: { type?: unknown; reasons?: unknown[] };
      };
      const entry = (previous.message as RuntimeMessage).value as {
        level?: unknown;
        message?: unknown;
      };
      const reasons = ready.result?.reasons ?? [];
      const expected = `state export is ineligible: [${reasons.map(runtimeDebugVariant).join(", ")}]`;
      if (
        ready.result?.type === "ineligible" &&
        entry.level === "warning" &&
        entry.message === expected
      )
        suppressed.add(index - 1);
    }
  }
  return suppressed;
}

const labels: Record<WebLogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warning: "WARN ",
  error: "ERROR",
};

export function logLevelLabel(level: WebLogLevel): string {
  return labels[level];
}

export function formatLogTime(timestamp: Date): string {
  return [timestamp.getHours(), timestamp.getMinutes(), timestamp.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatLogEntry(entry: {
  timestamp: Date;
  level: WebLogLevel;
  message: string;
}): string {
  return `[${formatLogTime(entry.timestamp)}] ${logLevelLabel(entry.level)} ${entry.message}`;
}
