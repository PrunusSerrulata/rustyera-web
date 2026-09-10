/* global window */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3.js";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import {
  createPerformanceTimingCollector,
  parsePerformanceObservationJson,
} from "./tauri-performance-timing-evidence.mjs";

import {
  clickTauriTestElement,
  hoverTauriTestElement,
  secondaryClickTauriTestElement,
  setTauriTestInput,
} from "./dom-test-input.mjs";
import { backgroundDomClockScript } from "./tauri-performance-dom-clock.mjs";

export const PERFORMANCE_PATHS = ["loading", "steady-runtime", "map-nf-sql", "save-load"];
export const PERFORMANCE_TRACE_SCHEMA_VERSION = 3;
export const MAXIMUM_PERFORMANCE_TRACE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_PROTOCOL_RESULT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PROTOCOL_RESULTS = 65_536;
const protocolResultBudgets = new WeakMap();
let checkpointEvidenceSequence = 0;
const REQUIRED_EVIDENCE = {
  loading: ["title", "newGame", "qol", "sql", "map", "privateRoom", "day1"],
  "steady-runtime": ["dailyLoop", "longOutput", "dynamicCall", "formatting", "stringWork"],
  "map-nf-sql": ["mapRoundtrip", "hover", "click", "nf", "scene", "canvas", "sprite", "sqlPath"],
  "save-load": ["ordinarySave", "ordinaryLoad", "stableReturn"],
};

export function performanceScenarioEvidence(scenario) {
  if (scenario === "snake-tw-runtime-four-paths") return REQUIRED_EVIDENCE;
  if (scenario === "ordinary-save-runtime")
    return {
      "save-load": ["ordinaryLoad", "stableReturn"],
      "steady-runtime": ["runtimeInteraction"],
    };
  throw new Error("unexpected performance scenario");
}

function assertScenarioPathOrder(scenario, paths) {
  const order = Object.keys(performanceScenarioEvidence(scenario));
  let previous = -1;
  for (const path of paths) {
    const index = order.indexOf(path);
    assert.ok(index >= 0, `unexpected scenario path ${path}`);
    assert.ok(index >= previous, "performance scenario paths are out of order");
    previous = index;
  }
}

export async function readPerformanceTrace(path) {
  const trace = await readBoundedTraceJson(path);
  validateTrace(trace, false);
  return trace;
}

export async function freezePerformanceTrace(candidatePath, outputPath, coreOutputPath) {
  const trace = await readBoundedTraceJson(candidatePath);
  assert.equal(trace.replayTarget, undefined, "Core companion requires a complete capture");
  validateTrace(trace, true);
  trace.captureRequired = false;
  trace.traceDigest = traceHash(trace);
  validateTrace(trace, false);
  const coreTrace = coreTraceFromPerformanceTrace(trace);
  await writeJsonAtomically(outputPath, trace);
  if (coreOutputPath) await writeJsonAtomically(coreOutputPath, coreTrace);
  return { trace, coreTrace };
}

export async function freezeTauriPerformanceTrace(candidatePath, outputPath) {
  const trace = await readBoundedTraceJson(candidatePath);
  validateTrace(trace, true);
  trace.replayTarget = "tauri";
  trace.captureRequired = false;
  trace.traceDigest = traceHash(trace);
  validateTrace(trace, false);
  await writeJsonAtomically(outputPath, trace);
  return trace;
}

export function coreTraceFromPerformanceTrace(trace) {
  assert.equal(trace.replayTarget, undefined, "Tauri-only trace has no validated Core companion");
  validateTrace(trace, false);
  validateCoreCapture(trace.core, trace.steps, trace.protocolResults);
  const steps = trace.core.steps.map(({ id, checkpoint, expect, action }) => ({
    id,
    checkpoint,
    expect: sortKeys(expect),
    action: coreTraceAction(action),
  }));
  const resultRefs = new Set(
    steps.map((step) => step.action.resultRef).filter((resultRef) => resultRef != null),
  );
  const coreTrace = {
    schemaVersion: 2,
    traceDigest: "",
    scenario: trace.scenario,
    projectDigest: trace.core.projectDigest,
    seed: trace.seed,
    client: trace.core.client,
    setupMessages: trace.core.setupMessages,
    protocolResults: Object.fromEntries(
      Object.entries(trace.protocolResults).filter(([resultRef]) => resultRefs.has(resultRef)),
    ),
    steps,
  };
  coreTrace.traceDigest = digestWithoutField(coreTrace, "traceDigest");
  return coreTrace;
}

export async function replayPerformanceTrace(browser, trace, onCheckpoint = () => undefined) {
  validateTrace(trace, false);
  const paths = [];
  let protocolCursor = null;
  for (const pathClass of Object.keys(performanceScenarioEvidence(trace.scenario))) {
    const steps = trace.steps.filter((step) => step.path === pathClass);
    const startedAt = performance.now();
    const inputSamples = [];
    const responseTimingBases = new Set();
    const diagnosticSamples = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const before = await capturePerformanceCheckpoint(
        browser,
        step.expect.watches,
        protocolCursor,
      );
      protocolCursor = before.value.coreProjection.protocolCursor;
      assertWait(step.expect.wait, before.value.wait, `${pathClass}[${index}]`);
      const inputElapsedMs = await performTimedAction(
        browser,
        step.action,
        before,
        step.expect.settle,
        step.expect.watches,
      );
      const after = await capturePerformanceCheckpoint(
        browser,
        step.expect.watches,
        protocolCursor,
      );
      protocolCursor = after.value.coreProjection.protocolCursor;
      const mismatchEvidence = process.env.RUSTYERA_TAURI_PERF_MISMATCH_EVIDENCE;
      if (after.hash !== step.expect.checkpointHash && mismatchEvidence)
        await writeFile(
          mismatchEvidence,
          gzipSync(JSON.stringify({ path: pathClass, step: index, before, after })),
          { flag: "wx" },
        );
      assert.equal(
        after.hash,
        step.expect.checkpointHash,
        `${pathClass}[${index}] scenario signature mismatch`,
      );
      const timingBasis = performanceTimingBasis(step.expect.settle);
      if (
        ["action-to-stable-observation", "dom-action-to-stable-observation"].includes(timingBasis)
      ) {
        inputSamples.push(inputElapsedMs);
        responseTimingBases.add(timingBasis);
      } else diagnosticSamples.push({ elapsedMs: inputElapsedMs, timingBasis, step: index });
      await onCheckpoint({ path: pathClass, step: index, before, after, inputElapsedMs });
    }
    assert.ok(responseTimingBases.size <= 1, "cannot mix action clock bases");
    paths.push({
      id: pathClass,
      class: pathClass,
      elapsedMs: performance.now() - startedAt,
      responseSamplesMs: inputSamples,
      responseTimingBasis: [...responseTimingBases][0] ?? null,
      diagnosticResponseSamples: diagnosticSamples,
      inputMs: summarizeSamples(inputSamples),
    });
  }
  return { paths };
}

