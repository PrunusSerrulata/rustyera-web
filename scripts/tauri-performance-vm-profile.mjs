/* global window */
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parsePerformanceObservationJson } from "./tauri-performance-timing-evidence.mjs";

const MAXIMUM_RECORD_BYTES = 1024 * 1024;
const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;

export function vmProfileBuildFeature(enabled) {
  return enabled ? ",vm-instruction-profile" : "";
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
  assert.equal(profile.schemaVersion, 1);
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
}

export async function createVmProfileCapture(browser, path, dependencies = {}) {
  assert.ok(isAbsolute(path), "VM profile output must be absolute");
  const file = await (dependencies.open ?? open)(path, "wx");
  let bytes = 0;
  let sequence = 0;
  let closed = false;
  return {
    async capture(boundary) {
      assert.ok(!closed, "VM profile capture is closed");
      assert.ok(sequence < 64, "VM profile boundary limit exceeded");
      assert.ok(boundary && ["before", "after"].includes(boundary.kind));
      assert.ok(Number.isSafeInteger(boundary.command) && boundary.command > 0);
      const boundedBoundary = { kind: boundary.kind, command: boundary.command };
      const json = await browser.execute(async () =>
        JSON.stringify(
          await window.__TAURI_INTERNALS__.invoke("performance_audit_instruction_profile"),
        ),
      );
      const profile = parsePerformanceObservationJson(json, "VM profile", MAXIMUM_RECORD_BYTES);
      validateProfile(profile);
      const line =
        JSON.stringify({ schemaVersion: 1, sequence, boundary: boundedBoundary, profile }) + "\n";
      const size = Buffer.byteLength(line);
      assert.ok(
        size <= MAXIMUM_RECORD_BYTES && bytes + size <= MAXIMUM_FILE_BYTES,
        "VM profile output limit exceeded",
      );
      await file.writeFile(line);
      bytes += size;
      sequence += 1;
    },
    async close() {
      if (!closed) {
        closed = true;
        await file.close();
      }
    },
  };
}
