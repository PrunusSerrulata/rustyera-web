import { shallowReactive } from "vue";

import type { LogNotificationState } from "@/core/log";
import type { LogEntry, LogNotificationPolicy } from "@/stores/runtimeState";

// A compile failure may fill the entire log. Bound alerts before Vue mounts them;
// viewport fitting happens after rendering and cannot protect against that burst.
export const MAXIMUM_PENDING_LOG_NOTIFICATIONS = 32;

export class RuntimeLogState {
  readonly entries = shallowReactive<LogEntry[]>([]);
  readonly notifications = shallowReactive<LogNotificationState[]>([]);
  private notificationId = 0;
  private retainedBytes = 0;
  private notificationBytes = 0;

  constructor(
    private readonly maximumEntries: number,
    private readonly maximumEntryBytes = Number.POSITIVE_INFINITY,
    private readonly maximumTotalBytes = Number.POSITIVE_INFINITY,
  ) {}

  record(
    level: LogEntry["level"],
    message: string,
    authoritative = false,
    notificationPolicy: LogNotificationPolicy = "all",
  ): void {
    this.append([{ timestamp: new Date(), level, message, authoritative }], notificationPolicy);
  }

  append(
    entries: LogEntry[],
    notificationPolicy: LogNotificationPolicy | readonly LogNotificationPolicy[] = "all",
  ): void {
    const retainedStart = Math.max(0, entries.length - this.maximumEntries);
    const retained = entries.slice(retainedStart).map((entry) => ({
      ...entry,
      message: truncateUtf16(entry.message, this.maximumEntryBytes),
    }));
    const overflow = Math.max(0, this.entries.length + retained.length - this.maximumEntries);
    this.removeOldest(overflow);
    for (const entry of retained) {
      const bytes = stringBytes(entry.message);
      while (this.entries.length > 0 && this.retainedBytes + bytes > this.maximumTotalBytes)
        this.removeOldest(1);
      if (bytes <= this.maximumTotalBytes) {
        this.entries.push(entry);
        this.retainedBytes += bytes;
      }
    }
    const pending: Array<Pick<LogNotificationState, "level" | "message">> = [];
    const maximumNotifications = Math.min(this.maximumEntries, MAXIMUM_PENDING_LOG_NOTIFICATIONS);
    for (
      let index = retained.length - 1;
      index >= 0 && pending.length < maximumNotifications;
      index -= 1
    ) {
      const entry = retained[index];
      const policy =
        typeof notificationPolicy === "string"
          ? notificationPolicy
          : (notificationPolicy[retainedStart + index] ?? "all");
      if (policy === "none") continue;
      if (entry.level !== "error" && !(entry.level === "warning" && policy === "all")) continue;
      pending.push({ level: entry.level, message: entry.message });
    }
    this.removeOldestNotifications(
      Math.max(0, this.notifications.length + pending.length - maximumNotifications),
    );
    for (const entry of pending.reverse()) {
      this.notifications.push({
        id: ++this.notificationId,
        level: entry.level,
        message: entry.message,
      });
      this.notificationBytes += stringBytes(entry.message);
    }
    while (this.notifications.length > 0 && this.notificationBytes > this.maximumTotalBytes)
      this.removeOldestNotifications(1);
  }

  dismiss(notificationId: number): void {
    const index = this.notifications.findIndex(({ id }) => id === notificationId);
    if (index >= 0) {
      const [removed] = this.notifications.splice(index, 1);
      if (removed) this.notificationBytes -= stringBytes(removed.message);
    }
  }

  clear(): void {
    this.entries.splice(0);
    this.notifications.splice(0);
    this.retainedBytes = 0;
    this.notificationBytes = 0;
  }

  private removeOldest(count: number): void {
    if (count <= 0) return;
    for (const entry of this.entries.splice(0, count))
      this.retainedBytes -= stringBytes(entry.message);
  }

  private removeOldestNotifications(count: number): void {
    if (count <= 0) return;
    for (const notification of this.notifications.splice(0, count))
      this.notificationBytes -= stringBytes(notification.message);
  }
}

function stringBytes(value: string): number {
  return value.length * 2;
}

function truncateUtf16(value: string, maximumBytes: number): string {
  if (!Number.isFinite(maximumBytes) || stringBytes(value) <= maximumBytes) return value;
  const suffix = "…（日志已截断）";
  const totalCharacters = Math.max(0, Math.floor(maximumBytes / 2));
  if (totalCharacters <= suffix.length) return suffix.slice(0, totalCharacters);
  const maximumCharacters = totalCharacters - suffix.length;
  return `${value.slice(0, maximumCharacters)}${suffix}`;
}