export async function runPerformanceTraceCapture(browser, options) {
  const timing = await createPerformanceTimingCollector(
    browser,
    `${options.candidatePath}.timings`,
  );
  try {
    return await capturePerformanceTraceWithTiming(browser, options, timing);
  } catch (error) {
    await timing.fail(error).catch(() => {});
    throw error;
  }
}

async function capturePerformanceTraceWithTiming(
  browser,
  {
    templatePath,
    candidatePath,
    actionInboxPath,
    projectDigest,
    onObservation = () => undefined,
    onTimingEvidence = () => undefined,
    beforeTimedAction = () => undefined,
    afterTimedAction = () => undefined,
    acceptanceTiming = true,
  },
  timing,
) {
  const trace = await readBoundedTraceJson(templatePath);
  assert.equal(
    trace.schemaVersion,
    PERFORMANCE_TRACE_SCHEMA_VERSION,
    "unsupported performance trace schema",
  );
  assert.equal(trace.captureRequired, true, "capture must start from a candidate template");
  const scenarioEvidence = performanceScenarioEvidence(trace.scenario);
  trace.projectDigest = projectDigest;
  trace.core.projectDigest = projectDigest;
  const startupTiming = await timing.collect(
    {
      kind: "startup",
      acceptanceTiming,
      sourceWebStep: null,
      projectDigest,
      profile: trace.profile,
      seed: trace.seed,
      clock: trace.clock,
    },
    true,
  );
  await onTimingEvidence({ ...startupTiming, identity: undefined });
  const audit = { native: startupTiming.identity };
  assert.ok(
    audit.native?.coreClient,
    "native performance capture omitted the actual ClientHello projection",
  );
  assert.ok(
    Array.isArray(audit.native?.setupMessages),
    "native performance capture omitted setupMessages",
  );
  trace.core.client = audit.native.coreClient;
  trace.core.setupMessages = audit.native.setupMessages;
  trace.steps = [];
  trace.protocolResults = {};
  trace.core.steps = [];
  trace.coverage = Object.fromEntries(
    Object.keys(scenarioEvidence).map((pathClass) => [pathClass, {}]),
  );
  await writeJsonAtomically(candidatePath, trace);
  let processed = 0;
  let lastCheckpoint;
  let protocolCursor = null;
  for (;;) {
    const commands = await readJsonLines(actionInboxPath);
    if (processed >= commands.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const command = commands[processed++];
    if (command.type === "finish") {
      if (lastCheckpoint) {
        assert.ok(
          !trace.core.steps.some((step) => step.action?.kind === "none"),
          "only capture may append the final Core none action",
        );
        trace.core.steps.push({
          id: "final",
          checkpoint: "final",
          expect: coreCheckpointExpectation(lastCheckpoint.coreProjection.normalizedState),
          action: { kind: "none" },
        });
      }
      await writeJsonAtomically(candidatePath, trace);
      let pendingError;
      try {
        await browser.execute(() =>
          window.__RUSTYERA_TEST__.waitForPendingPerformanceObservations(30_000),
        );
      } catch (error) {
        pendingError = error;
      }
      await onTimingEvidence(
        await timing.collect({
          kind: "final",
          acceptanceTiming,
          sourceWebStep: null,
          observationsComplete: pendingError == null,
        }),
      );
      if (pendingError) throw pendingError;
      await timing.complete();
      return trace;
    }
    if (command.type === "core_steps") {
      assert.ok(
        Number.isSafeInteger(command.sourceWebStep) && trace.steps[command.sourceWebStep],
        "core_steps requires an existing sourceWebStep",
      );
      assert.ok(
        Array.isArray(command.coreSteps) && command.coreSteps.length > 0,
        "core_steps omitted mappings",
      );
      for (const coreStep of command.coreSteps)
        trace.core.steps.push(compactCoreStep(coreStep, command.sourceWebStep, trace));
      await writeJsonAtomically(candidatePath, trace);
      continue;
    }
    assert.equal(command.type, "action", "capture inbox accepts only action or finish records");
    assert.ok(
      Object.hasOwn(scenarioEvidence, command.path),
      `unknown capture path ${command.path}`,
    );
    assertScenarioPathOrder(trace.scenario, [
      ...trace.steps.map((step) => step.path),
      command.path,
    ]);
    validatePerformanceTraceAction(command.action, command.path);
    assert.ok(
      Array.isArray(command.watches) && command.watches.length > 0,
      "capture action requires key-variable watches",
    );
    const settle =
      command.settle ?? (command.action.type === "hover" ? "checkpoint_change" : "wait_change");
    assert.ok(
      ["wait_change", "checkpoint_change"].includes(settle),
      "invalid capture settle policy",
    );
    const before = await capturePerformanceCheckpoint(browser, command.watches, protocolCursor);
    protocolCursor = before.value.coreProjection.protocolCursor;
    if (trace.steps.length === 0) {
      trace.core.setupMessages = [
        ...trace.core.setupMessages,
        ...before.value.coreProjection.setupMessages,
      ];
      trace.core.captureIdentityDigest = checkpointHash({
        client: trace.core.client,
        setupMessages: trace.core.setupMessages,
      });
    }
    const inputElapsedMs = await performTimedAction(
      browser,
      command.action,
      before,
      settle,
      command.watches,
      async () => {
        await onTimingEvidence(
          await timing.collect({
            kind: "setup",
            acceptanceTiming,
            command: processed,
            sourceWebStep: trace.steps.length,
            path: command.path,
          }),
        );
        await beforeTimedAction({ command: processed, path: command.path, settle });
      },
    );
    await afterTimedAction({ command: processed, path: command.path });
    const actionTiming = await timing.collect({
      kind: "action",
      command: processed,
      sourceWebStep: trace.steps.length,
      path: command.path,
      inputElapsedMs,
      timingBasis: acceptanceTiming ? performanceTimingBasis(settle) : "diagnostic-only",
      acceptanceTiming,
    });
    await onTimingEvidence(actionTiming);
    const after = await capturePerformanceCheckpoint(browser, command.watches, protocolCursor);
    protocolCursor = after.value.coreProjection.protocolCursor;
    const protocolActions = internProtocolActions(
      trace,
      protocolActionDelta(before.value, after.value),
    );
    assertSecondaryClickProtocolActions(command.action, protocolActions, command.path);
    trace.steps.push({
      path: command.path,
      action: command.action,
      expect: {
        wait: before.value.wait,
        settle,
        watches: command.watches,
        checkpointHash: after.hash,
      },
      protocolActions,
    });
    const coreSteps =
      command.coreSteps ??
      (command.action.type !== "hover" && protocolActions.length === 1
        ? [
            {
              id: `${command.path}-${trace.steps.length}`,
              checkpoint: `${command.path}-${trace.steps.length}`,
              normalizedState: before.value.coreProjection.normalizedState,
              action: protocolActions[0],
            },
          ]
        : []);
    for (const coreStep of coreSteps)
      trace.core.steps.push(compactCoreStep(coreStep, trace.steps.length - 1, trace));
    lastCheckpoint = after.value;
    Object.assign(trace.coverage[command.path], command.evidence);
    await writeJsonAtomically(candidatePath, trace);
    await onObservation({
      command: processed,
      path: command.path,
      before: checkpointObservationSummary(before),
      after: checkpointObservationSummary(after),
      inputElapsedMs,
      timingBasis: acceptanceTiming ? performanceTimingBasis(settle) : "diagnostic-only",
      acceptanceTiming,
      timingEvidence: { directory: actionTiming.directory, summaryFile: actionTiming.summaryFile },
      protocolActionCount: protocolActions.length,
      protocolActions: protocolActions.map(protocolActionSummary),
    });
  }
}

export async function capturePerformanceCheckpoint(browser, watches, protocolCursor = null) {
  assert.ok(
    Array.isArray(watches) && watches.length > 0,
    "checkpoint requires key-variable watches",
  );
  // The checkpoint (including coreProjection) is already JSON-safe. Encoding in
  // the WebView avoids WebDriver's recursive native conversion of every object
  // and byte array. This remains outside the existing action timing boundary.
  const raw = parsePerformanceObservationJson(
    await browser.execute(
      async (requestedWatches, requestedCursor) =>
        JSON.stringify(
          await window.__RUSTYERA_TEST__.performanceCheckpoint(requestedWatches, requestedCursor),
          // WebDriver's object conversion retains undefined properties as null.
          (_key, value) => (value === undefined ? null : value),
        ),
      watches,
      protocolCursor,
    ),
    "performance checkpoint",
    MAXIMUM_PERFORMANCE_TRACE_BYTES,
  );
  if (raw.coreProjection?.protocolActions)
    raw.coreProjection.protocolActions = await restoreNativeReplayBytes(
      browser,
      raw.coreProjection.protocolActions,
    );
  const value = canonicalizeCheckpoint(raw);
  const checkpoint = { value, hash: performanceCheckpointBehaviorHash(value) };
  const evidencePrefix = process.env.RUSTYERA_TAURI_PERF_CHECKPOINT_EVIDENCE;
  if (evidencePrefix)
    await writeFile(
      `${evidencePrefix}.${checkpointEvidenceSequence++}.json.gz`,
      gzipSync(JSON.stringify(checkpoint)),
      { flag: "wx" },
    );
  return checkpoint;
}

async function restoreNativeReplayBytes(browser, actions) {
  const deadline = Date.now() + 30_000;
  let cumulative = 0;
  const restore = async (value) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "nativeReplayBytes")) {
      assert.ok(
        Number.isSafeInteger(value.nativeReplayBytes) &&
          value.nativeReplayBytes >= 0 &&
          Number.isSafeInteger(value.byteLength) &&
          value.byteLength >= 0 &&
          /^[0-9a-f]{64}$/.test(value.blake3),
        "invalid native replay byte reference",
      );
      cumulative += value.byteLength;
      assert.ok(cumulative <= 64 * 1024 * 1024, "native replay bytes exceed capture bound");
      const bytes = Buffer.alloc(value.byteLength);
      let offset = 0;
      do {
        assert.ok(Date.now() < deadline, "native replay byte export deadline exceeded");
        const chunk = parsePerformanceObservationJson(
          await browser.execute(
            (id, offset) =>
              JSON.stringify(
                window.__RUSTYERA_TEST__.takeNativeReplayBytes(id, offset),
                (_key, value) => (value === undefined ? null : value),
              ),
            value.nativeReplayBytes,
            offset,
          ),
          "native replay byte page",
          512 * 1024,
        );
        assert.ok(Date.now() < deadline, "native replay byte export deadline exceeded");
        assert.equal(chunk.offset, offset, "native replay byte gap");
        assert.equal(chunk.totalBytes, bytes.length, "native replay byte length changed");
        assert.ok(
          typeof chunk.hex === "string" &&
            /^(?:[0-9a-f]{2})*$/.test(chunk.hex) &&
            Buffer.byteLength(JSON.stringify(chunk)) <= 512 * 1024,
          "invalid native replay byte page",
        );
        const part = Buffer.from(chunk.hex, "hex");
        assert.ok(
          part.length <= bytes.length - offset && (part.length > 0 || bytes.length === 0),
          "native replay byte truncation",
        );
        bytes.set(part, offset);
        offset += part.length;
      } while (offset < bytes.length);
      assert.equal(
        Buffer.from(blake3(bytes)).toString("hex"),
        value.blake3,
        "native replay byte digest mismatch",
      );
      return Array.from(bytes);
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const child of value) result.push(await restore(child));
      return result;
    }
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = await restore(child);
      return result;
    }
    return value;
  };
  const result = [];
  for (const action of actions)
    result.push(action.nativeCompletion ? await restore(action) : action);
  return result;
}

