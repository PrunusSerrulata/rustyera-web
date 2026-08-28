/* global document, HTMLElement, window */
import { Decoder } from "cbor-x";
import { submitSnakePrompt } from "./snake-data-test-support.mjs";
import { runLifecycleRaces } from "./snake-service-lifecycle-races.mjs";

const TARGET = "button=SNAKE_LIFECYCLE_TARGET";
const SERVICE_MARKER = "SNAKE_LIFECYCLE_SERVICES=4294901760/4278190335/1";

export function assertLifecyclePointer(state, index, geometry, buttonValue) {
  if (state?.fault) throw new Error(`lifecycle runtime fault: ${JSON.stringify(state.fault)}`);
  const prefix = `SNAKE_LIFECYCLE_POINTER_${index}=`;
  const lines = state.output?.filter((line) => line.startsWith(prefix)) ?? [];
  if (lines.length !== 1)
    throw new Error(`expected exactly one ${prefix}: ${JSON.stringify(lines)}`);
  const match = /^(-?\d+)\/(-?\d+)\/(.*)$/.exec(lines[0].slice(prefix.length));
  if (!match) throw new Error(`invalid pointer observation: ${lines[0]}`);
  const actual = { x: Number(match[1]), y: Number(match[2]), buttonValue: match[3] };
  const expected = {
    x: Math.trunc(geometry.pointer.x - geometry.viewport.left - geometry.viewport.clientLeft),
    y: Math.trunc(
      geometry.pointer.y -
        geometry.viewport.top -
        geometry.viewport.clientTop -
        geometry.viewport.height,
    ),
    buttonValue,
  };
  if (
    Math.abs(actual.x - expected.x) > 1 ||
    Math.abs(actual.y - expected.y) > 1 ||
    actual.buttonValue !== buttonValue
  )
    throw new Error(`pointer ${index}: ${JSON.stringify({ actual, expected, geometry })}`);
  return { index, actual, expected, geometry };
}

const pointerDecoder = new Decoder({ mapsAsObjects: false, useRecords: false });
function pointerPayload(bytes, fields) {
  if (!Array.isArray(bytes)) throw new Error("pointer evidence contains invalid CBOR bytes");
  const payload = Uint8Array.from(bytes, (value) => {
    // RuntimeEvidence serializes bridge BigInts as canonical decimal strings; replies may
    // already contain numeric bytes. Validate before conversion so coercion cannot hide drift.
    const byte =
      typeof value === "string" && /^(?:0|[1-9]\d{0,2})$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(byte) || byte < 0 || byte > 255)
      throw new Error("pointer evidence contains invalid CBOR bytes");
    return byte;
  });
  const value = pointerDecoder.decode(payload);
  if (
    !(value instanceof Map) ||
    value.size !== fields ||
    [...Array(fields).keys()].some((key) => !value.has(key))
  )
    throw new Error("pointer evidence has an invalid CBOR map");
  return value;
}

