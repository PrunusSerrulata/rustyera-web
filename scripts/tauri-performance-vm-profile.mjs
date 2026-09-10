/* global window */
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parsePerformanceObservationJson } from "./tauri-performance-timing-evidence.mjs";

const MAXIMUM_RECORD_BYTES = 32 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 256 * 1024 * 1024;

export function vmProfileBuildFeature(enabled) {
  return enabled ? ",vm-instruction-profile" : "";
}

export function assertVmProfileAction(settle) {
  assert.equal(settle, "wait_change", "VM position sampling excludes checkpoint_change actions");
}

export function assertVmProfileMode(env, { buildOnly = false, instrumentPerformance = true } = {}) {
  if (env.RUSTYERA_TAURI_PERF_VM_SAMPLE !== "1") return;
  assert.ok(instrumentPerformance, "VM instruction profiling requires performance audit");
  assert.ok(
    buildOnly || env.RUSTYERA_TAURI_PERF_CAPTURE === "1",
    "VM instruction profiling requires diagnostic capture (not replay or calibration)",
  );
}

/** Run every cleanup, preserving even a falsy primary thrown value. */
export async function finishProfileCapture(cleanups, primaryFailure) {
  let failure = primaryFailure;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

function u64(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(0|[1-9]\d{0,19})$/);
  assert.ok(BigInt(value) <= 18446744073709551615n, "VM profile u64 overflow");
}

function validateProfile(profile) {
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.interval, 1024);
  assert.equal(typeof profile.incomplete, "boolean");
  for (const key of ["instance", "dispatches", "droppedSamples"]) u64(profile[key]);
  assert.ok(
    profile.instance !== "0" || profile.incomplete,
    "exhausted VM identity must be incomplete",
  );
  assert.ok(Array.isArray(profile.counts) && profile.counts.length <= 4096);
  assert.ok(Array.isArray(profile.symbols) && profile.symbols.length <= 128);
  for (const [entries, symbol] of [
    [profile.counts, false],
    [profile.symbols, true],
  ]) {
    const keys = new Set();
    for (const entry of entries) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
      u64(entry.generation);
      assert.equal(typeof entry.function, "string");
      assert.match(entry.function, /^[0-9a-f]{32}$/);
      const key = entry.generation + ":" + entry.function;
      assert.ok(!keys.has(key), "duplicate VM profile key");
      keys.add(key);
      if (symbol) {
        assert.equal(typeof entry.name, "string");
        assert.ok(Array.from(entry.name).length <= 64);
      } else u64(entry.samples);
    }
  }
  return {
    schemaVersion: 2,
    instance: profile.instance,
    interval: profile.interval,
    dispatches: profile.dispatches,
    droppedSamples: profile.droppedSamples,
    incomplete: profile.incomplete,
    counts: profile.counts.map(({ generation, function: name, samples }) => ({
      generation,
      function: name,
      samples,
    })),
    symbols: profile.symbols.map(({ generation, function: key, name }) => ({
      generation,
      function: key,
      name,
    })),
    positions: validatePositions(profile.positions, profile.dispatches),
    ...(profile.opcodes === undefined
      ? {}
      : { opcodes: validateOpcodes(profile.opcodes, profile.dispatches) }),
  };
}

function validateOpcodes(opcodes, dispatches) {
  assert.ok(opcodes && typeof opcodes === "object" && !Array.isArray(opcodes));
  assert.equal(typeof opcodes.incomplete, "boolean");
  u64(opcodes.droppedSamples);
  assert.ok(opcodes.droppedSamples === "0" || opcodes.incomplete);
  assert.ok(Array.isArray(opcodes.counts) && opcodes.counts.length <= 65536);
  const keys = new Set();
  let total = 0n;
  const counts = opcodes.counts.map((entry) => {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    assert.ok(Number.isInteger(entry.opcode) && entry.opcode >= 0 && entry.opcode <= 65535);
    assert.ok(!keys.has(entry.opcode), "duplicate VM opcode");
    keys.add(entry.opcode);
    u64(entry.samples);
    assert.notEqual(entry.samples, "0");
    total += BigInt(entry.samples);
    return { opcode: entry.opcode, samples: entry.samples };
  });
  const opportunities = BigInt(dispatches) / 1024n;
  assert.ok(
    total + BigInt(opcodes.droppedSamples) <= opportunities,
    "VM opcode count and loss exceed sampling opportunities",
  );
  if (!opcodes.incomplete) assert.equal(total, opportunities, "incomplete VM opcode distribution");
  return { incomplete: opcodes.incomplete, droppedSamples: opcodes.droppedSamples, counts };
}
function validatePositions(positions, dispatches) {
  assert.ok(positions && typeof positions === "object");
  assert.equal(typeof positions.active, "boolean");
  assert.equal(typeof positions.incomplete, "boolean");
  for (const key of ["startedAtDispatches", "endedAtDispatches", "droppedSamples"])
    u64(positions[key]);
  assert.ok(BigInt(positions.startedAtDispatches) <= BigInt(positions.endedAtDispatches));
  assert.ok(BigInt(positions.endedAtDispatches) <= BigInt(dispatches));
  assert.ok(positions.droppedSamples === "0" || positions.incomplete);
  assert.ok(Array.isArray(positions.counts) && positions.counts.length <= 65536);
  assert.ok(Array.isArray(positions.locations) && positions.locations.length <= 1024);
  const unprojectedPositions = positions.counts.length - positions.locations.length;
  if (positions.unprojectedPositions !== undefined)
    assert.equal(
      positions.unprojectedPositions,
      unprojectedPositions,
      "VM projection count mismatch",
    );
  const countKeys = new Set();
  for (const [entries, location] of [
    [positions.counts, false],
    [positions.locations, true],
  ]) {
    const keys = new Set();
    for (const entry of entries) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
      u64(entry.generation);
      u64(entry.instruction);
      assert.equal(typeof entry.function, "string");
      assert.match(entry.function, /^[0-9a-f]{32}$/);
      const key = `${entry.generation}:${entry.function}:${entry.instruction}`;
      assert.ok(!keys.has(key), "duplicate VM position key");
      keys.add(key);
      if (!location) {
        u64(entry.samples);
        countKeys.add(key);
      } else {
        assert.ok(countKeys.has(key), "VM location has no sampled position");
        assert.equal(typeof entry.name, "string");
        assert.ok(Array.from(entry.name).length <= 64);
        assert.equal(typeof entry.pathTruncated, "boolean");
        if (entry.path === null) {
          assert.equal(entry.line, null);
          assert.equal(entry.pathTruncated, false);
        } else {
          assert.equal(typeof entry.path, "string");
          assert.ok(Array.from(entry.path).length <= 160);
          u64(entry.line);
          assert.notEqual(entry.line, "0");
        }
      }
    }
  }
  return {
    active: positions.active,
    unprojectedPositions,
    startedAtDispatches: positions.startedAtDispatches,
    endedAtDispatches: positions.endedAtDispatches,
    droppedSamples: positions.droppedSamples,
    incomplete: positions.incomplete,
    counts: positions.counts.map(({ generation, function: name, instruction, samples }) => ({
      generation,
      function: name,
      instruction,
      samples,
    })),
    locations: positions.locations.map(
      ({ generation, function: key, instruction, name, path, pathTruncated, line }) => ({
        generation,
        function: key,
        instruction,
        name,
        path,
        pathTruncated,
        line,
      }),
    ),
  };
}

