/* global window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PERFORMANCE_TIMING_PAGE_SAMPLES = 512;
const MAXIMUM_PAGE_BYTES = 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 64 * 1024 * 1024;
// Disk evidence keeps its existing independent 64 MiB ceiling, including the
// hex transport expansion and timing metadata. Exhaustion invalidates capture.
const MAXIMUM_ARTIFACT_BYTES = MAXIMUM_EVIDENCE_BYTES - MAXIMUM_PAGE_BYTES;
const MAXIMUM_PAGES = 2048;
const MAXIMUM_COLLECTION_PAGES = 128;

/** WebDriver receives one string, not a native object graph. Parse only on the
 * Node side, with no reviver/coercion of the already lossless JSON wire values.
 * Callers still apply their original semantic, sequence and artifact limits. */
export function parsePerformanceObservationJson(json, label, maximumBytes) {
  assert.equal(typeof json, "string", `${label} must return a JSON string`);
  assert.ok(Buffer.byteLength(json) <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`);
  let value;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new Error(`${label} returned invalid JSON`, { cause });
  }
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must encode an object`,
  );
  return value;
}

/** Final replay telemetry uses the same scalar WebDriver boundary as paged capture. */
export async function readPerformanceAuditTelemetry(browser) {
  return parsePerformanceObservationJson(
    await browser.execute(async () =>
      JSON.stringify(await window.__RUSTYERA_TEST__.performanceAudit(), (_key, value) =>
        value === undefined ? null : value,
      ),
    ),
    "final performance audit",
    MAXIMUM_EVIDENCE_BYTES,
  );
}

/** Consumes the existing audit authority only between timed actions. There is no
 * sampling timer, background reader, second sample buffer, or retry after a destructive read. */