function expectedSample(observation) {
  const { pointer, viewport } = observation;
  if (
    typeof observation.focused !== "boolean" ||
    typeof observation.visible !== "boolean" ||
    !Number.isSafeInteger(observation.sequence) ||
    observation.sequence < 0 ||
    !viewport ||
    ![
      viewport.left,
      viewport.top,
      viewport.clientLeft,
      viewport.clientTop,
      viewport.width,
      viewport.height,
    ].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new Error("pointer sample has invalid independent viewport geometry");
  if (!observation.focused || !observation.visible || !pointer)
    return { x: 0, y: 0, buttonValue: "" };
  if (
    !pointer.trusted ||
    !pointer.focused ||
    !pointer.visible ||
    ![pointer.x, pointer.y].every(Number.isFinite) ||
    !Number.isSafeInteger(pointer.sequence) ||
    pointer.sequence > observation.sequence
  )
    throw new Error("pointer sample requires a trusted focused DOM event watermark");
  const x = pointer.x - viewport.left - viewport.clientLeft;
  const y = pointer.y - viewport.top - viewport.clientTop;
  return {
    x: Math.trunc(x),
    y: Math.trunc(y - viewport.height),
    buttonValue:
      x >= 0 && y >= 0 && x < viewport.width && y < viewport.height && observation.targetHovered
        ? "41"
        : "",
  };
}

/** MOUSEX/Y/B issue separate requests. Bind each expected field to its own synchronous DOM sample,
 * never a pre-Enter point or a later snapshot after the OS has delivered another pointer event. */
export function assertSampledLifecyclePointer(state, index, start) {
  if (state?.fault) throw new Error(`lifecycle runtime fault: ${JSON.stringify(state.fault)}`);
  const evidence = state?.serviceEvidence;
  if (
    !evidence?.enabled ||
    evidence.overflow ||
    evidence.failure ||
    !Number.isSafeInteger(evidence.sessionGeneration) ||
    !Array.isArray(evidence.pointerSamples)
  )
    throw new Error("complete query-time pointer evidence is required");
  const current = (row) =>
    row.sessionGeneration === evidence.sessionGeneration &&
    String(row.epoch) === String(state.runtimeEpoch);
  const requests = evidence.records.filter(
    (row) =>
      row.index >= start.wireIndex &&
      current(row) &&
      row.direction === "receive" &&
      row.message?.type === "service_request" &&
      row.message.value?.kind === "input_state" &&
      row.message.value.operation === "pointer_state",
  );
  const samples = evidence.pointerSamples.filter((row) => row.index >= start.sampleIndex);
  if (requests.length !== 3 || samples.length !== 3)
    throw new Error("MOUSEX/Y/B require exactly three requests and synchronous samples");
  const queries = requests.map((request, order) => {
    const matches = samples.filter(
      (sample) =>
        current(sample) && String(sample.requestId) === String(request.message.value.request_id),
    );
    const responses = evidence.records.filter(
      (row) =>
        row.index > request.index &&
        current(row) &&
        row.direction === "send" &&
        row.message?.type === "service_response" &&
        String(row.message.value.request_id) === String(request.message.value.request_id),
    );
    if (matches.length !== 1 || responses.length !== 1)
      throw new Error("pointer request has no unique same-session sample and reply");
    const sample = matches[0],
      response = responses[0];
    if (
      sample.index !== start.sampleIndex + order ||
      sample.wireIndex <= request.index ||
      sample.wireIndex > response.index ||
      (order > 0 && samples[order - 1].wireIndex >= request.index) ||
      (order < 2 && response.index >= requests[order + 1].index) ||
      response.message.value.result?.type !== "ready"
    )
      throw new Error("pointer sample is not ordered between its request and successful reply");
    const version = request.message.value.operation_version;
    if (String(version?.major) !== "1" || String(version?.minor) !== "0")
      throw new Error("pointer observation requires pointer_state@1.0");
    const query = pointerPayload(request.message.value.payload, 3);
    const result = pointerPayload(response.message.value.result.payload, 6);
    const revisions = ["presentationRevision", "environmentRevision", "projectionSpaceRevision"];
    if (
      revisions.some(
        (name, field) =>
          String(sample.context?.[name]) !== String(query.get(field)) ||
          String(result.get(field + 3)) !== String(query.get(field)),
      )
    )
      throw new Error("pointer sample projection revisions do not match the actual request/reply");
    if (index === 5 && !(sample.observation.blurCount > 0))
      throw new Error("pointer sample requires an observed trusted blur");
    const expected = expectedSample(sample.observation);
    const actual = {
      x: Number(result.get(0)),
      y: Number(result.get(1)),
      buttonValue: result.get(2),
    };
    if (
      !Number.isSafeInteger(actual.x) ||
      !Number.isSafeInteger(actual.y) ||
      Math.abs(actual.x - expected.x) > 1 ||
      Math.abs(actual.y - expected.y) > 1 ||
      actual.buttonValue !== expected.buttonValue
    )
      throw new Error(
        `pointer ${index} query ${order}: ${JSON.stringify({ actual, expected, sample })}`,
      );
    return { requestIndex: request.index, responseIndex: response.index, sample, actual, expected };
  });
  const prefix = `SNAKE_LIFECYCLE_POINTER_${index}=`;
  const lines = state.output?.filter((line) => line.startsWith(prefix)) ?? [];
  const match =
    lines.length === 1 && /^(-?\d+)\/(-?\d+)\/(.*)$/.exec(lines[0].slice(prefix.length));
  if (!match) throw new Error(`expected exactly one valid ${prefix}`);
  const actual = { x: Number(match[1]), y: Number(match[2]), buttonValue: match[3] };
  const expected = {
    x: queries[0].expected.x,
    y: queries[1].expected.y,
    buttonValue: queries[2].expected.buttonValue,
  };
  if (
    actual.x !== queries[0].actual.x ||
    actual.y !== queries[1].actual.y ||
    actual.buttonValue !== queries[2].actual.buttonValue ||
    Math.abs(actual.x - expected.x) > 1 ||
    Math.abs(actual.y - expected.y) > 1 ||
    actual.buttonValue !== expected.buttonValue ||
    (index !== 5 && expected.buttonValue !== (index === 0 || index === 3 ? "41" : ""))
  )
    throw new Error(`pointer ${index}: ${JSON.stringify({ actual, expected, queries })}`);
  return { index, actual, expected, queries, mode: "query-time-dom-samples" };
}

async function snapshot(browser) {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function waitStage(browser, bridgeKind, marker, previousWait) {
  let state;
  await browser.waitUntil(
    async () => {
      state = await snapshot(browser);
      if (state?.fault) throw new Error(`lifecycle runtime fault: ${JSON.stringify(state.fault)}`);
      if (state?.bridgeKind && state.bridgeKind !== bridgeKind)
        throw new Error(`expected ${bridgeKind}`);
      return (
        state?.canInteract &&
        state.wait?.kind === "integer_value" &&
        state.wait.wait_id !== previousWait &&
        state.output?.includes(marker)
      );
    },
    { timeout: 30_000, interval: 100, timeoutMsg: `lifecycle stage did not reach ${marker}` },
  );
  return state;
}

export async function installPointerObservation(
  browser,
  targetSelector = 'button[aria-label="SNAKE_LIFECYCLE_TARGET"]',
) {
  await browser.execute((targetSelector) => {
    if (window.__RUSTYERA_SERVICE_TRACE__ || window.__RUSTYERA_POINTER_OBSERVATION__)
      throw new Error("service DOM observer already installed");
    // Validate the selector before installing any event listeners.
    document.querySelector(targetSelector);
    const observed = { pointer: null, blurCount: 0, sequence: 0, events: [] };
    const describeElement = (element) =>
      element instanceof HTMLElement
        ? {
            tag: element.tagName,
            text: element.textContent?.slice(0, 100),
            className: element.className,
            label: element.getAttribute("aria-label"),
          }
        : null;
    const record = (event) => {
      const entry = {
        sequence: ++observed.sequence,
        type: event.type,
        trusted: event.isTrusted,
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        target: describeElement(event.target),
        activeElement: describeElement(document.activeElement),
      };
      observed.events.push(entry);
      if (observed.events.length > 32) observed.events.shift();
      return entry;
    };
    const pointer = (event) => {
      if (event.pointerType === "touch") return;
      const entry = Object.assign(record(event), { x: event.clientX, y: event.clientY });
      if (event.type === "pointerout") entry.relatedTargetPresent = event.relatedTarget != null;
      if (
        !entry.focused ||
        !entry.visible ||
        event.type === "pointercancel" ||
        (event.type === "pointerout" && !entry.relatedTargetPresent)
      )
        observed.pointer = null;
      else if (["pointermove", "pointerdown", "pointerup"].includes(event.type))
        observed.pointer = entry;
    };
    const blur = (event) => {
      if (event.isTrusted) observed.blurCount += 1;
      record(event);
      observed.pointer = null;
    };
    const visibility = (event) => {
      record(event);
      if (document.visibilityState !== "visible") observed.pointer = null;
    };
    for (const type of ["pointermove", "pointerdown", "pointerup", "pointerout", "pointercancel"])
      window.addEventListener(type, pointer, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    // This callback only reads independent DOM input/geometry, synchronously at the actual sample.
    // Runtime return values are not available here and never supply the expected position.
    window.__RUSTYERA_POINTER_OBSERVATION__ = () => {
      const viewport = document.querySelector(".game-viewport");
      if (!(viewport instanceof HTMLElement) || !viewport.isConnected)
        throw new Error("pointer observation needs a connected game viewport");
      const rect = viewport.getBoundingClientRect();
      const point = observed.pointer;
      const hit = point ? document.elementFromPoint(point.x, point.y) : null;
      const target = document.querySelector(targetSelector);
      const targetRect = target?.getBoundingClientRect();
      return {
        pointer: point ? { ...point } : null,
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        viewport: {
          left: rect.left,
          top: rect.top,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          clientLeft: viewport.clientLeft,
          clientTop: viewport.clientTop,
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
        },
        hit: describeElement(hit),
        activeElement: describeElement(document.activeElement),
        targetSelector,
        target: targetRect
          ? {
              ...describeElement(target),
              left: targetRect.left,
              top: targetRect.top,
              right: targetRect.right,
              bottom: targetRect.bottom,
              width: targetRect.width,
              height: targetRect.height,
              disabled: target.hasAttribute("disabled"),
            }
          : null,
        targetHovered: Boolean(target?.contains(hit)),
        blurCount: observed.blurCount,
        sequence: observed.sequence,
        events: observed.events.map((event) => ({ ...event })),
      };
    };
    window.__RUSTYERA_SERVICE_TRACE__ = {
      observed,
      dispose() {
        for (const type of [
          "pointermove",
          "pointerdown",
          "pointerup",
          "pointerout",
          "pointercancel",
        ])
          window.removeEventListener(type, pointer, true);
        window.removeEventListener("blur", blur);
        document.removeEventListener("visibilitychange", visibility);
        delete window.__RUSTYERA_POINTER_OBSERVATION__;
      },
    };
  }, targetSelector);
}

export async function lifecycleViewport(browser) {
  return browser.execute(() => {
    const result = window.__RUSTYERA_POINTER_OBSERVATION__();
    if (!result.focused || !result.visible)
      throw new Error("viewport observation requires a visible focused document");
    // Resizing can legitimately move the old cursor outside the window. Geometry readiness
    // does not require a pointer; the subsequent real hover and service samples verify it.
    return result.viewport;
  });
}

async function moveInside(browser) {
  const point = await browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const rect = viewport.getBoundingClientRect();
    return {
      x: Math.round(rect.left + viewport.clientLeft + 20),
      y: Math.round(rect.top + viewport.clientTop + 20),
    };
  });
  await browser.performActions([
    {
      type: "pointer",
      id: "snake-service-pointer",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", duration: 0, origin: "viewport", ...point }],
    },
  ]);
}

export async function hoverLifecycleTarget(browser) {
  const target = await browser.$(TARGET);
  // WebDriver can move to a clipped element's center without reporting an out-of-bounds error.
  // Scroll the nested game viewport explicitly before requesting the real pointer move.
  await target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  await target.moveTo();
}

export async function setLifecyclePrompt(browser, input, value) {
  await input.waitForEnabled({ timeout: 3_000 });
  await input.setValue(value);
  let observed;
  await browser
    .waitUntil(
      async () => {
        observed = await browser.execute(() => {
          const input = document.querySelector(".prompt-bar input");
          return {
            value: input?.value,
            enabled: input && !input.disabled,
            focused: document.activeElement === input,
            documentFocused: document.hasFocus(),
          };
        });
        return (
          observed?.enabled &&
          observed.focused &&
          observed.documentFocused &&
          observed.value === value
        );
      },
      {
        timeout: 3_000,
        interval: 50,
        timeoutMsg: `native lifecycle prompt did not accept ${JSON.stringify(value)}`,
      },
    )
    .catch((error) => {
      error.message += `; actual=${JSON.stringify(observed)}`;
      throw error;
    });
}

/** Called inside the existing real-host runner and its uninterrupted five-second full snapshot monitor. */
export async function runSnakeServiceLifecycleClient(browser, bridgeKind, options) {
  const initial = await waitStage(browser, bridgeKind, "SNAKE_LIFECYCLE_START");
  const input = await browser.$(".prompt-bar input");
  await submitSnakePrompt(browser, "1");
  let state = await waitStage(
    browser,
    bridgeKind,
    "SNAKE_LIFECYCLE_POINTER_READY",
    initial.wait.wait_id,
  );
  if (!state.output.includes(SERVICE_MARKER))
    throw new Error("draw/output-before-query services did not return exact markers");
  const canvasCount = await browser.execute(
    () => document.querySelectorAll(".game-viewport canvas").length,
  );
  if (canvasCount !== 0)
    throw new Error("independent sampler fixture unexpectedly mounted a display canvas");
  const samples = [];
  const blocked = [];
  const windowSize = await browser.getWindowSize();
  await installPointerObservation(browser);
  try {
    for (let index = 0; index < 6; index += 1) {
      await setLifecyclePrompt(browser, input, String(index));
      if (index === 0) await hoverLifecycleTarget(browser);
      else if (index === 1) await moveInside(browser);
      else if (index === 2) await (await browser.$("#menu-file")).moveTo();
      else if (index === 3) {
        const before = await lifecycleViewport(browser);
        await browser.setWindowSize(
          windowSize.width > 960 ? windowSize.width - 120 : windowSize.width + 120,
          windowSize.height > 600 ? windowSize.height - 100 : windowSize.height + 100,
        );
        await browser.waitUntil(
          async () => {
            const next = await lifecycleViewport(browser);
            return next.width !== before.width || next.height !== before.height;
          },
          {
            timeout: 5_000,
            interval: 100,
            timeoutMsg: "real window resize did not alter the game viewport",
          },
        );
        await hoverLifecycleTarget(browser);
      } else if (index === 5) {
        await hoverLifecycleTarget(browser);
        try {
          await observeRealWindowBlur(browser, { nativeFocusWindow: bridgeKind === "tauri" });
        } catch (error) {
          blocked.push({ stage: "window-blur", host: bridgeKind, reason: String(error) });
        }
      } else {
        const viewport = await browser.$(".game-viewport");
        await viewport.click();
        if ((await snapshot(browser)).wait.wait_id !== state.wait.wait_id)
          throw new Error("viewport focus unexpectedly advanced the game");
        const before = await lifecycleViewport(browser);
        await browser.keys("PageUp");
        await browser.waitUntil(
          async () => (await lifecycleViewport(browser)).scrollTop < before.scrollTop,
          { timeout: 3_000, interval: 100, timeoutMsg: "PageUp did not scroll the real viewport" },
        );
        await setLifecyclePrompt(browser, input, String(index));
      }
      const beforeQuery = await snapshot(browser);
      const evidenceStart = {
        wireIndex: beforeQuery.serviceEvidence.records.length,
        sampleIndex: beforeQuery.serviceEvidence.pointerSamples.length,
      };
      const previousWait = state.wait.wait_id;
      // Enter is real input. OS moves during projection preparation are observed at each sample.
      await browser.keys("Enter");
      await browser.waitUntil(
        async () => {
          state = await snapshot(browser);
          if (state?.fault) throw new Error(JSON.stringify(state.fault));
          return (
            state?.canInteract &&
            state.wait?.kind === "integer_value" &&
            state.wait.wait_id !== previousWait
          );
        },
        { timeout: 30_000, interval: 100, timeoutMsg: `pointer stage ${index} did not complete` },
      );
      if (index !== 5 || !blocked.length) {
        try {
          samples.push(assertSampledLifecyclePointer(state, index, evidenceStart));
        } catch (error) {
          error.lifecycleEvidence = {
            pointerOutput: state.output.filter((line) =>
              line.startsWith(`SNAKE_LIFECYCLE_POINTER_${index}=`),
            ),
            evidenceStart,
            serviceEvidence: state.serviceEvidence,
            observation: await browser.execute(() => window.__RUSTYERA_SERVICE_TRACE__.observed),
            samples,
          };
          throw error;
        }
      }
    }
    await input.setValue("0");
    await browser.keys("Enter");
    const done = await waitStage(browser, bridgeKind, "SNAKE_LIFECYCLE_DONE", state.wait.wait_id);
    const races = await runLifecycleRaces(browser, bridgeKind, options);
    const report = {
      bridgeKind,
      samples,
      beforeRaces: { epoch: done.runtimeEpoch, output: done.output },
      races,
      unmountedCanvasCount: canvasCount,
      blocked,
    };
    if (blocked.length)
      throw new Error(`lifecycle host acceptance remains blocked: ${JSON.stringify(report)}`);
    return report;
  } finally {
    await browser.execute(() => {
      window.__RUSTYERA_SERVICE_TRACE__?.dispose();
      delete window.__RUSTYERA_SERVICE_TRACE__;
    });
    await browser.releaseActions();
  }
}

function freshPointerAfterBlur(observation) {
  const events = observation?.events ?? [];
  const blur = events.findLastIndex((event) => event.type === "blur" && event.trusted);
  let fresh;
  for (const event of events.slice(blur + 1)) {
    if (
      event.focused === false ||
      event.visible === false ||
      event.type === "pointercancel" ||
      (event.type === "pointerout" && !event.relatedTargetPresent)
    )
      fresh = undefined;
    else if (["pointermove", "pointerdown", "pointerup"].includes(event.type)) fresh = event;
  }
  return fresh;
}

export function assertBlurPointer(state, observation, measuredGeometry) {
  if (!observation.events.some((event) => event.type === "blur" && event.trusted))
    throw new Error("pointer sample requires an observed trusted blur");
  const fresh = freshPointerAfterBlur(observation);
  if (fresh) {
    if (!fresh.trusted || !fresh.focused)
      throw new Error("post-blur pointer must be a trusted event in the focused viewport");
    // Restoring a native window can emit an OS pointer move without a driver move action.
    // Derive the expected position from that pre-query event, never from the runtime answer.
    const sample = assertLifecyclePointer(
      state,
      5,
      { ...measuredGeometry, pointer: { x: fresh.x, y: fresh.y } },
      measuredGeometry.targetHovered ? "41" : "",
    );
    return { ...sample, blur: observation.blurCount, mode: "fresh-pointer-after-blur" };
  }
  if (state?.fault) throw new Error(`lifecycle runtime fault: ${JSON.stringify(state.fault)}`);
  const lines = state.output?.filter((line) => line.startsWith("SNAKE_LIFECYCLE_POINTER_5="));
  if (lines?.length !== 1 || lines[0] !== "SNAKE_LIFECYCLE_POINTER_5=0/0/")
    throw new Error("real blur did not clear the pointer before a fresh pointer event");
  return { index: 5, observed: "0/0/", blur: observation.blurCount, mode: "cleared-after-blur" };
}

export async function observeRealWindowBlur(browser, { nativeFocusWindow = false } = {}) {
  const original = await browser.getWindowHandle();
  const before = await browser.execute(() => window.__RUSTYERA_SERVICE_TRACE__.observed.blurCount);
  let temporary;
  try {
    // The high-level Classic helper uses window.open and the last unordered handle.
    // Use the native command's exact handle instead of guessing the newly created window.
    const created = await browser.createWindow("window");
    temporary = created.handle;
    if (!temporary || temporary === original || created.type !== "window")
      throw new Error("host did not create an independent native focus window");
    await browser.switchToWindow(temporary);
    // The explicit Tauri provider activates its native window itself. Browser drivers
    // (notably Safari) additionally need a visible control to request actual window focus.
    if (!nativeFocusWindow) {
      await browser.url(
        `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>RustyEra focus probe</title><button id="native-focus-target">Focus this test window</button>')}`,
      );
      await (await browser.$("#native-focus-target")).click();
    }
    await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
      timeout: 3000,
      interval: 50,
      timeoutMsg: "native focus window did not receive focus",
    });
  } finally {
    if (temporary && temporary !== original) {
      await browser.switchToWindow(temporary);
      await browser.closeWindow();
    }
    await browser.switchToWindow(original);
  }
  await browser.waitUntil(
    async () => {
      const after = await browser.execute(() => ({
        count: window.__RUSTYERA_SERVICE_TRACE__.observed.blurCount,
        focused: document.hasFocus(),
      }));
      return after.count > before && after.focused;
    },
    {
      timeout: 3000,
      interval: 50,
      timeoutMsg: "native focus change did not produce a trusted blur and restored focus",
    },
  );
}