/** Raw records keep their route and identities. Only this semantic projection is hashed. */
export function performanceCheckpointBehaviorHash(value) {
  const hashValue = {
    ...value,
    service: omitVolatileIdentity(value.service),
    transfer: omitVolatileIdentity(value.transfer),
    storage: value.storage && {
      ...omitVolatileIdentity(value.storage),
      records: (value.storage.records ?? []).map((record) => ({
        direction: record.direction,
        message: semanticStorageMessage(record.message),
      })),
    },
  };
  if (hashValue.coreProjection) {
    hashValue.coreProjection = { ...hashValue.coreProjection };
    delete hashValue.coreProjection.protocolCursor;
    // Host ownership is capture metadata, not a change to the canonical game state.
    if (Array.isArray(hashValue.coreProjection.protocolActions))
      hashValue.coreProjection.protocolActions = hashValue.coreProjection.protocolActions.map(
        (action) => {
          const canonical = { ...action };
          delete canonical.nativeCompletion;
          if (canonical.kind === "storage_response")
            canonical.result = semanticStorageBytes(canonical.result);
          return canonical;
        },
      );
  }
  // Sort the semantic projection after dropping only capture/transport metadata.
  return hashCheckpointJson(JSON.stringify(sortKeys(hashValue)));
}

function semanticStorageMessage(message) {
  const value = { ...message.value };
  delete value.request_id;
  // These identify delivery, not a change to stored content or completion semantics.
  delete value.deadline_ns;
  delete value.idempotency_key;
  if (value.operation) value.operation = semanticStorageBytes(value.operation);
  if (value.result) value.result = semanticStorageBytes(value.result);
  return { type: message.type, value };
}

