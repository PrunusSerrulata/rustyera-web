/* global document, getComputedStyle, window */

import path from "node:path";

const SNAPSHOT_INTERVAL_MS = 5_000;

/** Establish foreground once through the session's real native window command before test input. */
export async function focusCurrentTauriWindow(browser) {
  const handle = await browser.getWindowHandle();
  if (typeof handle !== "string" || !handle)
    throw new Error("native foreground setup requires the current WebDriver window handle");
  await browser.switchToWindow(handle);
  await browser.waitUntil(
    () => browser.execute(() => document.visibilityState === "visible" && document.hasFocus()),
    {
      timeout: 3_000,
      interval: 50,
      timeoutMsg: "current native WebDriver window did not become visible and focused",
    },
  );
  return handle;
}

export function resolveTauriBinary(targetDirectory, release, platform = process.platform) {
  if (typeof targetDirectory !== "string" || !path.isAbsolute(targetDirectory))
    throw new Error("Cargo metadata must provide an absolute target_directory");
  const profile = release ? "release" : "debug";
  const executable = `era-web-tauri${platform === "win32" ? ".exe" : ""}`;
  return path.join(targetDirectory, profile, executable);
}

export async function captureCompleteTauriSnapshot(browser, timeoutMs = SNAPSHOT_INTERVAL_MS) {
  let timeout;
  try {
    return await Promise.race([
      browser.execute(() => {
        const ELEMENT_NODE = 1;
        const TEXT_NODE = 3;
        const CDATA_SECTION_NODE = 4;
        const nodes = [...document.querySelectorAll("*")];
        const positions = new Map(nodes.map((element, index) => [element, index]));
        const texts = new Array(nodes.length).fill("");
        // Preserve Element.textContent exactly without asking the browser to walk every
        // descendant subtree again for every ancestor in a large scene.
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const parts = [];
          for (const child of nodes[index].childNodes) {
            if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE)
              parts.push(child.nodeValue ?? "");
            else if (child.nodeType === ELEMENT_NODE) {
              const childIndex = positions.get(child);
              if (childIndex != null) parts.push(texts[childIndex]);
            }
          }
          texts[index] = parts.join("");
        }
        const elements = nodes.map((element, index) => {
          const bounds = element.getBoundingClientRect();
          const candidateValue = "value" in element ? element.value : null;
          const value = ["string", "number", "boolean"].includes(typeof candidateValue)
            ? candidateValue
            : null;
          let visible = false;
          if (element.isConnected && !element.hidden && bounds.width > 0 && bounds.height > 0) {
            if (typeof element.checkVisibility === "function") {
              visible = element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                opacityProperty: true,
                visibilityProperty: true,
              });
            } else {
              const style = getComputedStyle(element);
              visible =
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.visibility !== "collapse" &&
                style.opacity !== "0";
            }
          }
          return {
            tag: element.tagName.toLowerCase(),
            attributes: Object.fromEntries(
              [...element.attributes]
                .map((attribute) => [attribute.name, attribute.value])
                .sort(([left], [right]) => left.localeCompare(right)),
            ),
            text: texts[index],
            value,
            visible,
          };
        });
        return {
          document: elements,
          runtime:
            window.__RUSTYERA_TEST__?.snapshotSummary?.() ??
            window.__RUSTYERA_TEST__?.snapshot() ??
            null,
        };
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`complete snapshot capture exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function snapshotCaptureTimeout(previousSnapshot, interval = SNAPSHOT_INTERVAL_MS) {
  return usesExtendedSnapshotWatchdog(previousSnapshot) ? interval * 4 : interval;
}

function usesExtendedSnapshotWatchdog(snapshot) {
  const runtime = snapshot?.runtime;
  return (
    runtime?.projectLoading === true ||
    runtime?.transfer?.export?.name === "compiled-project.reracache"
  );
}

export function assertSnapshotProgress(
  previousSnapshot,
  currentSnapshot,
  label = "Tauri",
  identicalIntervals = 1,
  signatures,
) {
  if (
    previousSnapshot != null &&
    (signatures?.previous ?? snapshotProgressSignature(previousSnapshot)) ===
      (signatures?.current ?? snapshotProgressSignature(currentSnapshot))
  ) {
    const requiredIntervals = usesExtendedSnapshotWatchdog(currentSnapshot) ? 4 : 1;
    if (identicalIntervals < requiredIntervals) return;
    throw new Error(
      `${label} end-to-end test stalled: ${identicalIntervals} consecutive 5-second intervals had identical complete snapshots: ${JSON.stringify(currentSnapshot)}`,
    );
  }
}

export function snapshotProgressSignature(snapshot) {
  // Appended transport/decode ledgers are capture evidence, not live game state.
  // Polling/debug acknowledgements must not manufacture watchdog progress.
  // Keep its failure status and preserve the complete ledger in the raw snapshot.
  const runtime = snapshot?.runtime;
  let observable = snapshot;
  if (runtime && typeof runtime === "object") {
    const projected = { ...runtime };
    for (const field of ["serviceEvidence", "serviceLifecycle"]) {
      const evidence = runtime[field];
      if (evidence && typeof evidence === "object") {
        projected[field] = Object.fromEntries(
          Object.entries(evidence).filter(
            ([key]) => !["records", "pointerSamples", "bytes"].includes(key),
          ),
        );
      }
    }
    observable = { ...snapshot, runtime: projected };
  }
  return JSON.stringify(withoutReportMetadata(observable));
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
    outputEvent,
    snapshotContext = () => undefined,
    allowFault = () => false,
    onSnapshot,
  } = {},
) {
  let stopped = false;
  let stopAfterNextCapture = false;
  let waitingForNextCapture = false;
  let nextTick = Date.now();
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
      if (waitingForNextCapture && Date.now() >= nextTick) {
        stopAfterNextCapture = true;
      } else {
        stopped = true;
      }
      wake?.();
      await loop;
      if (monitorError) throw monitorError;
    },
  };

  async function monitor() {
    let previousSnapshot;
    let previousSignature;
    let identicalIntervals = 0;
    try {
      while (!stopped) {
        if (deadline != null && Date.now() >= deadline) {
          throw new Error(describeDeadline());
        }
        const captured = await captureCompleteTauriSnapshot(
          browser,
          snapshotCaptureTimeout(previousSnapshot, interval),
        );
        const snapshot = { ...captured, operation: snapshotContext() };
        const runtime = captured.runtime;
        // Persist the failure frontier before an observer or terminal-state check can throw.
        const event = {
          type: eventType,
          capturedAt: new Date().toISOString(),
          ...snapshot,
        };
        if (outputEvent) await outputEvent(event);
        else await output(JSON.stringify(event));
        await onSnapshot?.(snapshot);
        if (runtime?.fault != null && !allowFault()) {
          throw new Error(`${label} runtime faulted: ${JSON.stringify(runtime.fault)}`);
        }
        const terminalRejection = runtime?.logs?.find((entry) =>
          /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
        );
        if (terminalRejection) {
          throw new Error(
            `${label} runtime rejected the configured state: ${JSON.stringify(terminalRejection)}`,
          );
        }
        const currentSignature = snapshotProgressSignature(snapshot);
        identicalIntervals =
          previousSnapshot != null && previousSignature === currentSignature
            ? identicalIntervals + 1
            : 0;
        assertSnapshotProgress(previousSnapshot, snapshot, label, identicalIntervals, {
          previous: previousSignature,
          current: currentSignature,
        });
        previousSnapshot = snapshot;
        previousSignature = currentSignature;
        if (stopAfterNextCapture) {
          stopped = true;
          break;
        }
        if (stopped) break;
        nextTick += interval;
        waitingForNextCapture = true;
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
        waitingForNextCapture = false;
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
  if (typeof value === "string") return value.replace(/ · 已等待 \d+ 秒/g, "");
  return value;
}
