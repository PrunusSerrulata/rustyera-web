import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

import {
  clickTauriTestElement,
  hoverTauriTestElement,
  setTauriTestInput,
} from "./dom-test-input.mjs";

export const PERFORMANCE_PATHS = ["loading", "steady-runtime", "map-nf-sql", "save-load"];
const REQUIRED_EVIDENCE = {
  "loading": ["title", "newGame", "qol", "sql", "map", "privateRoom", "day1"],
  "steady-runtime": ["dailyLoop", "longOutput", "dynamicCall", "formatting", "stringWork"],
  "map-nf-sql": ["mapRoundtrip", "hover", "click", "nf", "scene", "canvas", "sprite", "sqlPath"],
  "save-load": ["ordinarySave", "ordinaryLoad", "stableReturn"],
};

export async function readPerformanceTrace(path) {
  const trace = JSON.parse(await readFile(path, "utf8"));
  validateTrace(trace, false);
  return trace;
}

export async function freezePerformanceTrace(candidatePath, outputPath, coreOutputPath) {
  const trace = JSON.parse(await readFile(candidatePath, "utf8"));
  validateTrace(trace, true);
  trace.captureRequired = false;
  trace.traceDigest = traceHash(trace);
  validateTrace(trace, false);
  const coreTrace = coreTraceFromPerformanceTrace(trace);
  await writeJsonAtomically(outputPath, trace);
  if (coreOutputPath) await writeJsonAtomically(coreOutputPath, coreTrace);
  return { trace, coreTrace };
}

export function coreTraceFromPerformanceTrace(trace) {
  validateTrace(trace, false);
  validateCoreCapture(trace.core, trace.steps);
  const coreTrace = {
    schemaVersion: 1,
    traceDigest: "",
    scenario: trace.scenario,
    projectDigest: trace.core.projectDigest,
    seed: trace.seed,
    client: trace.core.client,
    setupMessages: trace.core.setupMessages,
    steps: trace.core.steps.map((step) => {
      const normalizedState = sortKeys(step.normalizedState);
      return {
        id: step.id,
        checkpoint: step.checkpoint,
        expect: {
          phase: normalizedState.phase,
          waitKind: normalizedState.wait?.kind ?? null,
          textContains: step.textContains ?? [],
          outboundTags: normalizedState.otherOutboundTags ?? [],
          services: (normalizedState.services ?? []).map(({ kind, operation }) => ({ kind, operation })),
          storage: (normalizedState.storage ?? []).map(({ namespace, relativePath }) => ({
            namespace,
            relativePath,
          })),
          variables: normalizedState.variables ?? {},
          stateSignature: checkpointHash(normalizedState),
        },
        action: step.action,
      };
    }),
  };
  coreTrace.traceDigest = digestWithoutField(coreTrace, "traceDigest");
  return coreTrace;
}

export async function replayPerformanceTrace(browser, trace, onCheckpoint = () => undefined) {
  validateTrace(trace, false);
  const paths = [];
  for (const pathClass of PERFORMANCE_PATHS) {
    const steps = trace.steps.filter((step) => step.path === pathClass);
    const startedAt = performance.now();
    const inputSamples = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const before = await capturePerformanceCheckpoint(browser, step.expect.watches);
      assertWait(step.expect.wait, before.value.wait, `${pathClass}[${index}]`);
      const stepStartedAt = performance.now();
      await performAction(browser, step.action);
      await waitForNextObservation(browser, before, step.expect.settle, step.expect.watches);
      const after = await capturePerformanceCheckpoint(browser, step.expect.watches);
      assert.equal(after.hash, step.expect.checkpointHash, `${pathClass}[${index}] scenario signature mismatch`);
      assert.deepEqual(after.value, step.expect.checkpoint, `${pathClass}[${index}] checkpoint mismatch`);
      inputSamples.push(performance.now() - stepStartedAt);
      await onCheckpoint({ path: pathClass, step: index, before, after });
    }
    paths.push({
      id: pathClass,
      class: pathClass,
      elapsedMs: performance.now() - startedAt,
      inputMs: summarizeSamples(inputSamples),
    });
  }
  return { paths };
}