function semanticStorageBytes(container) {
  if (!container || !("data" in container)) return container;
  const data = container.data;
  if (data?.observation === "bulk_bytes_digest") {
    assert.ok(
      Number.isSafeInteger(data.byteLength) &&
        data.byteLength >= 0 &&
        /^[0-9a-f]{64}$/.test(data.blake3),
      "invalid storage digest",
    );
    return { ...container, data: { byteLength: data.byteLength, blake3: data.blake3 } };
  }
  assert.ok(data instanceof Uint8Array || Array.isArray(data), "storage evidence omitted bytes");
  const hash = blake3.create();
  for (let offset = 0; offset < data.length; offset += 65536) {
    const part = data.slice(offset, offset + 65536);
    assert.ok(
      part.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
      "invalid storage byte",
    );
    hash.update(Uint8Array.from(part));
  }
  return {
    ...container,
    data: { byteLength: data.length, blake3: Buffer.from(hash.digest()).toString("hex") },
  };
}

export function summarizeRuns(runs) {
  runs = runs.filter((run) => run.acceptanceTiming !== false);
  const paths = [...new Set(runs.flatMap((run) => run.paths.map((entry) => entry.class)))];
  const bases = new Set(
    runs.flatMap((run) =>
      run.paths
        .filter((entry) => entry.responseSamplesMs?.length)
        .map((entry) => entry.responseTimingBasis ?? "action-to-stable-observation"),
    ),
  );
  assert.ok(bases.size <= 1, "cannot mix action clock bases");
  const byPath = Object.fromEntries(
    paths.map((pathClass) => [
      pathClass,
      summarizeSamples(
        runs.flatMap((run) =>
          run.paths
            .filter((entry) => entry.class === pathClass)
            .flatMap((entry) => entry.responseSamplesMs ?? []),
        ),
      ),
    ]),
  );
  const harnessByPath = Object.fromEntries(
    paths.map((pathClass) => [
      pathClass,
      summarizeSamples(
        runs.flatMap((run) =>
          run.paths.filter((entry) => entry.class === pathClass).map((entry) => entry.elapsedMs),
        ),
      ),
    ]),
  );
  return { runs: runs.length, responseTimingBasis: [...bases][0] ?? null, byPath, harnessByPath };
}

export function summarizeSamples(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const mean = samples.length
    ? samples.reduce((total, value) => total + value, 0) / samples.length
    : 0;
  const variance = samples.length
    ? samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length
    : 0;
  return {
    count: samples.length,
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95),
    p99: percentile(ordered, 0.99),
    minimum: ordered[0] ?? null,
    maximum: ordered.at(-1) ?? null,
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
}

function validateTrace(trace, candidate) {
  assert.ok(
    trace.replayTarget === undefined || trace.replayTarget === "tauri",
    "unsupported replay target",
  );
  assert.equal(
    trace.schemaVersion,
    PERFORMANCE_TRACE_SCHEMA_VERSION,
    "unsupported performance trace schema",
  );
  const requiredEvidence = performanceScenarioEvidence(trace.scenario);
  assert.equal(
    trace.profile,
    "emuera.skia.snake",
    "performance trace selected a non-snake profile",
  );
  assert.ok(
    Number.isSafeInteger(trace.seed) && trace.seed >= 0,
    "performance trace seed must be a non-negative safe integer",
  );
  assert.ok(
    typeof trace.clock === "string" &&
      Number.isFinite(Date.parse(trace.clock)) &&
      new Date(trace.clock).toISOString() === trace.clock,
    "performance trace clock must be a canonical ISO timestamp",
  );
  assert.equal(
    trace.captureRequired,
    candidate,
    candidate
      ? "trace is already frozen"
      : "performance trace requires autonomous capture before measurement",
  );
  assert.match(
    trace.projectDigest ?? "",
    /^[0-9a-f]{64}$/,
    "trace omitted the source project digest",
  );
  assert.ok(Array.isArray(trace.steps), "trace steps must be an array");
  assertScenarioPathOrder(
    trace.scenario,
    trace.steps.map((step) => step.path),
  );
  for (const pathClass of Object.keys(requiredEvidence)) {
    const steps = trace.steps.filter((step) => step.path === pathClass);
    assert.ok(steps.length > 0, `trace omitted ${pathClass} actions`);
    for (const evidence of requiredEvidence[pathClass])
      assert.equal(
        trace.coverage?.[pathClass]?.[evidence],
        true,
        `${pathClass} lacks captured ${evidence} evidence`,
      );
    for (const step of steps) validateStep(step, pathClass, trace.protocolResults);
  }
  validateProtocolResults(
    trace.protocolResults,
    trace.steps.flatMap((step) => step.protocolActions),
  );
  assert.ok(
    trace.core && typeof trace.core === "object",
    "trace omitted Core companion capture state",
  );
  assert.equal(
    trace.core.projectDigest,
    trace.projectDigest,
    "Core and Tauri project digests differ",
  );
  if (!candidate)
    validateCoreCapture(
      trace.core,
      trace.steps,
      trace.protocolResults,
      trace.replayTarget !== "tauri",
    );
  if (!candidate) assert.equal(trace.traceDigest, traceHash(trace), "trace digest mismatch");
}

