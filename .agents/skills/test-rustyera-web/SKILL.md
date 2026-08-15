---
name: test-rustyera-web
description: Drive rustyera-web through its real Vue UI and WASM worker in Chromium, native Firefox, and native Safari on macOS, or through its real Tauri WebView, including deterministic game flows, cross-browser compatibility, debugger checks against eraTW, save/snapshot restore, DOM interaction, trace capture, and Emuera reference differential tests. Use after Web/runtime-facing changes, when reproducing browser or desktop failures, when checking debugger/UI behavior, or when an agent must explore an Era game interactively.
---

# Test RustyEra Web

Use `npm run test:game` for deterministic Chromium/WASM coverage,
`npm run test:browser-compat` for native Firefox and macOS-only Safari WASM coverage, and
`npm run test:tauri` for native-client coverage. Do not replace these runners with direct Pinia
mutation, mocked IPC, a second runtime state machine, browser-engine substitutes, or
screenshot-only evidence. Read [test-cli.md](references/test-cli.md) before changing a browser
scenario or compatibility runner, [page-api.md](references/page-api.md) before adding browser DOM
or frontend-state actions, and [tauri-e2e.md](references/tauri-e2e.md) before changing a Tauri test.

## Enforce the task budget

- Before starting any test command, confirm that any required refactoring subagent has completed
  its single permitted run and that every requirement it reported has been implemented. Refuse to
  start testing while any refactoring requirement remains. Once the first test starts, never spawn,
  resume, follow up with, or rerun a refactoring subagent during that task.
- Start one shared 60-minute wall-clock budget with the task's first test command. It includes all
  subsequent checks, targeted reruns, end-to-end waits, and test-failure investigation. Bound every
  command by the remaining time.
- Before creating, resuming, following up with, or assigning a subagent to any browser, native, or
  other dynamic end-to-end test, complete every static gate authorized for the task. Static gates
  include the applicable focused unit/integration tests, typecheck, lint, format check, and build
  checks. If the user limits validation scope, "every" means every gate inside that scope and does
  not authorize broader suites. A static failure invalidates affected prior results; rerun only the
  smallest affected static set after the fix, and do not assign dynamic testing until all authorized
  static gates pass again. A subagent used only for static tests may be created earlier, but it must
  not receive a dynamic-test command before this gate is satisfied.
- Start each distinct full test suite at most once per task. After a failure is fixed, rerun only
  the directly affected test file, named case, browser scenario, or native scenario; never rerun
  the full suite.
- Run every command that may outlive its initial tool response in a persistent PTY. Start it with
  `exec_command` using `tty: true` and a short yield, retain the returned `session_id`, and poll only
  with `write_stdin` at intervals no longer than 30 seconds until an explicit exit code is observed.
  Do not resume a yielded exec cell with a separate wait call: the cell may be reclaimed before its
  result is collected. If a PTY session disappears without an exit code, report the command as
  unverified; never restart a full suite, and rerun a targeted command only when the suite rules
  permit it.
- From launch through exit, every browser and Tauri end-to-end run must emit a complete snapshot
  every 5 seconds. Each snapshot enumerates every current HTML element with its tag, attributes,
  text/value, and visibility, and includes runtime, presentation, output, status, and log state.
  Ignore timestamps and reporting-only metadata during comparison. If two consecutive snapshots
  are identical, the game is static: terminate immediately and report a stalled-test failure.
- At the 60-minute deadline, terminate all test processes and report the active command, exact
  case/stage, last complete snapshot, elapsed time, completed checks, and unverified checks.

## Choose the real target

- A browser/WASM claim requires the production Vue UI and real WASM worker in Chromium through
  `npm run test:game` and installed native Firefox through `npm run test:browser-compat`. On macOS,
  it additionally requires installed native Safari. When the host OS is not macOS, do not launch
  or require Safari; report it as not applicable rather than skipped, passed, or failed.
- A Tauri claim requires the built Tauri binary, its native Rust commands, the platform WebView,
  and WebdriverIO's embedded provider through `npm run test:tauri`.
- Passing one browser does not establish the other browsers or Tauri. Never substitute Playwright's
  Firefox/WebKit bundles for the installed Firefox/Safari applications, or substitute mocked
  `invoke`, AppleScript coordinate clicks, screenshots, or direct store mutation for a Tauri result.

## Prepare

1. Inspect `AGENTS.md`, `package.json`, the relevant diff, and the selected scenario.
2. Build `public/wasm` when it is absent or stale. Always run `npm run build:wasm` outside the
   filesystem sandbox with `sandbox_permissions=require_escalated`; state in the approval
   justification that the build must write Rust/WASM tool caches and may install `wasm-bindgen`.
   Do not make an initial sandboxed attempt. Install the repository-local Playwright Chromium when
   needed; verify native Firefox is installed. On macOS, enable Safari's **Allow remote
   automation** developer setting before starting its WebDriver session.
3. Keep the source game and reference repository read-only. The runner copies each project to a
   temporary directory and writes artifacts below `.rustyera/test-runs` by default.
4. Leave `seed` absent for randomized exploration. Copy the effective seed from the `start` event
   into the reproduction before claiming that a failure is reproducible.

## Run fixed work

```sh
npm run test:game -- run --scenario SCENARIO [--project PROJECT]
npm run test:browser-compat -- --browser firefox
# macOS only
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
an empty reference response, or an unavailable required native browser as infrastructure failures.
Firefox runs headless. On macOS, unavailable or disabled Safari remote automation is an
infrastructure failure; Safari uses a separate automation window and must be minimized when
WebDriver permits it. On other operating systems, do not invoke the Safari command.

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

Long browser and native runs must expose progress instead of using one silent wait. Poll and print
the complete snapshot described above every 5 seconds, fail immediately on a runtime fault or
terminal version/protocol rejection, and fail immediately when a snapshot matches the preceding
one. There is no additional stall grace period. If the test stalls at an actionable input, fix the
test flow; if the runtime keeps advancing but never reaches the expected state, diagnose the
product or game behavior. Do not weaken the expected reference state to avoid a timeout.

For native-browser compatibility startup, require the visible project-open action to
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
checked DOM/state assertions, and the first difference or blocked check. For each required native
browser, report the installed browser version and UA, command and exit code, OPFS result, compile
status, and observed WASM output; on macOS, also report whether the Safari window was minimized.
For Tauri, report the real project path,
platform/WebView session, visible actions, and exact debugger/runtime outputs. Screenshots may
supplement a failure but cannot prove behavior. Traditional saves can be compared with Emuera. VM
snapshots are RustyEra-only unless the scenario supplies an equivalent reference state.

## Validate changes

Run every Vitest command whose selected tests include `tests/viteTestServer.test.ts` outside the
filesystem sandbox with `sandbox_permissions=require_escalated`; this includes the complete
`npm test` suite. State in the approval justification that the test must bind a temporary local
loopback server. Do not make an initial sandboxed attempt.

Run focused Vitest first, then run `npm test` once, followed by typecheck, ESLint, Prettier check,
build, WASM build, the relevant Chromium game scenario, and native Firefox compatibility. On
macOS, also run native Safari compatibility; on other operating systems, do not run Safari. If the
complete Vitest fails, fix it and rerun only the directly affected files or named
cases. For Tauri-facing changes, also run `npm run test:tauri` against the real eraTW checkout. Use
the short reference fixture for browser CLI and cross-browser compatibility changes, and eraTW for
native debugger and long-flow coverage. If the reference CLI changes, apply its repository's own
validation gates.