export async function runPerformanceTraceCapture(
  browser,
  { templatePath, candidatePath, actionInboxPath, projectDigest, onObservation = () => undefined },
) {
  const trace = JSON.parse(await readFile(templatePath, "utf8"));
  assert.equal(trace.captureRequired, true, "capture must start from a candidate template");
  trace.projectDigest = projectDigest;
  trace.core.projectDigest = projectDigest;
  const audit = await browser.execute(() => window.__RUSTYERA_TEST__.performanceAudit());
  assert.ok(audit.native?.coreClient, "native performance capture omitted the actual ClientHello projection");
  assert.ok(Array.isArray(audit.native?.setupMessages), "native performance capture omitted setupMessages");
  trace.core.client = audit.native.coreClient;
  trace.core.setupMessages = audit.native.setupMessages;
  trace.steps = [];
  trace.core.steps = [];
  trace.coverage = Object.fromEntries(PERFORMANCE_PATHS.map((pathClass) => [pathClass, {}]));
  await writeJsonAtomically(candidatePath, trace);
  let processed = 0;
  let lastCheckpoint;
  for (;;) {
    const commands = await readJsonLines(actionInboxPath);
    if (processed >= commands.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const command = commands[processed++];
    if (command.type === "finish") {
      if (lastCheckpoint && trace.core.steps.at(-1)?.action?.kind !== "none")
        trace.core.steps.push({
          id: "final",
          checkpoint: "final",
          normalizedState: lastCheckpoint.coreProjection.normalizedState,
          action: { kind: "none" },
        });
      await writeJsonAtomically(candidatePath, trace);
      return trace;
    }
    if (command.type === "core_steps") {
      assert.ok(
        Number.isSafeInteger(command.sourceWebStep) && trace.steps[command.sourceWebStep],
        "core_steps requires an existing sourceWebStep",
      );
      assert.ok(Array.isArray(command.coreSteps) && command.coreSteps.length > 0, "core_steps omitted mappings");
      for (const coreStep of command.coreSteps)
        trace.core.steps.push({ ...coreStep, sourceWebStep: command.sourceWebStep });
      await writeJsonAtomically(candidatePath, trace);
      continue;
    }
    assert.equal(command.type, "action", "capture inbox accepts only action or finish records");
    assert.ok(PERFORMANCE_PATHS.includes(command.path), `unknown capture path ${command.path}`);
    const before = await capturePerformanceCheckpoint(browser, command.watches);
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
    await performAction(browser, command.action);
    const settle =
      command.settle ?? (command.action.type === "hover" ? "checkpoint_change" : "wait_change");
    assert.ok(["wait_change", "checkpoint_change"].includes(settle), "invalid capture settle policy");
    await waitForNextObservation(browser, before, settle, command.watches);
    const after = await capturePerformanceCheckpoint(browser, command.watches);
    const protocolActions = protocolActionDelta(before.value, after.value);
    trace.steps.push({
      path: command.path,
      action: command.action,
      expect: {
        wait: before.value.wait,
        settle,
        watches: command.watches,
        checkpointHash: after.hash,
        checkpoint: after.value,
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
      trace.core.steps.push({ ...coreStep, sourceWebStep: trace.steps.length - 1 });
    lastCheckpoint = after.value;
    Object.assign(trace.coverage[command.path], command.evidence);
    await writeJsonAtomically(candidatePath, trace);
    await onObservation({ command: processed, path: command.path, before, after });
  }
}

export async function capturePerformanceCheckpoint(browser, watches) {
  assert.ok(Array.isArray(watches) && watches.length > 0, "checkpoint requires key-variable watches");
  const raw = await browser.execute(
    (requestedWatches) => window.__RUSTYERA_TEST__.performanceCheckpoint(requestedWatches),
    watches,
  );
  const value = canonicalizeCheckpoint(raw);
  return { value, hash: checkpointHash(value) };
}

export function summarizeRuns(runs) {
  const byPath = Object.fromEntries(
    PERFORMANCE_PATHS.map((pathClass) => [
      pathClass,
      summarizeSamples(
        runs.flatMap((run) =>
          run.paths.filter((entry) => entry.class === pathClass).map((entry) => entry.elapsedMs),
        ),
      ),
    ]),
  );
  return { runs: runs.length, byPath };
}

export function summarizeSamples(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const mean = samples.length ? samples.reduce((total, value) => total + value, 0) / samples.length : 0;
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
  assert.equal(trace.schemaVersion, 1, "unsupported performance trace schema");
  assert.equal(trace.scenario, "snake-tw-runtime-four-paths", "unexpected performance scenario");
  assert.equal(trace.profile, "emuera.skia.snake", "performance trace selected a non-snake profile");
  assert.ok(Number.isSafeInteger(trace.seed) && trace.seed >= 0, "performance trace seed must be a non-negative safe integer");
  assert.ok(
    typeof trace.clock === "string" &&
      Number.isFinite(Date.parse(trace.clock)) &&
      new Date(trace.clock).toISOString() === trace.clock,
    "performance trace clock must be a canonical ISO timestamp",
  );
  assert.equal(trace.captureRequired, candidate, candidate ? "trace is already frozen" : "performance trace requires autonomous capture before measurement");
  assert.match(trace.projectDigest ?? "", /^[0-9a-f]{64}$/, "trace omitted the source project digest");
  assert.ok(Array.isArray(trace.steps), "trace steps must be an array");
  for (const pathClass of PERFORMANCE_PATHS) {
    const steps = trace.steps.filter((step) => step.path === pathClass);
    assert.ok(steps.length > 0, `trace omitted ${pathClass} actions`);
    for (const evidence of REQUIRED_EVIDENCE[pathClass])
      assert.equal(trace.coverage?.[pathClass]?.[evidence], true, `${pathClass} lacks captured ${evidence} evidence`);
    for (const step of steps) validateStep(step, pathClass);
  }
  assert.ok(trace.core && typeof trace.core === "object", "trace omitted Core companion capture state");
  assert.equal(trace.core.projectDigest, trace.projectDigest, "Core and Tauri project digests differ");
  if (!candidate) validateCoreCapture(trace.core, trace.steps);
  if (!candidate) assert.equal(trace.traceDigest, traceHash(trace), "trace digest mismatch");
}

function validateCoreCapture(core, webSteps) {
  assert.match(core?.projectDigest ?? "", /^[0-9a-f]{64}$/, "Core capture omitted projectDigest");
  assert.ok(core?.client && typeof core.client === "object", "Core capture omitted client capabilities");
  assert.ok(Array.isArray(core.setupMessages), "Core capture omitted setupMessages");
  assert.equal(
    core.captureIdentityDigest,
    checkpointHash({ client: core.client, setupMessages: core.setupMessages }),
    "Core client/setup identity was not captured from the session",
  );
  assert.equal(core.client.capabilities?.rich_text, true, "captured Core client omitted rich text");
  assert.equal(core.client.capabilities?.html, true, "captured Core client omitted HTML");
  assert.equal(core.client.capabilities?.graphics, true, "captured Core client omitted graphics");
  assert.ok(core.client.capabilities?.input_modalities?.includes("mouse"), "captured Core client omitted mouse input");
  assert.equal(core.client.capabilities?.storage?.revisions, true, "captured Core client omitted storage revisions");
  assert.ok(Array.isArray(core.steps) && core.steps.length > 0, "Core capture omitted normalized checkpoints");
  const mapped = new Set();
  for (const [index, step] of core.steps.entries()) {
    assert.equal(typeof step.id, "string", `Core step ${index} omitted id`);
    assert.equal(typeof step.checkpoint, "string", `Core step ${index} omitted checkpoint`);
    assert.ok(step.normalizedState && typeof step.normalizedState === "object", `Core step ${index} omitted normalizedState`);
    assert.deepEqual(
      Object.keys(step.normalizedState).sort(),
      ["lines", "otherOutboundTags", "phase", "resources", "scene", "services", "storage", "variables", "wait"].sort(),
      `Core step ${index} normalizedState does not match Core perf-run`,
    );
    assertCoreAction(step.action, index);
    if (step.sourceWebStep != null) {
      assert.ok(Number.isSafeInteger(step.sourceWebStep) && webSteps[step.sourceWebStep], `Core step ${index} has invalid sourceWebStep`);
      mapped.add(step.sourceWebStep);
    }
  }
  for (const [index, step] of webSteps.entries())
    if (step.action.type !== "hover") {
      assert.ok(mapped.has(index), `Web step ${index} has no lossless Core checkpoint/action mapping`);
      assert.deepEqual(
        core.steps
          .filter((coreStep) => coreStep.sourceWebStep === index && coreStep.action.kind !== "none")
          .map((coreStep) => coreStep.action),
        step.protocolActions,
        `Web step ${index} Core protocol actions are not lossless`,
      );
    }
  assert.equal(core.steps.at(-1)?.action?.kind, "none", "final Core step action must be none");
}

function assertCoreAction(action, index) {
  assert.ok(action && ["none", "input", "service_response", "storage_response", "submit"].includes(action.kind), `Core step ${index} has unsupported action`);
  const allowed = {
    none: ["kind"],
    input: ["intent", "kind", "messageSkip"],
    service_response: ["kind", "result", "service"],
    storage_response: ["kind", "result", "storage"],
    submit: ["kind", "message"],
  }[action.kind];
  assert.deepEqual(Object.keys(action).sort(), allowed, `Core step ${index} action has unknown fields`);
  if (action.kind === "input") assert.ok(action.intent && typeof action.intent === "object", `Core input step ${index} omitted intent`);
  if (action.kind === "service_response") {
    assert.ok(action.service?.kind && action.service?.operation, `Core service step ${index} omitted request identity`);
    assert.ok(action.result && typeof action.result === "object", `Core service step ${index} omitted result`);
  }
  if (action.kind === "storage_response") {
    assert.ok(action.storage?.namespace && action.storage?.relativePath, `Core storage step ${index} omitted request identity`);
    assert.ok(action.result && typeof action.result === "object", `Core storage step ${index} omitted result`);
  }
  if (action.kind === "submit") assert.ok(action.message && typeof action.message === "object", `Core submit step ${index} omitted message`);
}

function validateStep(step, pathClass) {
  assert.ok(["input", "click", "hover"].includes(step.action?.type), `${pathClass} has unsupported action`);
  if (step.action.type === "input")
    assert.notEqual(step.action.value, undefined, `${pathClass} input omitted value`);
  else {
    assert.equal(typeof step.action.selector, "string", `${pathClass} DOM action omitted selector`);
    assert.equal(typeof step.action.expectedText, "string", `${pathClass} DOM action omitted exact text`);
  }
  if (step.action.type === "click")
    assert.notEqual(step.action.semanticInput, undefined, `${pathClass} click omitted semanticInput`);
  assert.equal(typeof step.expect?.wait?.kind, "string", `${pathClass} omitted wait kind`);
  assert.ok("generation" in step.expect.wait, `${pathClass} omitted wait generation`);
  assert.ok("waitId" in step.expect.wait, `${pathClass} omitted wait_id`);
  assert.ok(["wait_change", "checkpoint_change"].includes(step.expect.settle), `${pathClass} omitted settle policy`);
  assert.ok(Array.isArray(step.expect.watches) && step.expect.watches.length > 0, `${pathClass} omitted key variables`);
  assert.ok(step.expect.checkpoint?.variables, `${pathClass} omitted captured variable values`);
  assert.equal(checkpointHash(step.expect.checkpoint), step.expect.checkpointHash, `${pathClass} stored hash mismatch`);
}

async function performAction(browser, action) {
  if (action.type === "input") {
    const prompt = await browser.$(".prompt-bar input");
    const submit = await browser.$(".prompt-bar button[type=submit]");
    assert.ok((await prompt.isDisplayed()) && (await prompt.isEnabled()), "trace prompt unavailable");
    assert.ok((await submit.isDisplayed()) && (await submit.isEnabled()), "trace submit unavailable");
    await setTauriTestInput(browser, prompt, String(action.value));
    await clickTauriTestElement(browser, submit);
    return;
  }
  const element = await browser.$(action.selector);
  assert.ok(await element.isExisting(), `trace target does not exist: ${action.selector}`);
  if (action.expectedText != null) assert.equal((await element.getText()).trim(), action.expectedText);
  if (action.type === "click") return clickTauriTestElement(browser, element);
  await hoverTauriTestElement(browser, element);
}

async function waitForNextObservation(browser, previous, settle, watches) {
  const previousIdentity = waitIdentity(previous.value.wait);
  await browser.waitUntil(
    async () => {
      if (settle === "checkpoint_change")
        return (await capturePerformanceCheckpoint(browser, watches)).hash !== previous.hash;
      const current = await browser.execute(() => window.__RUSTYERA_TEST__.snapshotSummary());
      if (current?.fault) throw new Error(JSON.stringify(current.fault));
      return current?.canInteract && current.wait && waitIdentity(current.wait) !== previousIdentity;
    },
    { timeout: 300_000, interval: 20, timeoutMsg: "trace action did not settle" },
  );
}

function assertWait(expected, actual, label) {
  assert.deepEqual(
    { kind: actual?.kind, generation: actual?.generation ?? null, waitId: actual?.waitId ?? actual?.wait_id ?? null },
    expected,
    `${label} wait identity mismatch`,
  );
}
function waitIdentity(wait) {
  return `${wait?.kind ?? ""}:${String(wait?.generation ?? "")}:${String(wait?.waitId ?? wait?.wait_id ?? "")}`;
}
function canonicalizeCheckpoint(raw) {
  const checkpoint = structuredClone(raw);
  checkpoint.service = omitVolatileIdentity(checkpoint.service);
  checkpoint.storage = omitVolatileIdentity(checkpoint.storage);
  checkpoint.transfer = omitVolatileIdentity(checkpoint.transfer);
  return sortKeys(checkpoint);
}
function checkpointHash(value) {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
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
  const previous = before?.coreProjection?.protocolActions ?? [];
  const current = after?.coreProjection?.protocolActions ?? [];
  assert.deepEqual(current.slice(0, previous.length), previous, "protocol action history changed during capture");
  return current.slice(previous.length);
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
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
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
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}
function percentile(ordered, quantile) {
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))];
}
