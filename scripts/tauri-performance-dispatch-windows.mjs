import assert from "node:assert/strict";

const TERMINATIONS = new Set([
  "length_limit",
  "discontinuous",
  "slice_boundary",
  "control_boundary",
  "diagnostic",
  "fault",
  "action_end",
  "overflow",
]);

export function validateProfileU64(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(0|[1-9]\d{0,19})$/);
  assert.ok(BigInt(value) <= 18446744073709551615n, "VM profile u64 overflow");
}

function object(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
}

function opcodes(value, maximum) {
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= maximum);
  return Array.from(value, (opcode) => {
    assert.ok(Number.isInteger(opcode) && opcode >= 0 && opcode <= 65535);
    return opcode;
  });
}

export function assertDispatchWindowBoundary(profile, boundary) {
  const window = profile.dispatchWindows;
  if (window === undefined) return;
  assert.equal(window.active, boundary.kind === "before", "VM dispatch window state mismatch");
  for (const key of ["startedAtDispatches", "endedAtDispatches"])
    assert.equal(
      window[key],
      profile.positions[key],
      "VM dispatch window position bounds mismatch",
    );
  if (boundary.kind !== "before") return;
  assert.equal(window.counts.length, 0, "VM dispatch window was not cleared");
  assert.equal(window.pending, null, "VM dispatch window has pending attempts at begin");
  for (const key of ["opportunities", "startedWindows", "excludedContinuations", "droppedWindows"])
    assert.equal(window[key], "0", "VM dispatch window counters were not cleared");
  assert.equal(window.incomplete, false, "VM dispatch window began incomplete");
  assert.equal(window.restartedWhileActive, false, "VM dispatch window began with a restart");
}

/** Position projection loss and dispatch pattern loss are independent. */
export function dispatchWindowVerdict(profile, positionVerdict) {
  if (profile.dispatchWindows === undefined) return undefined;
  if (["window-open", "missing-before", "vm-replaced"].includes(positionVerdict.reason))
    return { ...positionVerdict };
  if (profile.dispatchWindows.incomplete || profile.instance === "0")
    return { valid: false, reason: "incomplete" };
  return { valid: true, reason: null };
}

/** Attempted physical dispatch windows, not successful runs or CPU weights. */
export function validateDispatchWindows(window, dispatches) {
  object(window);
  validateProfileU64(dispatches);
  for (const key of ["active", "incomplete", "restartedWhileActive"])
    assert.equal(typeof window[key], "boolean");
  assert.equal(window.maximumLength, 8);
  assert.equal(window.maximumPatterns, 4096);
  for (const key of [
    "startedAtDispatches",
    "endedAtDispatches",
    "opportunities",
    "startedWindows",
    "excludedContinuations",
    "droppedWindows",
  ])
    validateProfileU64(window[key]);
  const start = BigInt(window.startedAtDispatches);
  const end = BigInt(window.endedAtDispatches);
  assert.ok(start <= end && end <= BigInt(dispatches), "invalid dispatch window bounds");
  if (window.active) assert.equal(end, BigInt(dispatches), "stale active dispatch window");
  assert.ok(window.droppedWindows === "0" || window.incomplete);
  assert.ok(!window.restartedWhileActive || window.incomplete);
  assert.ok(Array.isArray(window.counts) && window.counts.length <= 4096);
  const keys = new Set();
  let samples = 0n;
  const counts = Array.from(window.counts, (entry) => {
    object(entry);
    const codes = opcodes(entry.opcodes, 8);
    assert.ok(TERMINATIONS.has(entry.termination), "unknown dispatch termination");
    if (entry.termination === "length_limit") assert.equal(codes.length, 8);
    validateProfileU64(entry.samples);
    assert.notEqual(entry.samples, "0");
    const key = JSON.stringify([codes, entry.termination]);
    assert.ok(!keys.has(key), "duplicate dispatch window pattern");
    keys.add(key);
    samples += BigInt(entry.samples);
    return { opcodes: codes, termination: entry.termination, samples: entry.samples };
  });
  let pending = null;
  if (window.pending !== null) {
    object(window.pending);
    assert.ok(window.active, "inactive dispatch window has pending attempts");
    pending = { opcodes: opcodes(window.pending.opcodes, 7) };
  }
  if (!window.incomplete) {
    const opportunities = BigInt(window.opportunities);
    const started = BigInt(window.startedWindows);
    assert.equal(opportunities, end / 1024n - start / 1024n, "dispatch opportunity mismatch");
    assert.equal(
      opportunities,
      started + BigInt(window.excludedContinuations),
      "dispatch start accounting mismatch",
    );
    assert.equal(
      started,
      samples + BigInt(window.droppedWindows) + BigInt(pending !== null),
      "dispatch sample accounting mismatch",
    );
  }
  return {
    active: window.active,
    startedAtDispatches: window.startedAtDispatches,
    endedAtDispatches: window.endedAtDispatches,
    maximumLength: 8,
    maximumPatterns: 4096,
    incomplete: window.incomplete,
    restartedWhileActive: window.restartedWhileActive,
    opportunities: window.opportunities,
    startedWindows: window.startedWindows,
    excludedContinuations: window.excludedContinuations,
    droppedWindows: window.droppedWindows,
    counts,
    pending,
  };
}
