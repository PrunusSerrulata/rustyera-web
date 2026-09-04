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
      browser
        .execute(() => {
          const ELEMENT_NODE = 1;
          const TEXT_NODE = 3;
          const CDATA_SECTION_NODE = 4;
          const nodes = [...document.querySelectorAll("*")];
          const positions = new Map(nodes.map((element, index) => [element, index]));
          const displayed = new Array(nodes.length).fill(true);
          const opaque = new Array(nodes.length).fill(true);
          const contentVisible = new Array(nodes.length).fill(true);
          const elements = nodes.map((element, index) => {
            const candidateValue = "value" in element ? element.value : null;
            const value = ["string", "number", "boolean"].includes(typeof candidateValue)
              ? candidateValue
              : null;
            const parentIndex = positions.get(element.parentElement);
            const ancestorsRender =
              parentIndex == null ||
              (displayed[parentIndex] && opaque[parentIndex] && contentVisible[parentIndex]);
            let visible = false;
            if (!ancestorsRender || !element.isConnected || element.hidden) {
              displayed[index] = false;
              opaque[index] = false;
              contentVisible[index] = false;
            } else if (typeof element.checkVisibility === "function") {
              // Chromium can resolve inherited display/visibility/opacity in one
              // native tree walk. Repeated getComputedStyle calls force a full
              // hover style recalculation for every node on large game screens.
              visible = element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                contentVisibilityAuto: true,
                opacityProperty: true,
                visibilityProperty: true,
              });
              if (!visible) {
                // Native invisibility also covers display:contents and empty
                // boxes whose descendants can still render. Resolve only this
                // small exceptional set through computed style so descendants
                // retain the old exact visibility semantics.
                const style = getComputedStyle(element);
                displayed[index] = style.display !== "none";
                opaque[index] = style.opacity !== "0";
                contentVisible[index] = style.contentVisibility !== "hidden";
                visible =
                  displayed[index] &&
                  opaque[index] &&
                  contentVisible[index] &&
                  style.visibility !== "hidden" &&
                  style.visibility !== "collapse";
              }
            } else {
              const style = getComputedStyle(element);
              displayed[index] = style.display !== "none";
              opaque[index] = style.opacity !== "0";
              contentVisible[index] = style.contentVisibility !== "hidden";
              visible =
                displayed[index] &&
                opaque[index] &&
                contentVisible[index] &&
                style.visibility !== "hidden" &&
                style.visibility !== "collapse";
            }
            if (visible) {
              const offsetWidth = element.offsetWidth;
              const offsetHeight = element.offsetHeight;
              if (
                typeof offsetWidth !== "number" ||
                typeof offsetHeight !== "number" ||
                offsetWidth <= 0 ||
                offsetHeight <= 0
              ) {
                const bounds = element.getBoundingClientRect();
                visible = bounds.width > 0 && bounds.height > 0;
              }
            }
            return {
              tag: element.tagName.toLowerCase(),
              attributes: Object.fromEntries(
                [...element.attributes]
                  .map((attribute) => [attribute.name, attribute.value])
                  .sort(([left], [right]) => left.localeCompare(right)),
              ),
              // Transfer each direct text node once. Numeric entries refer to child
              // elements and are expanded into exact Element.textContent after the
              // compact browser payload crosses the automation boundary.
              textParts: [...element.childNodes].flatMap((child) => {
                if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE)
                  return [child.nodeValue ?? ""];
                if (child.nodeType !== ELEMENT_NODE) return [];
                const childIndex = positions.get(child);
                return [childIndex == null ? (child.textContent ?? "") : childIndex];
              }),
              value,
              visible,
            };
          });
          const control = window.__RUSTYERA_TEST__;
          const runtime = control?.snapshotSummary?.() ?? control?.snapshot() ?? null;
          // Read only requested wire records: a failed compile report can be tens of MiB.
          // Filtering in the ledger avoids cloning unrelated payloads during the watchdog.
          const messageTypes = window.__RUSTYERA_TEST_PROTOCOL_TYPES__;
          if (runtime && messageTypes && control?.protocolEvidence)
            runtime.serviceEvidence = control.protocolEvidence(messageTypes);
          return {
            document: elements,
            runtime,
          };
        })
        .then(expandCompleteTauriSnapshot),
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

export function expandCompleteTauriSnapshot(snapshot) {
  const compactProgressSignature = snapshotProgressSignature(snapshot);
  const texts = new Array(snapshot.document.length).fill("");
  for (let index = snapshot.document.length - 1; index >= 0; index -= 1) {
    const element = snapshot.document[index];
    const text = (element.textParts ?? [])
      .map((part) => (typeof part === "number" ? texts[part] : part))
      .join("");
    texts[index] = text;
    element.text = text;
    delete element.textParts;
  }
  Object.defineProperty(snapshot, "compactProgressSignature", {
    configurable: false,
    enumerable: false,
    value: compactProgressSignature,
    writable: false,
  });
  return snapshot;
}

export function snapshotCaptureTimeout(_previousSnapshot, interval = SNAPSHOT_INTERVAL_MS) {
  return interval;
}

export function assertSnapshotProgress(
  previousSnapshot,
  currentSnapshot,
  label = "Tauri",
  identicalIntervals = 1,
  signatures,
) {
  // Temporary, explicitly authorized loading-only policy. Capture deadlines,
  // terminal failures, exports and interactive runtime states keep the default.
  const loadingAllowance =
    process.env.RUSTYERA_TEST_LOADING_STALL_INTERVALS === "4" &&
    currentSnapshot?.runtime?.projectLoading === true &&
    currentSnapshot.runtime.canInteract !== true &&
    currentSnapshot.runtime.wait == null &&
    currentSnapshot.runtime.transfer?.export == null;
  const maximumIdenticalIntervals = loadingAllowance ? 4 : 1;
  if (
    previousSnapshot != null &&
    identicalIntervals >= maximumIdenticalIntervals &&
    (signatures?.previous ?? snapshotProgressSignature(previousSnapshot)) ===
      (signatures?.current ?? snapshotProgressSignature(currentSnapshot))
  ) {
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
        const currentSignature = captured.compactProgressSignature
          ? `${captured.compactProgressSignature}\n${JSON.stringify(
              withoutReportMetadata(snapshot.operation),
            )}`
          : snapshotProgressSignature(snapshot);
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
