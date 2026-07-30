---
name: test-rustyera-web
description: Drive rustyera-web through its real Vue UI and WASM worker in Chromium, native Firefox, and native Safari, or through its real Tauri WebView, including deterministic game flows, cross-browser compatibility, debugger checks against eraTW, save/snapshot restore, DOM interaction, trace capture, and Emuera reference differential tests. Use after Web/runtime-facing changes, when reproducing browser or desktop failures, when checking debugger/UI behavior, or when an agent must explore an Era game interactively.
---

# Test RustyEra Web

## Assign testing

Delegate every test command to a sub-agent running **gpt-5.6-terra low**. Instruct it to run
tests only and return each command, exit code, and relevant output. Do not allow it to edit,
format, or commit code, fixtures, documentation, or configuration. Permit test-generated files
only in temporary or ignored directories.

Keep implementation, formatting, test authoring, failure diagnosis, and fixes with the main
agent. Never substitute a main-agent test run for the testing sub-agent.

If any implementation, test, fixture, dependency, or build input changes after a relevant test
starts, immediately tell the testing sub-agent what changed. Require it to rebuild as needed and
rerun every affected check; discard stale results.

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