function validateWindow(profile, boundary, pending) {
  const positions = profile.positions;
  if (boundary.kind === "before") {
    assert.equal(pending, undefined, "VM profile window already open");
    assert.equal(positions.startedAtDispatches, profile.dispatches, "VM window start mismatch");
    assert.equal(positions.endedAtDispatches, profile.dispatches, "VM window end mismatch");
    assert.equal(positions.counts.length, 0, "VM window was not cleared");
    assert.equal(positions.locations.length, 0);
    assert.equal(positions.droppedSamples, "0");
    assert.equal(positions.incomplete, false);
    return { valid: false, reason: "window-open" };
  }
  if (!pending) return { valid: false, reason: "missing-before" };
  assert.equal(pending.command, boundary.command, "VM window command mismatch");
  if (pending.instance !== profile.instance) return { valid: false, reason: "vm-replaced" };
  assert.equal(
    positions.startedAtDispatches,
    pending.startedAtDispatches,
    "VM window start changed",
  );
  if (positions.incomplete || profile.instance === "0")
    return { valid: false, reason: "incomplete" };
  return { valid: true, reason: null };
}

export async function createVmProfileCapture(browser, path, dependencies = {}) {
  assert.ok(isAbsolute(path), "VM profile output must be absolute");
  const file = await (dependencies.open ?? open)(path, "wx");
  let bytes = 0;
  let sequence = 0;
  let closed = false;
  let windowOpen = false;
  let pending;
  return {
    async capture(boundary) {
      assert.ok(!closed, "VM profile capture is closed");
      assert.ok(sequence < 64, "VM profile boundary limit exceeded");
      assert.ok(boundary && ["before", "after"].includes(boundary.kind));
      assert.ok(Number.isSafeInteger(boundary.command) && boundary.command > 0);
      const boundedBoundary = { kind: boundary.kind, command: boundary.command };
      if (boundary.kind === "before") windowOpen = true;
      const json = await browser.execute(
        async (begin) =>
          JSON.stringify(
            await window.__TAURI_INTERNALS__.invoke("performance_audit_instruction_profile", {
              begin,
            }),
          ),
        boundary.kind === "before",
      );
      const profile = validateProfile(
        parsePerformanceObservationJson(json, "VM profile", MAXIMUM_RECORD_BYTES),
      );
      assert.equal(
        profile.positions.active,
        boundary.kind === "before",
        "VM position window state mismatch",
      );
      if (boundary.kind === "after") windowOpen = false;
      const windowVerdict = validateWindow(profile, boundary, pending);
      pending =
        boundary.kind === "before"
          ? {
              command: boundary.command,
              instance: profile.instance,
              startedAtDispatches: profile.positions.startedAtDispatches,
            }
          : undefined;
      const line =
        JSON.stringify({
          schemaVersion: 2,
          acceptanceTiming: false,
          sequence,
          boundary: boundedBoundary,
          profile,
          window: windowVerdict,
        }) + "\n";
      const size = Buffer.byteLength(line);
      assert.ok(
        size <= MAXIMUM_RECORD_BYTES && bytes + size <= MAXIMUM_FILE_BYTES,
        "VM profile output limit exceeded",
      );
      await file.writeFile(line);
      bytes += size;
      sequence += 1;
      return profile;
    },
    async close() {
      if (!closed) {
        closed = true;
        await finishProfileCapture([
          async () => {
            if (windowOpen)
              await browser.execute(async () => {
                await window.__TAURI_INTERNALS__.invoke("performance_audit_instruction_profile", {
                  begin: false,
                });
              });
          },
          () => file.close(),
        ]);
      }
    },
  };
}
