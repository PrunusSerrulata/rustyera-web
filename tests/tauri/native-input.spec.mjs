import assert from "node:assert/strict";
import { createServer } from "node:http";
import { captureCompleteTauriSnapshot } from "../../scripts/tauri-test-support.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_NATIVE_INPUT === "1" ? describe : describe.skip;

// This independent driver probe has no RustyEra test-global, runtime, game input, or mock bridge.
// Its page observes browser-delivered events. Input uses WebdriverIO selectors/actions.
const probeHtml = `<!doctype html><meta charset="utf-8"><title>Native input provider probe</title>
<style>body{margin:16px;font:16px sans-serif}button,input{font:inherit;padding:8px}
#scroll{height:150px;width:420px;overflow:auto;border:1px solid;margin-top:12px}
#spacer{height:650px}#events{white-space:pre-wrap;font:10px monospace;max-height:60px;overflow:hidden}</style>
<button id="click-target" type="button">Native pointer target</button>
<form id="form"><label>Text <input id="text" autocomplete="off"></label><button>Submit</button></form>
<div id="scroll" tabindex="0"><div id="spacer"></div><button id="scroll-bottom" type="button">Scroll target</button></div>
<pre id="events"></pre>
<script>
(() => {
  const state = {events: [], sequence: 0, clicks: 0, submits: 0, trustedBlur: 0, inputValues: [], scrollTop: 0};
  window.__NATIVE_INPUT_PROBE__ = state;
  const publish = () => { document.getElementById('events').textContent = JSON.stringify(state); };
  for (const type of ['pointermove','pointerdown','pointerup','pointerout','pointercancel','click','keydown','keyup','input','blur','focus']) {
    window.addEventListener(type, (event) => {
      state.events.push({sequence: ++state.sequence, type, trusted: event.isTrusted, target: event.target.id || '',
        key: event.key || '', x: event.clientX ?? null, y: event.clientY ?? null,
        focused: document.hasFocus()});
      if (state.events.length > 128) state.events.shift();
      if (type === 'blur' && event.target === window && event.isTrusted) state.trustedBlur += 1;
      if (type === 'input' && event.target.id === 'text') {
        state.inputValues.push({value: event.target.value, trusted: event.isTrusted});
        if (state.inputValues.length > 64) state.inputValues.shift();
      }
      publish();
    }, true);
  }
  document.getElementById('click-target').addEventListener('click', () => { state.clicks += 1; publish(); });
  document.getElementById('form').addEventListener('submit', (event) => {
    event.preventDefault(); state.submits += 1; publish();
  });
  document.getElementById('scroll').addEventListener('scroll', (event) => {
    state.scrollTop = event.target.scrollTop; publish();
  });
  publish();
})();
</script>`;

async function observation() {
  return browser.execute(() => ({
    ...window.__NATIVE_INPUT_PROBE__,
    focused: document.hasFocus(),
    value: document.querySelector("#text")?.value,
    scrollTop: document.querySelector("#scroll")?.scrollTop,
  }));
}

async function focused() {
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
    timeout: 3000,
    interval: 50,
    timeoutMsg: "native probe window did not receive actual document focus",
  });
}

async function assertMainWindowCloseRejected() {
  // WDIO's ContextManager treats even a rejected closeWindow as an empty handle list,
  // masking the native error. Inspect this negative infrastructure request directly;
  // all positive window operations and all input still use the real WDIO session.
  const { hostname, port, protocol, path: basePath } = browser.options;
  assert.ok(["localhost", "127.0.0.1"].includes(hostname));
  assert.equal(protocol, "http");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.ok(!basePath || basePath === "/");
  const response = await fetch(
    `http://${hostname}:${port}/session/${encodeURIComponent(browser.sessionId)}/window`,
    { method: "DELETE", signal: AbortSignal.timeout(3000), redirect: "error" },
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.value?.error, "invalid argument");
  assert.match(body.value?.message, /focus-probe.*main application window/);
  console.log(
    JSON.stringify({ type: "native-main-close-rejected", status: response.status, body }),
  );
}

