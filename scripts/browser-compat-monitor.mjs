import { appendFileSync } from "node:fs";

import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";

export function startCompatibilitySnapshotMonitor({
  browser,
  browserName,
  snapshotPath,
  snapshotContext,
  allowFault,
  onSnapshot,
  onFailure,
}) {
  const monitor = startCompleteSnapshotMonitor(browser, {
    eventType: "browser-compat-snapshot",
    label: `${browserName} compatibility`,
    snapshotContext,
    allowFault,
    onSnapshot,
    output(line) {
      appendFileSync(snapshotPath, `${line}\n`);
      const snapshot = JSON.parse(line);
      console.log(
        JSON.stringify({
          browser: browserName,
          type: "browser-compat-snapshot-summary",
          path: snapshotPath,
          capturedAt: snapshot.capturedAt,
          stage: snapshot.operation?.stage,
          phase: snapshot.runtime?.phase,
          status: snapshot.runtime?.status,
          projectOpen: snapshot.runtime?.projectOpen,
          fault: snapshot.runtime?.fault ?? null,
        }),
      );
    },
  });
  void monitor.failure.catch(async (error) => {
    onFailure(error);
    await browser?.deleteSession().catch(() => undefined);
  });
  return monitor;
}
