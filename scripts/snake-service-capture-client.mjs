/* global document, getComputedStyle, navigator, window */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  CaptureWriter,
  assertCaptureInputsUnchanged,
  selectCaptureCase,
  sha256,
  stableJSON,
} from "./snake-service-capture-io.mjs";

let activeCapture;
let faultObservationAllowed = false;
export const allowsServiceOracleFault = () => faultObservationAllowed;
export const recordServiceOracleWatchdog = (snapshot) => activeCapture?.watchdog(snapshot);

export function captureTerminal(snapshot) {
  if (snapshot?.fault || snapshot?.phase === "faulted") return "fault";
  if (snapshot?.canInteract && snapshot.wait && snapshot.output?.includes("S04_CASE_COMPLETE"))
    return "completed";
  return null;
}

const normalReadyMarker = "S04_ORACLE_READY";
const hazardReadyMarker = "S04_NO_PROGRESS_READY";
const noProgressCase = "s04-lines-no-progress";
const noProgressEntry = "S04_CASE_NO_PROGRESS";

export function serviceOracleReadyMarker(config) {
  const { selected, menu, request } = selectCaptureCase(
    config.fixtureManifest,
    config.selected?.id,
  );
  if (menu !== config.menu || stableJSON(request) !== stableJSON(config.request))
    throw new Error("capture case menu/request differs from its exact fixture entry");
  const cases = config.fixtureManifest.cases;
  if (selected.id === noProgressCase) {
    if (
      cases.length !== 1 ||
      selected.group !== "SERVICES_HAZARD" ||
      request.entry !== noProgressEntry
    )
      throw new Error("no-progress capture requires its independent single-case hazard fixture");
    return hazardReadyMarker;
  }
  if (
    selected.group !== "SERVICES" ||
    cases.some(
      (item) =>
        item.id === noProgressCase ||
        item.group === "SERVICES_HAZARD" ||
        item.requests?.some((step) => step.request?.entry === noProgressEntry),
    )
  )
    throw new Error("normal service capture cannot include the no-progress hazard");
  return normalReadyMarker;
}

export function serviceOracleReady(snapshot, marker) {
  if (marker !== normalReadyMarker && marker !== hazardReadyMarker)
    throw new Error("unknown exact service oracle ready marker");
  if (snapshot?.fault || snapshot?.phase === "faulted")
    throw new Error(`fixture startup fault: ${JSON.stringify(snapshot.fault ?? snapshot.phase)}`);
  const output = snapshot?.output;
  if (!Array.isArray(output)) return false;
  const other = marker === normalReadyMarker ? hazardReadyMarker : normalReadyMarker;
  if (output.includes(other))
    throw new Error(`unexpected service oracle ready marker ${other}; required ${marker}`);
  const matches = output.filter((line) => line === marker).length;
  if (matches > 1) throw new Error(`ambiguous service oracle ready marker ${marker}`);
  return Boolean(snapshot.canInteract && snapshot.wait?.kind === "integer_value" && matches === 1);
}

function requireSnapshot(snapshot, bridge, inputs) {
  if (snapshot?.bridgeKind !== bridge || snapshot.buildIdentity?.corePin !== inputs.coreSha)
    throw new Error("capture host/pin differs from actual runtime snapshot");
  if (bridge === "browser" && snapshot.buildIdentity?.wasmRevision !== inputs.wasmAssets?.revision)
    throw new Error("loaded WASM asset revision differs from actual artifact identity");
  const evidence = snapshot.serviceEvidence;
  if (
    !evidence?.enabled ||
    evidence.version !== 1 ||
    evidence.overflow ||
    evidence.failure ||
    !Array.isArray(evidence.records)
  )
    throw new Error("actual protocol ledger is disabled/incomplete");
}