enabled("Tauri native input provider", () => {
  it("routes selectors and actions through trusted native WebView input before any game action", async () => {
    assert.ok(
      process.env.RUSTYERA_NATIVE_WEBDRIVER_SOURCE,
      "explicit verified provider override is required",
    );
    const original = await browser.getWindowHandle();
    const created = [];
    // The provider's navigation uses location.href; WebKit rejects top-level data:
    // navigation. Serve only this fixed probe document on an isolated loopback port.
    const fixtureServer = createServer((request, response) => {
      if (request.url !== "/native-input") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(probeHtml);
    });
    await new Promise((resolve, reject) => {
      fixtureServer.once("error", reject);
      fixtureServer.listen(0, "127.0.0.1", resolve);
    });
    const probeUrl = `http://127.0.0.1:${fixtureServer.address().port}/native-input`;
    let primaryError;
    try {
      await browser.waitUntil(
        () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshot()?.bridgeKind === "tauri"),
        { timeout: 20_000, interval: 100 },
      );
      console.log(
        JSON.stringify({
          type: "native-input-main-before",
          snapshot: await captureCompleteTauriSnapshot(browser),
        }),
      );
      // Prove the explicit provider's new-window path exists before testing its close protection.
      const probe = await browser.createWindow("window");
      assert.equal(probe.type, "window");
      assert.notEqual(probe.handle, original);
      created.push(probe.handle);
      await browser.switchToWindow(original);
      // A bad native close request must not destroy the runtime host used for the probe.
      await assertMainWindowCloseRejected();
      assert.equal(await browser.getWindowHandle(), original);
      await assert.rejects(
        () => browser.switchToWindow("missing-native-probe"),
        /no such window|Unable to locate window/i,
      );

      await browser.switchToWindow(probe.handle);
      await browser.url(probeUrl);
      await focused();
      await browser.waitUntil(() => browser.execute(() => Boolean(window.__NATIVE_INPUT_PROBE__)), {
        timeout: 3000,
        interval: 50,
      });
      assert.equal(await browser.getUrl(), probeUrl);

      const target = await browser.$("#click-target");
      await target.waitForDisplayed({ timeout: 3000 });
      await target.moveTo();
      await target.click();
      await browser.waitUntil(async () => (await observation()).clicks > 0, {
        timeout: 3000,
        interval: 50,
      });
      const pointer = await observation();
      assert.equal(
        pointer.clicks,
        1,
        "one selector click must not produce a duplicate native/synthetic click",
      );
      for (const type of ["pointermove", "pointerdown", "pointerup", "click"]) {
        const matching = pointer.events.filter(
          (event) => event.type === type && event.target === "click-target",
        );
        assert.ok(matching.length > 0, `native ${type} was not observed on the selector target`);
        assert.ok(
          matching.every((event) => event.trusted),
          `native ${type} contained an untrusted event`,
        );
      }
      const bounds = await browser.execute(() => {
        const rect = document.querySelector("#click-target").getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      for (const event of pointer.events.filter(
        (entry) => entry.type === "pointerdown" && entry.target === "click-target",
      )) {
        assert.ok(
          event.x >= bounds.left &&
            event.x < bounds.right &&
            event.y >= bounds.top &&
            event.y < bounds.bottom,
          `native pointer coordinates missed the selector bounds: ${JSON.stringify(event)}`,
        );
      }

      const input = await browser.$("#text");
      await input.setValue("蛇A");
      await browser.waitUntil(async () => (await input.getValue()) === "蛇A", {
        timeout: 3000,
        interval: 50,
      });
      assert.equal(await input.getValue(), "蛇A");
      await input.setValue("新");
      await browser.waitUntil(async () => (await input.getValue()) === "新", {
        timeout: 3000,
        interval: 50,
      });
      assert.equal(
        await input.getValue(),
        "新",
        "native clear must remove previously entered Unicode text",
      );
      await browser.keys("Enter");
      await browser.waitUntil(async () => (await observation()).submits >= 1, {
        timeout: 3000,
        interval: 50,
      });
      const text = await observation();
      assert.equal(text.submits, 1, "one Enter must not submit the native form twice");
      assert.ok(text.inputValues.length > 0 && text.inputValues.every((event) => event.trusted));
      assert.ok(
        text.events.some(
          (event) => event.type === "keydown" && event.key === "Enter" && event.trusted,
        ),
      );

      await (await browser.$("#scroll-bottom")).click();
      const scrollBefore = (await observation()).scrollTop;
      assert.ok(
        scrollBefore > 0,
        "selector action did not reveal the bottom of the real scroll container",
      );
      await browser.keys("PageUp");
      await browser.waitUntil(async () => (await observation()).scrollTop < scrollBefore, {
        timeout: 3000,
        interval: 50,
        timeoutMsg: "native PageUp did not change actual scrollTop",
      });
      const scrolled = await observation();
      assert.ok(
        scrolled.events.some(
          (event) => event.type === "keydown" && event.key === "PageUp" && event.trusted,
        ),
      );

      const beforeBlur = scrolled.trustedBlur;
      const focusTarget = await browser.createWindow("window");
      created.push(focusTarget.handle);
      await browser.switchToWindow(focusTarget.handle);
      await focused();
      await assert.rejects(async () => {
        const unexpected = await browser.createWindow("window");
        created.push(unexpected.handle);
      }, /window limit reached/);
      await browser.switchToWindow(probe.handle);
      await focused();
      const restored = await observation();
      assert.ok(
        restored.trustedBlur > beforeBlur,
        "native window switch did not deliver a trusted window blur",
      );
      const eventBoundary = restored.sequence;
      await browser.keys("Enter");
      await browser.waitUntil(
        async () =>
          (await observation()).events.some(
            (event) =>
              event.sequence > eventBoundary &&
              event.type === "keydown" &&
              event.key === "Enter" &&
              event.trusted,
          ),
        { timeout: 3000, interval: 50, timeoutMsg: "restored probe did not receive native Enter" },
      );
      const afterEnter = await observation();
      assert.ok(
        afterEnter.events
          .filter((event) => event.sequence > eventBoundary)
          .some((event) => event.type === "keydown" && event.key === "Enter" && event.trusted),
      );
      assert.ok(
        !afterEnter.events
          .filter((event) => event.sequence > eventBoundary)
          .some((event) => event.type.startsWith("pointer")),
        "keyboard-only input unexpectedly generated a new pointer observation after restored focus",
      );
      assert.equal(
        afterEnter.clicks,
        1,
        "native target click must remain single after queued events settle",
      );
      console.log(
        JSON.stringify({
          type: "native-input-probe-result",
          pointer,
          text,
          scrolled,
          restored,
          afterEnter,
        }),
      );
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupErrors = [];
      try {
        console.log(
          JSON.stringify({
            type: "native-input-probe-frontier",
            snapshot: await captureCompleteTauriSnapshot(browser),
          }),
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const handle of [...created].reverse()) {
        if (handle === original) continue;
        try {
          await browser.switchToWindow(handle);
          await browser.closeWindow();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await browser.switchToWindow(original);
        await focused();
        const snapshot = await captureCompleteTauriSnapshot(browser);
        assert.equal(snapshot.runtime?.bridgeKind, "tauri");
        console.log(JSON.stringify({ type: "native-input-main-after", snapshot }));
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        console.error(
          JSON.stringify({
            type: "native-input-cleanup-failures",
            errors: cleanupErrors.map(String),
          }),
        );
        primaryError ??= new AggregateError(cleanupErrors, "native input probe cleanup failed");
      }
      fixtureServer.closeAllConnections();
      await new Promise((resolve, reject) =>
        fixtureServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (primaryError) throw primaryError;
  });
});
