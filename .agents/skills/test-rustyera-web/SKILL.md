---
name: test-rustyera-web
description: Drive rustyera-web through its real Vue UI and WASM worker in Chromium, native Firefox, and native Safari, or through its real Tauri WebView, including deterministic game flows, cross-browser compatibility, debugger checks against eraTW, save/snapshot restore, DOM interaction, trace capture, and Emuera reference differential tests. Use after Web/runtime-facing changes, when reproducing browser or desktop failures, when checking debugger/UI behavior, or when an agent must explore an Era game interactively.
---

# Test RustyEra Web

Use `npm run test:game` for deterministic Chromium/WASM coverage,
`npm run test:browser-compat` for native Firefox/Safari WASM coverage, and
`npm run test:tauri` for native-client coverage. Do not replace these runners with direct Pinia
mutation, mocked IPC, a second runtime state machine, browser-engine substitutes, or
screenshot-only evidence. Read [test-cli.md](references/test-cli.md) before changing a browser
scenario or compatibility runner, [page-api.md](references/page-api.md) before adding browser DOM
or frontend-state actions, and [tauri-e2e.md](references/tauri-e2e.md) before changing a Tauri test.

## Choose the real target

- A browser/WASM claim requires the production Vue UI and real WASM worker in all three desktop
  targets: Chromium through `npm run test:game`, plus the installed native Firefox and Safari
  through `npm run test:browser-compat`.
- A Tauri claim requires the built Tauri binary, its native Rust commands, the platform WebView,
  and WebdriverIO's embedded provider through `npm run test:tauri`.
- Passing one browser does not establish the other browsers or Tauri. Never substitute Playwright's
  Firefox/WebKit bundles for the installed Firefox/Safari applications, or substitute mocked
  `invoke`, AppleScript coordinate clicks, screenshots, or direct store mutation for a Tauri result.

## Prepare

1. Inspect `AGENTS.md`, `package.json`, the relevant diff, and the selected scenario.
2. Build `public/wasm` when it is absent or stale. Install the repository-local Playwright Chromium
   when needed; verify native Firefox is installed and enable Safari's **Allow remote automation**
   developer setting before starting its WebDriver session.
3. Keep the source game and reference repository read-only. The runner copies each project to a
   temporary directory and writes artifacts below `.rustyera/test-runs` by default.
4. Leave `seed` absent for randomized exploration. Copy the effective seed from the `start` event
   into the reproduction before claiming that a failure is reproducible.

## Run fixed work

```sh
npm run test:game -- run --scenario SCENARIO [--project PROJECT]
npm run test:browser-compat -- --browser firefox
npm run test:browser-compat -- --browser safari
```

Chromium game tests and native Firefox/Safari tests launch browser automation and a local test
server. Always run every `npm run test:game` and `npm run test:browser-compat` command outside the
filesystem sandbox with `sandbox_permissions=require_escalated`; state in the approval
justification that browser automation and local server binding are required. Do not make an
initial sandboxed attempt. A listen `EPERM`, driver startup failure, or automation timeout from a
sandboxed run is an invalid infrastructure attempt, not a product failure; rerun it outside the
sandbox before diagnosing the application or test.

For Emuera comparison, add one shell-quoted `--reference-command`; under Wine also add
`--reference-path-command`. Treat timeouts, missing capabilities, schema drift, browser crashes,
an empty reference response, an unavailable native browser, or disabled Safari remote automation
as infrastructure failures. Firefox runs headless; Safari uses a separate automation window and
must be minimized when WebDriver permits it.

## Run agent-directed work

Start `serve` in a persistent terminal session. Parse every NDJSON observation before writing one
NDJSON command:

- `{"op":"step","input":"..."}` submits through the visible prompt form.
- `{"op":"ui","action":...}` performs a declared click, fill, press, query, or assertion.
- `{"op":"query","locator":...}` reads the live DOM without advancing the game.
- `{"op":"inspect","watches":["FLAG:0"]}` uses the debug protocol only when output is insufficient.
- `{"op":"checkpoint","path":"..."}` downloads a VM snapshot through the test lifecycle API.
- `{"op":"stop"}` ends only after the goal is met or further work cannot add coverage.

Choose visible, enabled controls and valid game inputs. Do not call the page test global to submit
gameplay input. Continue until the goal passes, the first differential failure occurs, or the hard
step/time budget is exhausted.

## Run native Tauri work

```sh
npm run test:tauri -- --project ../games/eraTW
```

Tauri tests launch a native GUI application and platform WebView, so always run every
`npm run test:tauri` command outside the filesystem sandbox with
`sandbox_permissions=require_escalated`; state in the approval justification that the command must
launch the native Tauri GUI/WebView. Do not make an initial sandboxed attempt. An embedded WebDriver
startup timeout from a sandboxed run is an invalid infrastructure attempt, not a product failure;
rerun it outside the sandbox before diagnosing the application or test.

Long browser and native runs must expose progress instead of using one silent wait. Poll observable
runtime state, print a concise diagnostic at least every 60 seconds, fail immediately on a runtime
fault or terminal version/protocol rejection, and fail a stalled stage after 60 seconds without a
meaningful phase, status, wait, presentation, output, or log change. A longer total timeout is
allowed only while those observations continue to show progress. If the test stalls at an
actionable input, fix the test flow; if the runtime keeps advancing but never reaches the expected
state, diagnose the product or game behavior. Do not weaken the expected reference state to avoid a
timeout.

For native Firefox/Safari compatibility startup, require the visible project-open action to
exercise the directory-file fallback or begin opening a project within 10 seconds. Record the
created file input's type, multiplicity, accept filter, and directory flag in failure diagnostics;
do not leave a native file sheet open until the overall runtime timeout.

Real-host end-to-end builds must start with the frontend's default preferences unless the scenario
explicitly tests a preference. Do not inherit a developer's persisted font size, image scale, or
font family, because those make reference geometry nondeterministic across machines.

`ERATW_PROJECT` may supply another real eraTW checkout. The command builds a test-only Tauri binary
with the WebdriverIO plugins, launches the platform WebView, opens the project through the real Rust
filesystem commands, and drives visible controls. Assert `bridgeKind: "tauri"` before making a
native-client claim. Keep WebdriverIO actions as the source of truth for interaction; the test
control may observe lifecycle and debugger state but must not perform the feature under test.

## Report

For Chromium runs, report the scenario, command, exit code, effective seed, fixed clock, trace path,
checked DOM/state assertions, and the first difference or blocked check. For Firefox/Safari, report
the installed browser version and UA, command and exit code, OPFS result, compile status, observed
WASM output, and whether the Safari window was minimized. For Tauri, report the real project path,
platform/WebView session, visible actions, and exact debugger/runtime outputs. Screenshots may
supplement a failure but cannot prove behavior. Traditional saves can be compared with Emuera. VM
snapshots are RustyEra-only unless the scenario supplies an equivalent reference state.

## Validate changes

Run focused Vitest first, then `npm test`, typecheck, ESLint, Prettier check, build, WASM build, the
relevant Chromium game scenario, and both native-browser compatibility commands. For Tauri-facing
changes, also run `npm run test:tauri` against the real eraTW checkout. Use the short reference
fixture for browser CLI and cross-browser compatibility changes, and eraTW for native debugger and
long-flow coverage. If the reference CLI changes, apply its repository's own validation gates.