function validateCoreCapture(core, webSteps, protocolResults, requireMappings = true) {
  assert.match(core?.projectDigest ?? "", /^[0-9a-f]{64}$/, "Core capture omitted projectDigest");
  assert.ok(
    core?.client && typeof core.client === "object",
    "Core capture omitted client capabilities",
  );
  assert.ok(Array.isArray(core.setupMessages), "Core capture omitted setupMessages");
  assert.equal(
    core.captureIdentityDigest,
    checkpointHash({ client: core.client, setupMessages: core.setupMessages }),
    "Core client/setup identity was not captured from the session",
  );
  assert.equal(core.client.capabilities?.rich_text, true, "captured Core client omitted rich text");
  assert.equal(core.client.capabilities?.html, true, "captured Core client omitted HTML");
  assert.equal(core.client.capabilities?.graphics, true, "captured Core client omitted graphics");
  assert.ok(
    core.client.capabilities?.input_modalities?.includes("mouse"),
    "captured Core client omitted mouse input",
  );
  assert.equal(
    core.client.capabilities?.storage?.revisions,
    true,
    "captured Core client omitted storage revisions",
  );
  if (!requireMappings) return;
  assert.ok(
    Array.isArray(core.steps) && core.steps.length > 0,
    "Core capture omitted normalized checkpoints",
  );
  const mapped = new Set();
  const ids = new Set();
  const checkpoints = new Set();
  let latestSourceWebStep = -1;
  for (const [index, step] of core.steps.entries()) {
    assert.ok(
      typeof step.id === "string" && step.id && !ids.has(step.id),
      `Core step ${index} has an empty or duplicate id`,
    );
    ids.add(step.id);
    assert.ok(
      typeof step.checkpoint === "string" && step.checkpoint && !checkpoints.has(step.checkpoint),
      `Core step ${index} has an empty or duplicate checkpoint`,
    );
    checkpoints.add(step.checkpoint);
    validateCoreExpectation(step.expect, index);
    assertCoreAction(step.action, index, protocolResults);
    if (step.sourceWebStep != null) {
      assert.ok(
        Number.isSafeInteger(step.sourceWebStep) && webSteps[step.sourceWebStep],
        `Core step ${index} has invalid sourceWebStep`,
      );
      assert.ok(
        step.sourceWebStep >= latestSourceWebStep,
        `Core step ${index} is out of Web action order`,
      );
      assert.notEqual(step.action.kind, "none", `Core step ${index} maps a premature none action`);
      latestSourceWebStep = step.sourceWebStep;
      mapped.add(step.sourceWebStep);
    } else {
      assert.equal(index, core.steps.length - 1, `Core step ${index} omitted sourceWebStep`);
    }
  }
  for (const [index, step] of webSteps.entries())
    if (step.action.type !== "hover") {
      assert.ok(
        mapped.has(index),
        `Web step ${index} has no lossless Core checkpoint/action mapping`,
      );
      assert.deepEqual(
        core.steps
          .filter((coreStep) => coreStep.sourceWebStep === index && coreStep.action.kind !== "none")
          .map((coreStep) => coreTraceAction(coreStep.action)),
        step.protocolActions.map(coreTraceAction),
        `Web step ${index} Core protocol actions are not lossless`,
      );
    }
  assert.equal(core.steps.at(-1)?.action?.kind, "none", "final Core step action must be none");
}

export function coreTraceAction(action) {
  if (action.nativeCompletion === true) {
    const canonical = { ...action };
    delete canonical.nativeCompletion;
    return canonical;
  }
  if (action.kind !== "input") return action;
  return {
    kind: action.kind,
    intent: action.intent,
    message_skip: action.messageSkip,
  };
}

function assertCoreAction(action, index, protocolResults) {
  assert.ok(
    action &&
      ["none", "input", "service_response", "storage_response", "submit"].includes(action.kind),
    `Core step ${index} has unsupported action`,
  );
  const allowed = {
    none: ["kind"],
    input: ["intent", "kind", "messageSkip"],
    service_response: ["kind", "resultRef", "service"],
    storage_response: ["kind", "resultRef", "storage"],
    submit: ["kind", "message"],
  }[action.kind];
  if (action.nativeCompletion !== undefined) {
    assert.equal(action.nativeCompletion, true, "invalid native completion marker");
    assert.ok(
      ["service_response", "storage_response"].includes(action.kind),
      "native marker requires a completion",
    );
    allowed.push("nativeCompletion");
    allowed.sort();
  }
  assert.deepEqual(
    Object.keys(action).sort(),
    allowed,
    `Core step ${index} action has unknown fields`,
  );
  if (action.kind === "input")
    assert.ok(
      action.intent && typeof action.intent === "object" && typeof action.messageSkip === "boolean",
      `Core input step ${index} omitted intent or messageSkip`,
    );
  if (action.kind === "service_response") {
    assert.ok(
      action.service?.kind && action.service?.operation,
      `Core service step ${index} omitted request identity`,
    );
    assert.ok(
      protocolResults?.[action.resultRef]?.kind === "service_response",
      `Core service step ${index} omitted a valid resultRef`,
    );
  }
  if (action.kind === "storage_response") {
    assert.ok(
      action.storage?.namespace && action.storage?.relativePath,
      `Core storage step ${index} omitted request identity`,
    );
    assert.ok(
      protocolResults?.[action.resultRef]?.kind === "storage_response",
      `Core storage step ${index} omitted a valid resultRef`,
    );
  }
  if (action.kind === "submit")
    assert.ok(
      action.message && typeof action.message === "object",
      `Core submit step ${index} omitted message`,
    );
}

function compactCoreStep(step, sourceWebStep, trace) {
  assert.ok(
    step?.normalizedState && typeof step.normalizedState === "object",
    "core_steps entry omitted normalizedState",
  );
  assert.notEqual(step.action?.kind, "none", "core_steps cannot supply the final none action");
  validateNormalizedCoreState(step.normalizedState, "core_steps entry");
  return {
    id: step.id,
    checkpoint: step.checkpoint,
    expect: coreCheckpointExpectation(step.normalizedState, step.textContains),
    action: internProtocolAction(trace, step.action),
    sourceWebStep,
  };
}

