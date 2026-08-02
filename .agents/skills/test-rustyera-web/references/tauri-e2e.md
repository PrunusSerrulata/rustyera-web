# Real Tauri end-to-end tests

## Required stack

Run `npm run test:tauri -- --project PROJECT`. The runner must:

1. resolve and verify a real Era project directory;
2. build `era-web-tauri` with the test-only `webdriver` Cargo feature and
   `src-tauri/tauri.webdriver.conf.json`;
3. launch that binary with `@wdio/tauri-service` using `driverProvider: "embedded"`;
4. drive the native WebView with WebdriverIO selectors and actions;
5. assert `window.__RUSTYERA_TEST__.snapshot().bridgeKind === "tauri"` before feature checks.

The embedded provider uses `tauri-plugin-wdio-webdriver` inside the application and must not enable
`autoInstallTauriDriver`. The external Cargo `tauri-driver` is not used by this provider and is not
supported on macOS. Treat its absence in generic environment diagnostics as non-blocking; require
the embedded server and a real `bridgeKind: "tauri"` session before accepting the test.
The test-only Tauri configuration must create a visible main window, and the runner must expose
backend/service progress; an application process without a discoverable native window is a test
startup failure, not evidence that the GUI is running.
Use the service's standalone session lifecycle for the native spec runner. This avoids duplicating
the embedded application lifecycle between WebdriverIO launcher and worker processes while keeping
the same WebdriverIO selectors/actions, native WebView session, and service cleanup guarantees.

The command launches a native GUI application and platform WebView. Always run it outside the
filesystem sandbox with `sandbox_permissions=require_escalated`, and explain in the approval
justification that native Tauri GUI/WebView startup is required. Do not first try it in the sandbox.
Treat an embedded WebDriver startup timeout from a sandboxed run as an invalid infrastructure
attempt and rerun outside the sandbox before diagnosing a product or test failure.

Do not hide long game setup behind one silent WebDriver wait. For a stage whose total budget can
exceed 60 seconds, poll the test-control snapshot, emit phase/status/wait/presentation/output/log
diagnostics at least once per 60 seconds, abort immediately on `fault` or a terminal version/protocol
rejection, and fail after 60 seconds without meaningful observable progress. Reaching a new input
wait counts as progress but also means the test must decide whether to submit it; repeatedly waiting
at an actionable prompt is a test-flow bug. Preserve the reference behavior and geometry assertions
when repairing a timeout.

The test build must use default frontend preferences unless the spec explicitly covers a preference;
persisted user font and image settings are not valid inputs to reference-geometry tests.

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
