import { shallowReactive } from "vue";

import type { LogNotificationState } from "@/core/log";
import type { LogEntry, LogNotificationPolicy } from "@/stores/runtimeState";

export class RuntimeLogState {
  readonly entries = shallowReactive<LogEntry[]>([]);
  readonly notifications = shallowReactive<LogNotificationState[]>([]);
  private notificationId = 0;

  constructor(private readonly maximumEntries: number) {}

  record(
    level: LogEntry["level"],
    message: string,
    authoritative = false,
    notificationPolicy: LogNotificationPolicy = "all",
  ): void {
    this.append([{ timestamp: new Date(), level, message, authoritative }], notificationPolicy);
  }

  append(entries: LogEntry[], notificationPolicy: LogNotificationPolicy = "all"): void {
    const retained =
      entries.length > this.maximumEntries
        ? entries.slice(entries.length - this.maximumEntries)
        : entries;
    const overflow = Math.max(0, this.entries.length + retained.length - this.maximumEntries);
    if (overflow > 0) this.entries.splice(0, overflow);
    if (retained.length > 0) this.entries.push(...retained);
    if (notificationPolicy === "none") return;
    for (const entry of retained) {
      if (entry.level !== "error" && !(entry.level === "warning" && notificationPolicy === "all"))
        continue;
      this.notifications.push({
        id: ++this.notificationId,
        level: entry.level,
        message: entry.message,
      });
    }
    const notificationOverflow = Math.max(0, this.notifications.length - this.maximumEntries);
    if (notificationOverflow > 0) this.notifications.splice(0, notificationOverflow);
  }

  dismiss(notificationId: number): void {
    const index = this.notifications.findIndex(({ id }) => id === notificationId);
    if (index >= 0) this.notifications.splice(index, 1);
  }
}