function coreCheckpointExpectation(normalizedState, textContains = []) {
  validateNormalizedCoreState(normalizedState, "captured Core checkpoint");
  const normalized = sortKeys(normalizedState);
  const expect = {
    phase: normalized.phase,
    waitKind: normalized.wait?.kind ?? null,
    textContains,
    outboundTags: normalized.otherOutboundTags ?? [],
    services: (normalized.services ?? []).map(({ kind, operation }) => ({ kind, operation })),
    storage: (normalized.storage ?? []).map(({ namespace, relativePath }) => ({
      namespace,
      relativePath,
    })),
    variables: normalized.variables ?? {},
    stateSignature: checkpointHash(normalized),
  };
  validateCoreExpectation(expect, "captured");
  return expect;
}

function validateNormalizedCoreState(state, label) {
  assert.ok(state && typeof state === "object" && !Array.isArray(state), `${label} is invalid`);
  assert.deepEqual(
    Object.keys(state).sort(),
    [
      "lines",
      "otherOutboundTags",
      "phase",
      "resources",
      "scene",
      "services",
      "storage",
      "variables",
      "wait",
    ].sort(),
    `${label} does not match Core perf-run`,
  );
  assert.ok(RUNTIME_PHASES.has(state.phase), `${label} has invalid phase`);
  assert.ok(
    state.wait == null || WAIT_KINDS.has(state.wait?.kind),
    `${label} has invalid wait kind`,
  );
  assert.ok(Array.isArray(state.lines), `${label} has invalid lines`);
  assert.ok(
    state.resources && typeof state.resources === "object",
    `${label} has invalid resources`,
  );
  assert.ok(state.scene && typeof state.scene === "object", `${label} has invalid scene`);
  assert.ok(
    state.variables && typeof state.variables === "object" && !Array.isArray(state.variables),
    `${label} has invalid variables`,
  );
  assert.ok(Array.isArray(state.services), `${label} has invalid services`);
  assert.ok(Array.isArray(state.storage), `${label} has invalid storage`);
  assert.ok(Array.isArray(state.otherOutboundTags), `${label} has invalid outbound tags`);
}

function validateCoreExpectation(expect, index) {
  assert.ok(expect && typeof expect === "object", `Core step ${index} omitted expect`);
  assert.deepEqual(
    Object.keys(expect).sort(),
    [
      "outboundTags",
      "phase",
      "services",
      "stateSignature",
      "storage",
      "textContains",
      "variables",
      "waitKind",
    ].sort(),
    `Core step ${index} expectation does not match Core perf-run`,
  );
  assert.ok(RUNTIME_PHASES.has(expect.phase), `Core step ${index} has invalid phase`);
  assert.ok(
    expect.waitKind == null || WAIT_KINDS.has(expect.waitKind),
    `Core step ${index} has invalid waitKind`,
  );
  for (const field of ["textContains", "outboundTags", "services", "storage"])
    assert.ok(Array.isArray(expect[field]), `Core step ${index} has invalid ${field}`);
  assert.ok(
    expect.textContains.every((value) => typeof value === "string"),
    `Core step ${index} has invalid textContains`,
  );
  assert.ok(
    expect.outboundTags.every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff,
    ),
    `Core step ${index} has invalid outboundTags`,
  );
  for (const service of expect.services)
    assert.deepEqual(
      {
        keys: Object.keys(service).sort(),
        kind: SERVICE_KINDS.has(service.kind),
        operation: typeof service.operation === "string" && service.operation.length > 0,
      },
      { keys: ["kind", "operation"], kind: true, operation: true },
      `Core step ${index} has invalid service expectation`,
    );
  for (const storage of expect.storage)
    assert.deepEqual(
      {
        keys: Object.keys(storage).sort(),
        namespace: STORAGE_NAMESPACES.has(storage.namespace),
        relativePath: typeof storage.relativePath === "string",
      },
      { keys: ["namespace", "relativePath"], namespace: true, relativePath: true },
      `Core step ${index} has invalid storage expectation`,
    );
  assert.ok(
    expect.variables && typeof expect.variables === "object" && !Array.isArray(expect.variables),
    `Core step ${index} has invalid variables`,
  );
  assert.ok(
    Object.values(expect.variables).every(
      (value) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isSafeInteger(value)),
    ),
    `Core step ${index} has invalid variable value`,
  );
  assert.match(
    expect.stateSignature ?? "",
    /^[0-9a-f]{64}$/,
    `Core step ${index} has invalid stateSignature`,
  );
}

function checkpointObservationSummary(checkpoint) {
  const output = checkpoint.value.output ?? [];
  return {
    hash: checkpoint.hash,
    phase: checkpoint.value.phase,
    wait: checkpoint.value.wait,
    variables: checkpoint.value.coreProjection.normalizedState.variables,
    outputTail: output.slice(-20).map((line) => String(line).slice(-2_000)),
  };
}

function protocolActionSummary(action) {
  if (action.kind === "input") return action;
  if (action.kind === "service_response") return { kind: action.kind, service: action.service };
  if (action.kind === "storage_response") return { kind: action.kind, storage: action.storage };
  return { kind: action.kind };
}

const RUNTIME_PHASES = new Set([
  "negotiating",
  "loading_project",
  "ready",
  "starting",
  "running",
  "waiting_input",
  "waiting_external",
  "debug_paused",
  "reloading",
  "stopping",
  "stopped",
  "faulted",
  "analyzing_project",
]);
const WAIT_KINDS = new Set([
  "enter_key",
  "any_key",
  "integer_value",
  "string_value",
  "void",
  "any_value",
  "integer_button",
  "string_button",
  "primitive_mouse_key",
]);
const SERVICE_KINDS = new Set([
  "font_metrics",
  "image",
  "canvas",
  "audio",
  "network",
  "open_url",
  "extension",
  "input_state",
  "clock",
  "entropy",
  "presentation_query",
  "sql",
]);
const STORAGE_NAMESPACES = new Set(["project", "save", "global_save", "data", "log", "resource"]);

