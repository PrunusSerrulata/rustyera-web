# Real Tauri end-to-end tests

## Required stack

Run `npm run test:tauri -- --project PROJECT`. The runner must:

1. resolve and verify a real Era project directory;
2. build `era-web-tauri` with the test-only `webdriver` Cargo feature and
   `src-tauri/tauri.webdriver.conf.json`;
3. launch that binary with `@wdio/tauri-service` using `driverProvider: "embedded"`;
4. drive the native WebView with WebdriverIO selectors and actions;
5. assert `window.__RUSTYERA_TEST__.snapshot().bridgeKind === "tauri"` before feature checks.

The default project is `../games/eraTW`; set `--project` or `ERATW_PROJECT` when the checkout lives
elsewhere. Do not copy or modify the game during a native read-only test.

## Interaction boundary

Use WebdriverIO `click`, `setValue`, `keys`, accessible selectors, and DOM reads for the behavior
under test. The test-only control may open no dialogs, submit no debugger commands, and mutate no
Pinia state; use it only to configure lifecycle state or observe a serializable snapshot after a
visible action.

These are not valid substitutes for a Tauri pass:

- Chromium or the WASM worker;
- a mocked Tauri `invoke` or bridge;
- synthetic protocol responses or direct store mutation;
- AppleScript/coordinate automation;
- screenshots or process existence without output assertions.

## Debugger acceptance

Against a real eraTW project, test each debugger surface independently:

- Console: enter an expression through the visible input and assert the exact result text.
- Variables: open the table, wait for bounded protocol pagination to finish, invoke a visible read
  control, and assert the returned value separately from button text.
- Fibers/call stack: assert a runnable fiber and a non-empty frame with a real function and source
  path.
- Source-line step: send F10 through WebdriverIO, assert a new stop token, and require
  `step_completed` with a real source location.

Record the real project path and the exact observed values/frame/stop in the test output. A timeout,
missing WebDriver capability, browser fallback, empty table, or unverified output is a failed run.

## Isolation

Keep `tauri-plugin-wdio` and `tauri-plugin-wdio-webdriver` behind the `webdriver` Cargo feature.
Load `@wdio/tauri-plugin` only when both the test build and the Tauri-specific
`VITE_RUSTYERA_TAURI_TEST=1` flag are active, and pass the WebDriver Tauri config only to the test
build. Production, browser tests, and ordinary `tauri dev` builds must not expose the WebDriver
plugin.