export async function runServiceOracleCapture(client, config, inputs) {
  if (activeCapture) throw new Error("one fresh service oracle case per process is required");
  const readyMarker = serviceOracleReadyMarker(config);
  const bridge = config.family === "tauri" ? "tauri" : "browser";
  const read = () => client.execute(() => window.__RUSTYERA_TEST__.snapshot());
  const progress = (stage) =>
    console.log(JSON.stringify({ type: "service-oracle-stage", case: config.selected.id, stage }));
  const wait = async (predicate, label, timeout = 30000) => {
    progress(`waiting: ${label}`);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snapshot = await read();
      if (predicate(snapshot)) {
        progress(`observed: ${label}`);
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${label} exceeded ${timeout}ms`);
  };
  const loaded = await wait(
    (snapshot) => serviceOracleReady(snapshot, readyMarker),
    `service oracle ready ${readyMarker}`,
  );
  requireSnapshot(loaded, bridge, inputs);
  const report = loaded.serviceEvidence.records.filter(
    (row) => row.direction === "receive" && row.message?.type === "project_load_report",
  );
  if (report.length !== 1 || !report[0].message.value.success)
    throw new Error("fresh capture must have one successful project load");
  const profile = report[0].message.value.compatibility;
  if (profile.profile !== config.expectedProfile)
    throw new Error(
      `actual profile ${profile.profile} differs from requested ${config.expectedProfile}`,
    );
  // Export while the initial input is stable; an error case may later be unexportable.
  progress("requesting actual project identity export");
  await client.execute(async () => {
    await window.__RUSTYERA_TEST__.exportDiagnosis();
    return true;
  });
  const identified = await wait(
    (snapshot) => Array.isArray(snapshot.lastDownload?.projectIdentityFiles),
    "actual project identity export",
  );
  const byPath = new Map(inputs.fixtureFiles.map((row) => [row.path, row]));
  const submittedPayloads = [];
  const actualPaths = new Set();
  for (const item of identified.lastDownload.projectIdentityFiles) {
    const row = byPath.get(item.relativePath);
    if (!row || actualPaths.has(item.relativePath))
      throw new Error(`unexpected/duplicate actual project input: ${item.relativePath}`);
    actualPaths.add(item.relativePath);
    const raw = await readFile(path.join(config.fixture, item.relativePath));
    if (sha256(raw) !== row.sha256)
      throw new Error("fixture changed before actual payload identity check");
    const payload =
      item.category === "resource"
        ? raw
        : Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (
      Buffer.from(blake3(payload)).toString("hex") !== item.contentHash ||
      payload.length !== item.byteLength
    )
      throw new Error(`actual project payload differs: ${item.relativePath}`);
    if (item.category !== "resource")
      submittedPayloads.push({
        path: row.path,
        rawSha256: row.sha256,
        decodedUtf8Sha256: row.decodedUtf8Sha256,
      });
  }
  submittedPayloads.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceFiles = inputs.fixtureFiles.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
  }));
  const asciiIdentity = stableJSON(sourceFiles).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const environment = await client.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const style = viewport ? getComputedStyle(viewport) : null;
    const box = viewport?.getBoundingClientRect();
    return {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      font: style
        ? {
            family: style.fontFamily,
            size: style.fontSize,
            weight: style.fontWeight,
            style: style.fontStyle,
          }
        : null,
      fontsReady: document.fonts.status,
    };
  });
  const identity = {
    frontend: bridge,
    coreSha: inputs.coreSha,
    corePin: inputs.corePin,
    dirty: inputs.dirty,
    frontendSha: inputs.frontendSha,
    frontendDirty: inputs.frontendDirty,
    profile,
    seed: config.fixtureManifest.seed,
    sourceFixture: { files: sourceFiles, sha256: sha256(asciiIdentity) },
    fixtureInventory: inputs.fixtureFiles,
    fixturePreparation: {
      effectiveInventorySha256: sha256(stableJSON(inputs.fixtureFiles)),
      ...(inputs.sourceFixtureFiles
        ? {
            originalInventory: inputs.sourceFixtureFiles,
            originalInventorySha256: sha256(stableJSON(inputs.sourceFixtureFiles)),
          }
        : {}),
      mode: "preprepared_immutable_effective_fixture",
      producerModifiedFixture: false,
    },
    submittedPayloads,
    artifacts: inputs.artifacts,
    ...(inputs.wasmAssets ? { wasmAssets: inputs.wasmAssets } : {}),
    frontendRuntime: {
      mode: config.mode,
      artifactRole: "frontend",
      artifactKind: config.mode === "vite-dev" ? "source-manifest" : "file-manifest",
    },
    provenance: {
      synthetic: false,
      captureMode: "real_client",
      clientFamily: config.family,
      clientVersion: client.version || environment.userAgent,
      runtimeBackend: bridge === "browser" ? "wasm" : "tauri_cabi",
      htmlProvider: "html_node_dom",
      canvasProvider: "canvas_replay_renderer",
      pointerProvider: "viewport_pointer",
    },
  };
  const writer = new CaptureWriter(config.outputDirectory);
  const caseId = config.selected.id;
  const record = (stage, snapshot, extra = {}) => {
    requireSnapshot(snapshot, bridge, inputs);
    return writer.record({ type: "observation", case: caseId, stage, snapshot, ...extra });
  };
  let completed = false;
  try {
    await writer.record({ type: "header", identity, caseIds: [caseId], environment });
    await writer.record({ type: "case_begin", case: caseId, requests: [config.request] });
    await record("loaded", loaded);
    await record("identity", identified);
    activeCapture = {
      watchdog: (snapshot) => record("watchdog", snapshot.runtime, { document: snapshot.document }),
    };
    faultObservationAllowed = true;
    await client.submit(config.menu);
    const terminal = await wait(
      (snapshot) => Boolean(captureTerminal(snapshot)),
      "selected service case",
      config.commandTimeoutMs ?? 30000,
    );
    let inspect, inspectError;
    try {
      inspect = await client.execute(
        async (watches) => window.__RUSTYERA_TEST__.inspectTyped(watches),
        config.request.watch ?? [],
      );
    } catch (error) {
      inspectError = { name: error.name, message: error.message };
    }
    const final = await read();
    if (!captureTerminal(final)) {
      const frontier = (state) => ({
        phase: state.phase,
        runtimeEpoch: state.runtimeEpoch,
        canInteract: state.canInteract,
        wait: state.wait,
        output: state.output,
        fault: state.fault,
        debug: state.debug,
      });
      await writeFile(
        path.join(config.outputDirectory, "inspection-frontier.json"),
        `${JSON.stringify(
          {
            before: frontier(terminal),
            after: frontier(final),
            inspect,
            inspectError,
            records: final.serviceEvidence.records.filter((row) => row.channel === "debug"),
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      throw new Error("case left terminal observation during typed inspection");
    }
    await record("complete", final, {
      request: config.request,
      ...(inspect ? { inspect } : {}),
      ...(inspectError ? { inspectError } : {}),
    });
    activeCapture = undefined;
    await assertCaptureInputsUnchanged(config, inputs);
    await writer.record({ type: "case_end", case: caseId, captureComplete: true });
    await writer.record({ type: "footer", captureComplete: true });
    const trace = await writer.close();
    const manifest = {
      version: 1,
      kind: "rustyera_real_frontend_capture",
      identity,
      caseIds: [caseId],
      trace,
    };
    const manifestPath = path.join(config.outputDirectory, "capture.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const missing = (config.request.watch ?? []).filter(
      (watch) => !inspect?.values?.[watch]?.present,
    );
    const result = {
      manifestPath,
      artifactPaths: inputs.artifactPaths,
      frontendRoot: config.frontendRoot,
      status:
        inspectError || missing.length
          ? "captured_with_observation_blocks"
          : "captured_not_compared",
      case: caseId,
      terminal: captureTerminal(terminal),
      missingWatches: missing,
      inspectError,
      environment,
    };
    await writeFile(
      path.join(config.outputDirectory, "producer-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx" },
    );
    completed = true;
    return result;
  } finally {
    activeCapture = undefined;
    // Keep fault observations allowed until the owning runner stops its monitor and exits.
    if (!completed)
      await writer.abort(new Error("capture incomplete; no successful footer/manifest"));
  }
}

export function webdriverCaptureClient(browser) {
  return {
    execute: (callback, ...args) => browser.execute(callback, ...args),
    version: browser.capabilities?.browserVersion,
    async submit(value) {
      const input = await browser.$(".prompt-bar input");
      await input.waitForDisplayed({ timeout: 5000 });
      await input.waitForEnabled({ timeout: 5000 });
      await input.setValue(value);
      await browser.keys("Enter");
    },
  };
}