function validateStep(step, pathClass, protocolResults) {
  validatePerformanceTraceAction(step.action, pathClass);
  assertSecondaryClickProtocolActions(step.action, step.protocolActions, pathClass);
  assert.ok(Array.isArray(step.protocolActions), `${pathClass} omitted protocolActions`);
  for (const [index, action] of step.protocolActions.entries())
    assertCoreAction(action, `${pathClass} protocol ${index}`, protocolResults);
  assert.equal(typeof step.expect?.wait?.kind, "string", `${pathClass} omitted wait kind`);
  assert.ok("generation" in step.expect.wait, `${pathClass} omitted wait generation`);
  assert.ok("waitId" in step.expect.wait, `${pathClass} omitted wait_id`);
  assert.ok(
    ["wait_change", "checkpoint_change"].includes(step.expect.settle),
    `${pathClass} omitted settle policy`,
  );
  assert.ok(
    Array.isArray(step.expect.watches) && step.expect.watches.length > 0,
    `${pathClass} omitted key variables`,
  );
  assert.match(
    step.expect.checkpointHash ?? "",
    /^[0-9a-f]{64}$/,
    `${pathClass} omitted checkpoint hash`,
  );
}

export function validatePerformanceTraceAction(action, pathClass = "performance trace") {
  assert.ok(
    ["input", "click", "hover"].includes(action?.type),
    `${pathClass} has unsupported action`,
  );
  if (action.type === "input")
    assert.notEqual(action.value, undefined, `${pathClass} input omitted value`);
  else {
    assert.equal(typeof action.selector, "string", `${pathClass} DOM action omitted selector`);
    assert.equal(
      typeof action.expectedText,
      "string",
      `${pathClass} DOM action omitted exact text`,
    );
  }
  if (action.type === "click") {
    assert.ok(
      action.button === undefined || ["left", "right"].includes(action.button),
      `${pathClass} click has unsupported button`,
    );
    assert.notEqual(action.semanticInput, undefined, `${pathClass} click omitted semanticInput`);
  }
}

export function assertSecondaryClickProtocolActions(
  action,
  protocolActions,
  pathClass = "performance trace",
) {
  if (action?.type !== "click" || action.button !== "right") return;
  assert.ok(Array.isArray(protocolActions), `${pathClass} right click omitted protocolActions`);
  const inputs = protocolActions.filter((protocolAction) => protocolAction.kind === "input");
  assert.equal(inputs.length, 1, `${pathClass} right click must map to exactly one Core input`);
  assert.equal(
    inputs[0].messageSkip,
    true,
    `${pathClass} right click did not produce messageSkip=true`,
  );
}

async function prepareAction(browser, action) {
  validatePerformanceTraceAction(action);
  if (action.type === "input") {
    const prompt = await browser.$(".prompt-bar input");
    const submit = await browser.$(".prompt-bar button[type=submit]");
    assert.ok(
      (await prompt.isDisplayed()) && (await prompt.isEnabled()),
      "trace prompt unavailable",
    );
    assert.ok(
      (await submit.isDisplayed()) && (await submit.isEnabled()),
      "trace submit unavailable",
    );
    await setTauriTestInput(browser, prompt, String(action.value));
    return {
      perform: () => clickTauriTestElement(browser, submit),
      element: submit,
      domAction: "click",
    };
  }
  const element = await browser.$(action.selector);
  assert.ok(await element.isExisting(), `trace target does not exist: ${action.selector}`);
  if (action.expectedText != null)
    assert.equal((await element.getText()).trim(), action.expectedText);
  if (action.type === "click")
    return action.button === "right"
      ? {
          perform: () => secondaryClickTauriTestElement(browser, element),
          element,
          domAction: "secondary-click",
        }
      : { perform: () => clickTauriTestElement(browser, element), element, domAction: "click" };
  return { perform: () => hoverTauriTestElement(browser, element), element, domAction: "hover" };
}

async function performTimedAction(browser, action, before, settle, watches, beforeTiming) {
  // Selector resolution, exact-label validation and input preparation are harness
  // setup, not the response to the real input. Keep all assertions, outside its clock.
  const prepared = await prepareAction(browser, action);
  await beforeTiming?.();
  if (useDomActionClock(settle)) {
    const measured = await browser.execute(
      backgroundDomClockScript,
      prepared.element,
      prepared.domAction,
      waitIdentity(before.value.wait),
    );
    assert.ok(
      Number.isFinite(measured?.elapsedMs) && measured.elapsedMs >= 0,
      "invalid DOM action timing",
    );
    console.log(JSON.stringify({ type: "background-dom-input", ...measured.inputEvidence }));
    console.log(
      JSON.stringify({
        type: "tauri-performance-dom-clock",
        elapsedMs: measured.elapsedMs,
        phases: measured.phases,
      }),
    );
    return measured.elapsedMs;
  }
  const startedAt = performance.now();
  await prepared.perform();
  await assertSecondaryActionStarted(browser, action, before);
  await waitForNextObservation(browser, before, settle, watches);
  return performance.now() - startedAt;
}

function performanceTimingBasis(settle) {
  if (process.env.RUSTYERA_TAURI_PERF_HEAVY_DIAGNOSTICS === "1") return "diagnostic-heavy-dom";
  if (useDomActionClock(settle)) return "dom-action-to-stable-observation";
  return settle === "checkpoint_change"
    ? "diagnostic-checkpoint-change"
    : "action-to-stable-observation";
}

function useDomActionClock(settle) {
  return (
    settle === "wait_change" &&
    process.env.RUSTYERA_TEST_BACKGROUND_DOM === "1" &&
    process.env.RUSTYERA_TAURI_PERF_HEAVY_DIAGNOSTICS !== "1"
  );
}

export async function assertSecondaryActionStarted(browser, action, before) {
  if (action?.type !== "click" || action.button !== "right") return;
  const previousIdentity = waitIdentity(before.value.wait);
  const timeoutMessage = "right click produced no pending input or wait transition";
  let last;
  try {
    await browser.waitUntil(
      async () => {
        last = await browser.execute(() => window.__RUSTYERA_TEST__.performanceProgress());
        if (last?.fault) throw new Error(JSON.stringify(last.fault));
        return (
          last?.canInteract === false ||
          (hasWaitIdentity(last?.wait) && waitIdentity(last.wait) !== previousIdentity)
        );
      },
      {
        timeout: 1_000,
        interval: 10,
        timeoutMsg: timeoutMessage,
      },
    );
  } catch (error) {
    if (!String(error).includes(timeoutMessage)) throw error;
    throw new Error(`${timeoutMessage}: ${JSON.stringify(last ?? null)}`, { cause: error });
  }
}