export async function createPerformanceTimingCollector(
  browser,
  directory,
  writes = { writeFile, appendFile },
) {
  await mkdir(directory); // A capture owns a fresh evidence directory; never overwrite old samples.
  const streams = Object.fromEntries(
    ["frontend", "native", "longTasks"].map((name) => [name, { epoch: null, next: 0, dropped: 0 }]),
  );
  let collections = 0;
  let pages = 0;
  let bytes = 0;
  let failed = false;
  let completed = false;
  let lastBoundary;
  let originEpochs;
  let deadline;
  let manifestTail = Promise.resolve();
  await manifest("open");
  return {
    collect,
    complete: async () => {
      assert.ok(!failed, "cannot complete failed timing evidence");
      try {
        await bounded(() => manifest("complete"));
        completed = true;
      } catch (error) {
        await fail(error);
        throw error;
      }
    },
    fail,
  };

  async function fail(error) {
    failed = true;
    const report = manifest("failed", String(error)).catch((manifestError) => {
      if (error instanceof Error) error.manifestError = String(manifestError);
    });
    if (deadline == null || Date.now() < deadline) {
      try {
        await bounded(() => report);
      } catch {
        /* The queued write remains observed. */
      }
    }
  }

  async function bounded(operation) {
    assert.ok(deadline != null && Date.now() < deadline, "timing collection exceeded 30000 ms");
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          assert.ok(Date.now() < deadline, "timing collection exceeded 30000 ms");
          return operation();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timing collection exceeded 30000 ms")),
            deadline - Date.now(),
          );
        }),
      ]);
      assert.ok(Date.now() < deadline, "timing collection exceeded 30000 ms");
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function manifest(status, error) {
    const json = JSON.stringify({
      schemaVersion: 1,
      status,
      error,
      lastBoundary,
      collections,
      pages,
      bytes,
      streams,
      originEpochs,
      pageSampleLimit: PERFORMANCE_TIMING_PAGE_SAMPLES,
      pageByteLimit: MAXIMUM_PAGE_BYTES,
      totalByteLimit: MAXIMUM_ARTIFACT_BYTES + MAXIMUM_PAGE_BYTES,
      source: "existing-frontend-and-native-performance-audit",
      probeOverhead: "unmeasured",
      atomicCrossHostSnapshot: false,
    });
    assert.ok(
      Buffer.byteLength(json) <= MAXIMUM_PAGE_BYTES,
      "timing manifest exceeds its reserved limit",
    );
    manifestTail = manifestTail
      .catch(() => {})
      .then(() => writes.writeFile(path.join(directory, "manifest.json"), json));
    await manifestTail;
  }

  async function writeArtifact(name, value) {
    const json = JSON.stringify(value);
    const size = Buffer.byteLength(json);
    assert.ok(
      size <= MAXIMUM_PAGE_BYTES,
      `timing evidence page exceeds ${MAXIMUM_PAGE_BYTES} bytes`,
    );
    assert.ok(
      bytes + size <= MAXIMUM_ARTIFACT_BYTES,
      "timing evidence exceeds its 64 MiB encoded artifact limit",
    );
    await bounded(() => writes.writeFile(path.join(directory, name), json, { flag: "wx" }));
    bytes += size;
    return { file: name, bytes: size, sha256: createHash("sha256").update(json).digest("hex") };
  }

  async function collect(boundary, includeIdentity = false) {
    assert.ok(!failed, "cannot continue failed timing evidence");
    assert.ok(!completed, "cannot continue completed timing evidence");
    lastBoundary = boundary;
    deadline = Date.now() + 30_000;
    const id = String(collections++).padStart(4, "0");
    const first = structuredClone(streams);
    const files = [];
    const issues =
      boundary.observationsComplete === false ? ["pending observations incomplete"] : [];
    const frontendStages = new Map();
    const nativeStages = new Map();
    const longTaskDurations = metric();
    let identity;
    let longTaskObserverInstalled = false;
    let finished = false;
    try {
      for (let page = 0; page < MAXIMUM_COLLECTION_PAGES; page += 1) {
        assert.ok(pages < MAXIMUM_PAGES, "timing evidence exceeds its page-count limit");
        const chunk = await readPage(includeIdentity && page === 0);
        // Persist the exact returned page before interpreting gaps/drops. Partial or
        // failed captures keep this frontier; a consumed page is never silently retried.
        const file = await writeArtifact(`${id}.page-${String(page).padStart(3, "0")}.json`, {
          schemaVersion: 1,
          boundary,
          collectedAt: new Date().toISOString(),
          raw: chunk,
        });
        files.push(file);
        pages += 1;
        assert.ok(chunk?.frontend && chunk?.native, "timing page omitted an audit origin");
        const front = chunk.frontend;
        const native = chunk.native;
        longTaskObserverInstalled ||= front.longTaskObserverInstalled === 1;
        assert.equal(front.schemaVersion, 2, "unsupported frontend timing schema");
        assert.equal(native.schemaVersion, 2, "unsupported native timing schema");
        if (native.nativeEvidence) {
          assert.equal(native.nativeEvidence.failure, null, "native evidence is truncated");
          const evidence = native.nativeEvidence;
          streams.nativeEvidence ??= {
            epoch: null,
            next: 0,
            dropped: 0,
            offset: 0,
            totalBytes: 0,
            bytes: 0,
            allocation: 0,
            frontier: 0,
          };
          assert.ok(
            Number.isSafeInteger(evidence.cumulativeBytes) &&
              evidence.cumulativeBytes <= MAXIMUM_EVIDENCE_BYTES,
            "native evidence exceeds 64 MiB",
          );
          validateNativeEvidence(evidence, streams.nativeEvidence);
        }
        originEpochs ??= { frontend: front.epoch, native: native.epoch };
        validateStream(
          "frontend",
          front.epoch,
          front.nextSequence,
          front.timingSamplesDropped,
          front.remainingSamples,
          front.timings,
        );
        validateStream(
          "native",
          native.epoch,
          native.nextSequence,
          native.dropped,
          native.remainingSamples,
          native.pumps,
        );
        validateStream(
          "longTasks",
          front.epoch,
          front.nextLongTaskSequence,
          front.longTasksDropped,
          front.remainingLongTasks,
          front.longTasks,
        );
        if (includeIdentity && page === 0) {
          assert.ok(
            native.coreClient && Array.isArray(native.setupMessages),
            "timing page omitted the real session identity",
          );
          identity = { coreClient: native.coreClient, setupMessages: native.setupMessages };
        }
        for (const sample of front.timings) {
          assert.equal(typeof sample.phase, "string");
          assert.equal(typeof sample.operation, "string");
          const key = JSON.stringify([sample.phase, sample.operation]);
          const stage = frontendStages.get(key) ?? {
            phase: sample.phase,
            operation: sample.operation,
            durationMs: metric(),
          };
          add(stage.durationMs, sample.elapsedMs);
          frontendStages.set(key, stage);
        }
        for (const sample of native.pumps) {
          assert.equal(typeof sample.operation, "string");
          const stage = nativeStages.get(sample.operation) ?? {
            operation: sample.operation,
            requestDecodeMs: metric(),
            nativeDriveMs: metric(),
            nativeSetupMs: metric(),
            nativeThreadCpuMs: metric(),
            jsonSerializeMs: metric(),
            responseBytes: metric(),
            events: metric(),
            vmInstructions: metric(),
            runtimeTransitions: metric(),
          };
          for (const field of ["responseBytes", "events", "vmInstructions", "runtimeTransitions"])
            assert.ok(
              Number.isSafeInteger(sample[field]),
              `native ${field} lost integer precision`,
            );
          for (const field of [
            "requestDecodeMs",
            "nativeDriveMs",
            "jsonSerializeMs",
            "responseBytes",
            "events",
            "vmInstructions",
            "runtimeTransitions",
          ])
            add(stage[field], sample[field]);
          // Older audit builds and unsupported platforms omit CPU attribution; retain zero
          // samples, not an invented zero-duration measurement. Existing required fields stay strict.
          for (const field of ["nativeSetupMs", "nativeThreadCpuMs"])
            if (sample[field] != null) add(stage[field], sample[field]);
          nativeStages.set(sample.operation, stage);
        }
        for (const sample of front.longTasks) add(longTaskDurations, sample.elapsedMs);
        if (
          front.remainingSamples === 0 &&
          native.remainingSamples === 0 &&
          (native.nativeEvidence?.remainingRecords ?? 0) === 0 &&
          (native.nativeEvidencePendingPages ?? 0) === 0 &&
          front.remainingLongTasks === 0
        ) {
          finished = true;
          break;
        }
      }
      assert.ok(finished, "timing collection exceeded its bounded page budget");
      const summary = {
        schemaVersion: 1,
        boundary,
        complete: issues.length === 0,
        issues,
        rawPages: files,
        streamStart: first,
        originEpochs,
        streamEnd: structuredClone(streams),
        frontendStages: [...frontendStages.values()],
        nativeStages: [...nativeStages.values()],
        longTaskDurations,
        longTaskObserverInstalled,
        attribution:
          "record-arrival-between-drains; asynchronous completions can cross action boundaries",
        accounting:
          "frontend invoke includes native stages; do not sum overlapping layers or long tasks",
        nativeCpuAccounting:
          "thread CPU excludes SQL owner work, blocked time and descheduling; setup includes locks and submission before drive; neither measures probe overhead",
        probeOverhead: "unmeasured",
        atomicCrossHostSnapshot: false,
      };
      const summaryFile = await writeArtifact(`${id}.summary.json`, summary);
      const entry = JSON.stringify({ boundary, ...summaryFile, complete: summary.complete });
      assert.ok(
        bytes + Buffer.byteLength(entry) + 1 <= MAXIMUM_ARTIFACT_BYTES,
        "timing index exceeds evidence budget",
      );
      await bounded(() => writes.appendFile(path.join(directory, "index.jsonl"), `${entry}\n`));
      bytes += Buffer.byteLength(entry) + 1;
      assert.ok(summary.complete, `timing evidence is incomplete: ${issues.join("; ")}`);
      assert.ok(Date.now() < deadline, "timing collection exceeded 30000 ms");
      return {
        identity,
        directory,
        summaryFile: summaryFile.file,
        boundary,
        rawPages: files.length,
        streamEnd: summary.streamEnd,
        probeOverhead: "unmeasured",
      };
    } catch (error) {
      await fail(error);
      throw error;
    }

    async function readPage(identityRequested) {
      return bounded(async () =>
        parsePerformanceObservationJson(
          await browser.execute(
            async (limit, includeIdentity) =>
              JSON.stringify(
                await window.__RUSTYERA_TEST__.takePerformanceAudit(limit, includeIdentity),
                (_key, value) => (value === undefined ? null : value),
              ),
            PERFORMANCE_TIMING_PAGE_SAMPLES,
            identityRequested,
          ),
          "timing evidence page",
          MAXIMUM_PAGE_BYTES,
        ),
      );
    }

    function validateStream(name, epoch, nextSequence, dropped, remaining, samples) {
      for (const value of [epoch, nextSequence, dropped, remaining])
        assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} has an invalid counter`);
      assert.ok(
        Array.isArray(samples) && samples.length <= PERFORMANCE_TIMING_PAGE_SAMPLES,
        `${name} has an invalid bounded sample page`,
      );
      const state = streams[name];
      if (state.epoch == null) state.epoch = epoch;
      if (state.epoch !== epoch) issues.push(`${name} epoch changed`);
      if (dropped !== state.dropped)
        issues.push(`${name} dropped changed ${state.dropped} -> ${dropped}`);
      for (const sample of samples) {
        assert.ok(
          Number.isSafeInteger(sample.sequence) && sample.sequence >= 0,
          `${name} has an invalid sample sequence`,
        );
        if (sample.epoch !== epoch || sample.sequence !== state.next)
          issues.push(
            `${name} expected epoch/sequence ${epoch}/${state.next}, got ${sample.epoch}/${sample.sequence}`,
          );
        state.next = sample.sequence + 1;
      }
      if (nextSequence !== state.next + remaining)
        issues.push(`${name} retained frontier does not match nextSequence`);
      state.dropped = dropped;
      assert.ok(issues.length < 32, "timing page has too many identity failures");
    }
  }
}

function validateNativeEvidence(page, state) {
  assert.ok(
    Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024,
    "native evidence page exceeds 512 KiB",
  );
  for (const value of [page.epoch, page.nextSequence, page.remainingRecords, page.cumulativeBytes])
    assert.ok(Number.isSafeInteger(value) && value >= 0, "native evidence invalid counter");
  assert.ok(
    page.cumulativeBytes >= state.allocation && page.nextSequence >= state.frontier,
    "native evidence regressed",
  );
  state.epoch ??= page.epoch;
  assert.equal(page.epoch, state.epoch, "native evidence epoch changed");
  assert.ok(
    Array.isArray(page.records) && page.records.length <= 1024,
    "native evidence invalid chunks",
  );
  for (const chunk of page.records) {
    for (const value of [chunk.sequence, chunk.offset, chunk.totalBytes])
      assert.ok(Number.isSafeInteger(value) && value >= 0, "native evidence invalid chunk counter");
    assert.equal(chunk.sequence, state.next, "native evidence sequence gap");
    assert.equal(chunk.offset, state.offset, "native evidence offset gap");
    assert.ok(
      typeof chunk.cborHex === "string" && /^(?:[0-9a-f]{2})+$/.test(chunk.cborHex),
      "native evidence invalid hex",
    );
    if (state.offset === 0) state.totalBytes = chunk.totalBytes;
    assert.equal(chunk.totalBytes, state.totalBytes, "native evidence record size changed");
    assert.ok(
      chunk.totalBytes > 0 && chunk.totalBytes <= MAXIMUM_EVIDENCE_BYTES,
      "native evidence record size invalid",
    );
    state.offset += chunk.cborHex.length / 2;
    assert.ok(state.offset <= state.totalBytes, "native evidence chunk overrun");
    if (state.offset === state.totalBytes) {
      state.bytes += state.totalBytes;
      assert.ok(
        state.bytes <= MAXIMUM_EVIDENCE_BYTES,
        "native evidence encoded total exceeds limit",
      );
      state.next++;
      state.offset = 0;
      state.totalBytes = 0;
    }
  }
  assert.equal(
    page.nextSequence,
    state.next + page.remainingRecords,
    "native evidence truncated frontier",
  );
  assert.ok(
    state.bytes + state.totalBytes <= page.cumulativeBytes,
    "native evidence allocation frontier is too small",
  );
  assert.ok(state.offset === 0 || page.remainingRecords > 0, "native evidence truncated record");
  state.allocation = page.cumulativeBytes;
  state.frontier = page.nextSequence;
}

function metric() {
  return { count: 0, total: 0, minimum: null, maximum: null };
}
function add(metric, value) {
  assert.ok(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "invalid timing metric",
  );
  metric.count += 1;
  metric.total += value;
  metric.minimum = metric.minimum == null ? value : Math.min(metric.minimum, value);
  metric.maximum = metric.maximum == null ? value : Math.max(metric.maximum, value);
}
