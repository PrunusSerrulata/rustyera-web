/* global document, getComputedStyle, window */

const SNAPSHOT_INTERVAL_MS = 5_000;

export async function captureCompleteTauriSnapshot(browser) {
  return browser.execute(() => {
    const elements = [...document.querySelectorAll("*")].map((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const candidateValue = "value" in element ? element.value : null;
      const value = ["string", "number", "boolean"].includes(typeof candidateValue)
        ? candidateValue
        : null;
      return {
        tag: element.tagName.toLowerCase(),
        attributes: Object.fromEntries(
          [...element.attributes]
            .map((attribute) => [attribute.name, attribute.value])
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        text: element.textContent ?? "",
        value,
        visible: Boolean(
          element.isConnected &&
          !element.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.opacity !== "0" &&
          bounds.width > 0 &&
          bounds.height > 0,
        ),
      };
    });
    return {
      document: elements,
      runtime: window.__RUSTYERA_TEST__?.snapshot() ?? null,
    };
  });
}

export function assertSnapshotProgress(previousSnapshot, currentSnapshot, label = "Tauri") {
  if (
    previousSnapshot != null &&
    snapshotProgressSignature(previousSnapshot) === snapshotProgressSignature(currentSnapshot)
  ) {
    throw new Error(
      `${label} end-to-end test stalled: two consecutive complete snapshots were identical: ${JSON.stringify(currentSnapshot)}`,
    );
  }
}

export function snapshotProgressSignature(snapshot) {
  return JSON.stringify(withoutReportMetadata(snapshot));
}

export function startTauriSessionMonitor(
  browser,
  {
    deadline,
    describeDeadline = () => "Tauri end-to-end task exceeded the shared 60-minute wall-clock limit",
    eventType = "tauri-e2e-snapshot",
    interval = SNAPSHOT_INTERVAL_MS,
    label = "Tauri",
    output = console.log,
    snapshotContext = () => undefined,
  } = {},
) {
  let stopped = false;
  let wake;
  let monitorError;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);
  const loop = monitor();

  return {
    failure,
    async stop() {
      stopped = true;
      wake?.();
      await loop;
      if (monitorError) throw monitorError;
    },
  };

  async function monitor() {
    let previousSnapshot;
    let nextTick = Date.now();
    try {
      while (!stopped) {
        if (deadline != null && Date.now() >= deadline) {
          throw new Error(describeDeadline());
        }
        const captured = await captureCompleteTauriSnapshot(browser);
        const snapshot = { ...captured, operation: snapshotContext() };
        const runtime = captured.runtime;
        if (runtime?.fault != null) {
          throw new Error(`${label} runtime faulted: ${JSON.stringify(snapshot)}`);
        }
        const terminalRejection = runtime?.logs?.find((entry) =>
          /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
        );
        if (terminalRejection) {
          throw new Error(
            `${label} runtime rejected the configured state: ${JSON.stringify(snapshot)}`,
          );
        }
        output(
          JSON.stringify({
            type: eventType,
            capturedAt: new Date().toISOString(),
            ...snapshot,
          }),
        );
        assertSnapshotProgress(previousSnapshot, snapshot, label);
        previousSnapshot = snapshot;
        if (stopped) break;
        nextTick += interval;
        await new Promise((resolve) => {
          const cadenceRemaining = Math.max(0, nextTick - Date.now());
          const deadlineRemaining =
            deadline == null ? cadenceRemaining : Math.max(0, deadline - Date.now());
          const timer = setTimeout(resolve, Math.min(cadenceRemaining, deadlineRemaining));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    } catch (error) {
      monitorError = error;
      rejectFailure(error);
    }
  }
}

export const startCompleteSnapshotMonitor = startTauriSessionMonitor;

function withoutReportMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutReportMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "timestamp" && key !== "capturedAt")
        .map(([key, child]) => [key, withoutReportMetadata(child)]),
    );
  }
  return value;
}