async function waitForNextObservation(browser, previous, settle, watches) {
  const previousIdentity = waitIdentity(previous.value.wait);
  await browser.waitUntil(
    async () => {
      if (settle === "checkpoint_change")
        return (
          (
            await capturePerformanceCheckpoint(
              browser,
              watches,
              previous.value.coreProjection.protocolCursor,
            )
          ).hash !== previous.hash
        );
      const current = await browser.execute(() => window.__RUSTYERA_TEST__.performanceProgress());
      if (current?.fault) throw new Error(JSON.stringify(current.fault));
      return (
        current?.canInteract && current.wait && waitIdentity(current.wait) !== previousIdentity
      );
    },
    { timeout: 30_000, interval: 20, timeoutMsg: "trace action did not settle" },
  );
  await browser.execute(async () => {
    await window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true, true);
    return true;
  });
}

function assertWait(expected, actual, label) {
  assert.deepEqual(
    {
      kind: actual?.kind,
      generation: actual?.generation ?? null,
      waitId: actual?.waitId ?? actual?.wait_id ?? null,
    },
    expected,
    `${label} wait identity mismatch`,
  );
}
function waitIdentity(wait) {
  return `${wait?.kind ?? ""}:${String(wait?.generation ?? "")}:${String(wait?.waitId ?? wait?.wait_id ?? "")}`;
}

function hasWaitIdentity(wait) {
  return (
    wait != null &&
    typeof wait === "object" &&
    typeof wait.kind === "string" &&
    (wait.waitId != null || wait.wait_id != null)
  );
}
function canonicalizeCheckpoint(raw) {
  return sortKeys(raw);
}
function checkpointHash(value) {
  return hashCheckpointJson(JSON.stringify(sortKeys(value)));
}
function hashCheckpointJson(json) {
  return createHash("sha256").update(json).digest("hex");
}
function traceHash(trace) {
  return checkpointHash({ ...trace, traceDigest: null });
}
function digestWithoutField(value, field) {
  const unsigned = structuredClone(value);
  delete unsigned[field];
  return checkpointHash(unsigned);
}
function protocolActionDelta(before, after) {
  const current = after?.coreProjection?.protocolActions ?? [];
  assert.ok(
    Array.isArray(before?.coreProjection?.protocolActions),
    "before checkpoint omitted protocol actions",
  );
  return current;
}

function internProtocolActions(trace, actions) {
  return actions.map((action) => internProtocolAction(trace, action));
}

function internProtocolAction(trace, action) {
  if (!["service_response", "storage_response"].includes(action?.kind)) return action;
  if (action.resultRef) {
    assert.equal(action.result, undefined, "protocol action cannot contain result and resultRef");
    return action;
  }
  assert.ok(action.result && typeof action.result === "object", "protocol response omitted result");
  const resultEntry = sortKeys({ kind: action.kind, result: action.result });
  const resultRef = checkpointHash(resultEntry);
  const existing = trace.protocolResults[resultRef];
  if (existing) {
    assert.deepEqual(existing, resultEntry, `protocol result digest collision ${resultRef}`);
  } else {
    const budget = protocolResultBudgets.get(trace) ?? protocolResultBudget(trace.protocolResults);
    const bytes = Buffer.byteLength(JSON.stringify(resultEntry));
    if (budget.count + 1 > MAXIMUM_PROTOCOL_RESULTS)
      throw new Error("performance trace exceeds its unique protocol result count limit");
    if (budget.bytes + bytes > MAXIMUM_PROTOCOL_RESULT_BYTES)
      throw new Error("performance trace exceeds its unique protocol result byte limit");
    trace.protocolResults[resultRef] = resultEntry;
    protocolResultBudgets.set(trace, { count: budget.count + 1, bytes: budget.bytes + bytes });
  }
  const reference = { ...action };
  delete reference.result;
  return { ...reference, resultRef };
}

function protocolResultBudget(results) {
  const entries = Object.values(results ?? {});
  return {
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0),
  };
}

function validateProtocolResults(results, actions) {
  assert.ok(
    results && typeof results === "object" && !Array.isArray(results),
    "trace omitted protocolResults",
  );
  const budget = protocolResultBudget(results);
  assert.ok(budget.count <= MAXIMUM_PROTOCOL_RESULTS, "trace has too many unique protocol results");
  assert.ok(
    budget.bytes <= MAXIMUM_PROTOCOL_RESULT_BYTES,
    "trace protocol results exceed their byte limit",
  );
  for (const [resultRef, entry] of Object.entries(results)) {
    assert.match(resultRef, /^[0-9a-f]{64}$/, "protocol result reference is not a digest");
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["kind", "result"],
      `protocol result ${resultRef} has unknown fields`,
    );
    assert.ok(
      ["service_response", "storage_response"].includes(entry.kind),
      `protocol result ${resultRef} has invalid kind`,
    );
    assert.ok(
      entry.result && typeof entry.result === "object",
      `protocol result ${resultRef} is invalid`,
    );
    assert.equal(checkpointHash(entry), resultRef, `protocol result ${resultRef} digest mismatch`);
  }
  const referenced = new Set(
    actions
      .filter((action) => ["service_response", "storage_response"].includes(action.kind))
      .map((action) => action.resultRef),
  );
  assert.equal(
    referenced.size,
    Object.keys(results).length,
    "trace contains unreferenced protocol results",
  );
}
function omitVolatileIdentity(value) {
  if (Array.isArray(value)) return value.map(omitVolatileIdentity);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== "sessionGeneration" &&
            !/^(?:session|message|correlation|attempt)(?:_|)[iI]d$/.test(key),
        )
        .map(([key, child]) => [key, omitVolatileIdentity(child)]),
    );
  return value;
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  return value;
}
async function readJsonLines(path) {
  try {
    const source = await readFile(path, "utf8");
    const complete = source.endsWith("\n") ? source : source.slice(0, source.lastIndexOf("\n") + 1);
    return complete
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAXIMUM_PERFORMANCE_TRACE_BYTES)
    throw new Error("performance trace exceeds its 256 MiB file limit");
  await writeFile(temporary, serialized, { flag: "wx" });
  await rename(temporary, path);
}
async function readBoundedTraceJson(path) {
  if ((await stat(path)).size > MAXIMUM_PERFORMANCE_TRACE_BYTES)
    throw new Error("performance trace exceeds its 256 MiB file limit");
  return JSON.parse(await readFile(path, "utf8"));
}
function percentile(ordered, quantile) {
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))];
}
