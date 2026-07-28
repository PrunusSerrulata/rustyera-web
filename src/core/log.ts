export type WebLogLevel = "debug" | "info" | "warning" | "error";

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
