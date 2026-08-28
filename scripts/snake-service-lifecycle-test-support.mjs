/* global document, HTMLElement, window */
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

async function installObservation(browser) {
  await browser.execute(() => {
    if (window.__RUSTYERA_SERVICE_TRACE__)
      throw new Error("service DOM observer already installed");
    const observed = { pointer: null, blurCount: 0, events: [] };
    const pointer = (event) => {
      if (event.pointerType === "touch") return;
      const point = { x: event.clientX, y: event.clientY };
      if (event.type !== "pointerout" && event.type !== "pointercancel") observed.pointer = point;
      observed.events.push({
        type: event.type,
        ...point,
        trusted: event.isTrusted,
        focused: document.hasFocus(),
      });
      if (observed.events.length > 32) observed.events.shift();
    };
    const blur = (event) => {
      if (event.isTrusted) observed.blurCount += 1;
      observed.events.push({
        type: event.type,
        trusted: event.isTrusted,
        focused: document.hasFocus(),
      });
      if (observed.events.length > 32) observed.events.shift();
    };
    for (const type of ["pointermove", "pointerdown", "pointerup", "pointerout", "pointercancel"])
      window.addEventListener(type, pointer, true);
    window.addEventListener("blur", blur);
    // This observer records actual DOM input only; it never dispatches events or changes runtime state.
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
      },
    };
  });
}

async function geometry(browser) {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    const observed = window.__RUSTYERA_SERVICE_TRACE__?.observed;
    if (!(viewport instanceof HTMLElement) || !observed?.pointer || !document.hasFocus())
      throw new Error("pointer sample needs an observed real pointer and focused viewport");
    const rect = viewport.getBoundingClientRect();
    const hit = document.elementFromPoint(observed.pointer.x, observed.pointer.y);
    return {
      pointer: { ...observed.pointer },
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
      hit: hit ? { tag: hit.tagName, text: hit.textContent?.slice(0, 100) } : null,
      blurCount: observed.blurCount,
      events: [...observed.events],
    };
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
  await installObservation(browser);
  try {
    for (let index = 0; index < 6; index += 1) {
      await input.setValue(String(index));
      if (index === 0) await hoverLifecycleTarget(browser);
      else if (index === 1) await moveInside(browser);
      else if (index === 2) await (await browser.$("#menu-file")).moveTo();
      else if (index === 3) {
        const before = await geometry(browser);
        await browser.setWindowSize(
          windowSize.width > 960 ? windowSize.width - 120 : windowSize.width + 120,
          windowSize.height > 600 ? windowSize.height - 100 : windowSize.height + 100,
        );
        await browser.waitUntil(
          async () => {
            const next = await geometry(browser);
            return (
              next.viewport.width !== before.viewport.width ||
              next.viewport.height !== before.viewport.height
            );
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
          await observeRealWindowBlur(browser);
        } catch (error) {
          blocked.push({ stage: "window-blur", host: bridgeKind, reason: String(error) });
        }
      } else {
        const viewport = await browser.$(".game-viewport");
        await viewport.click();
        if ((await snapshot(browser)).wait.wait_id !== state.wait.wait_id)
          throw new Error("viewport focus unexpectedly advanced the game");
        const before = await geometry(browser);
        await browser.keys("PageUp");
        await browser.waitUntil(
          async () => (await geometry(browser)).viewport.scrollTop < before.viewport.scrollTop,
          { timeout: 3_000, interval: 100, timeoutMsg: "PageUp did not scroll the real viewport" },
        );
        await input.setValue(String(index));
      }
      const measuredGeometry = index === 5 ? null : await geometry(browser);
      const previousWait = state.wait.wait_id;
      // Enter is actual keyboard input; it does not move the pointer off the measured button.
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
      if (index === 5) {
        if (!blocked.length) {
          if (!state.output.includes("SNAKE_LIFECYCLE_POINTER_5=0/0/")) {
            const error = new Error(
              "real blur did not clear the pointer before a fresh pointer event",
            );
            error.lifecycleEvidence = {
              pointerOutput: state.output.filter((line) =>
                line.startsWith("SNAKE_LIFECYCLE_POINTER_5="),
              ),
              observation: await browser.execute(() => window.__RUSTYERA_SERVICE_TRACE__.observed),
              samples,
            };
            throw error;
          }
          samples.push({
            index,
            observed: "0/0/",
            blur: await browser.execute(() => window.__RUSTYERA_SERVICE_TRACE__.observed.blurCount),
          });
        }
      } else
        samples.push(
          assertLifecyclePointer(
            state,
            index,
            measuredGeometry,
            index === 0 || index === 3 ? "41" : "",
          ),
        );
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

async function observeRealWindowBlur(browser) {
  const original = await browser.getWindowHandle();
  const before = await browser.execute(() => window.__RUSTYERA_SERVICE_TRACE__.observed.blurCount);
  let temporary;
  try {
    await browser.newWindow("about:blank", {
      type: "window",
      windowName: "RustyEra lifecycle focus probe",
    });
    temporary = await browser.getWindowHandle();
    if (temporary === original) throw new Error("host did not create an independent focus target");
    await browser.switchToWindow(original);
    const after = await browser.execute(() => ({
      count: window.__RUSTYERA_SERVICE_TRACE__.observed.blurCount,
      focused: document.hasFocus(),
    }));
    if (after.count <= before || !after.focused)
      throw new Error("native focus change did not produce a trusted blur and restored focus");
  } finally {
    if (temporary && temporary !== original) {
      await browser.switchToWindow(temporary);
      await browser.closeWindow();
    }
    await browser.switchToWindow(original);
  }
}
