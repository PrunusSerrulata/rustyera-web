export function terminalRuntimeRejection(snapshot) {
  return snapshot?.logs?.find((entry) =>
    /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
  );
}

export function runtimeProgressSignature(snapshot) {
  return JSON.stringify({
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait
      ? {
          kind: snapshot.wait.kind,
          wait_id: snapshot.wait.wait_id,
          generation: snapshot.wait.generation,
        }
      : null,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-2),
    lastLog: snapshot?.logs?.at(-1),
  });
}

export function runtimeProgressDiagnostic(snapshot) {
  return {
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-12),
    fault: snapshot?.fault,
    logTail: snapshot?.logs?.slice(-8),
  };
}

export function observationFromSnapshot(snapshot, previous = []) {
  const output = snapshot.output ?? [];
  let common = 0;
  while (common < previous.length && common < output.length && previous[common] === output[common])
    common += 1;
  return {
    termination: snapshot.fault
      ? "faulted"
      : snapshot.phase === "waiting_input"
        ? "waitingInput"
        : snapshot.phase,
    phase: snapshot.phase,
    wait: snapshot.wait,
    output,
    output_delta: {
      reset: common === 0 && previous.length > 0,
      removed: previous.length - common,
      added: output.slice(common),
    },
    output_tail: output.slice(-30),
    statuses: [snapshot.status],
    fault: snapshot.fault,
    frontend: snapshot,
  };
}

export function goalStatus(observation, goal) {
  const checks = {};
  const output = observation.output.join("\n");
  for (const value of goal.output_contains ?? [])
    checks[`output_contains:${value}`] = output.includes(String(value));
  if (goal.wait_kind != null) checks.wait_kind = observation.wait?.kind === goal.wait_kind;
  if (goal.termination != null) checks.termination = observation.termination === goal.termination;
  for (const value of goal.status_contains ?? [])
    checks[`status_contains:${value}`] = observation.statuses.some((item) =>
      item.includes(String(value)),
    );
  for (const [name, value] of Object.entries(goal.watch_equals ?? {}))
    checks[`watch_equals:${name}`] = observation.watches?.[name] === value;
  if (goal.line_count_lte != null)
    checks.line_count_lte = observation.output.length <= goal.line_count_lte;
  return {
    satisfied: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean),
    checks,
  };
}
