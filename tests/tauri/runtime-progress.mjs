const DEFAULT_TOTAL_TIMEOUT = 300_000;
const DEFAULT_STALL_TIMEOUT = 60_000;
const DEFAULT_REPORT_INTERVAL = 15_000;
const DEFAULT_POLL_INTERVAL = 500;

export async function waitForRuntimeProgress({
  browser,
  snapshot,
  label,
  accept,
  totalTimeout = DEFAULT_TOTAL_TIMEOUT,
  stallTimeout = DEFAULT_STALL_TIMEOUT,
  reportInterval = DEFAULT_REPORT_INTERVAL,
  pollInterval = DEFAULT_POLL_INTERVAL,
}) {
  const monitoredSnapshot = monitoredRuntimeSnapshot(pollInterval);
  return driveRuntimeUntil({
    browser,
    snapshot: monitoredSnapshot ?? snapshot,
    label,
    accept,
    totalTimeout,
    stallTimeout,
    reportInterval,
    pollInterval,
    pause: monitoredSnapshot ? delay : undefined,
  });
}

export async function driveRuntimeUntil({
  browser,
  snapshot,
  label,
  accept,
  advance,
  totalTimeout = DEFAULT_TOTAL_TIMEOUT,
  stallTimeout = DEFAULT_STALL_TIMEOUT,
  reportInterval = DEFAULT_REPORT_INTERVAL,
  pollInterval = DEFAULT_POLL_INTERVAL,
  pause = (duration) => browser.pause(duration),
}) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastReportAt = startedAt;
  let lastSignature;
  let lastState;

  for (;;) {
    const state = await snapshot();
    const now = Date.now();
    lastState = state;

    if (state?.fault != null) {
      throw new Error(`${label}: runtime faulted: ${JSON.stringify(diagnosticState(state))}`);
    }
    const terminalRejection = state?.logs?.find((entry) =>
      /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
    );
    if (terminalRejection) {
      throw new Error(
        `${label}: runtime rejected the configured state: ${JSON.stringify(diagnosticState(state))}`,
      );
    }
    if (await accept(state)) return state;

    const signature = progressSignature(state);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = now;
    }

    if (now - lastReportAt >= reportInterval) {
      console.log(
        JSON.stringify({
          waitingFor: label,
          elapsedMs: now - startedAt,
          stalledMs: now - lastProgressAt,
          runtime: diagnosticState(state),
        }),
      );
      lastReportAt = now;
    }

    if (now - startedAt >= totalTimeout) {
      throw new Error(
        `${label}: total timeout after ${now - startedAt}ms: ${JSON.stringify(diagnosticState(lastState))}`,
      );
    }
    if (now - lastProgressAt >= stallTimeout) {
      throw new Error(
        `${label}: no observable runtime progress for ${now - lastProgressAt}ms: ${JSON.stringify(diagnosticState(lastState))}`,
      );
    }

    const advanced = (await advance?.(state)) ?? false;
    if (!advanced) await pause(pollInterval);
  }
}

function monitoredRuntimeSnapshot(pollInterval) {
  const observation = globalThis.__RUSTYERA_TAURI_MONITOR_OBSERVATION__;
  if (observation == null) return undefined;

  let sequence = -1;
  return async () => {
    while (observation.sequence === sequence) await delay(pollInterval);
    sequence = observation.sequence;
    return observation.runtime;
  };
}

function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function progressSignature(state) {
  const lastLog = state?.logs?.at(-1);
  return JSON.stringify({
    phase: state?.phase,
    status: state?.status,
    projectOpen: state?.projectOpen,
    canInteract: state?.canInteract,
    wait: state?.wait
      ? { kind: state.wait.kind, wait_id: state.wait.wait_id, generation: state.wait.generation }
      : null,
    presentationRevision: state?.presentationRevision,
    outputTail: state?.output?.slice(-2),
    lastLog,
  });
}

function diagnosticState(state) {
  return {
    phase: state?.phase,
    status: state?.status,
    projectOpen: state?.projectOpen,
    canInteract: state?.canInteract,
    wait: state?.wait,
    presentationRevision: state?.presentationRevision,
    outputTail: state?.output?.slice(-12),
    fault: state?.fault,
    logTail: state?.logs?.slice(-8),
  };
}
