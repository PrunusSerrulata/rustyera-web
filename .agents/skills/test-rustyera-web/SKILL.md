---
name: test-rustyera-web
description: Drive rustyera-web through its real Vue UI in Chromium/WASM or its real Tauri WebView through WebdriverIO, including deterministic game flows, debugger checks against eraTW, save/snapshot restore, DOM interaction, trace capture, and Emuera reference differential tests. Use after Web/runtime-facing changes, when reproducing browser or desktop failures, when checking debugger/UI behavior, or when an agent must explore an Era game interactively.
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

Use `npm run test:game` for browser/WASM coverage and `npm run test:tauri` for native-client
coverage. Do not replace either runner with direct Pinia mutation, mocked IPC, a second runtime
state machine, or screenshot-only evidence. Read [test-cli.md](references/test-cli.md) before
changing a browser scenario, [page-api.md](references/page-api.md) before adding browser DOM or
frontend-state actions, and [tauri-e2e.md](references/tauri-e2e.md) before changing a Tauri test.

## Choose the real target

- A browser/WASM claim requires Chromium, the production Vue UI, and the WASM worker through
  `npm run test:game`.
- A Tauri claim requires the built Tauri binary, its native Rust commands, the platform WebView,
  and WebdriverIO's embedded provider through `npm run test:tauri`.
- Passing browser tests does not establish Tauri behavior. Never substitute Playwright browser
  mode, mocked `invoke`, AppleScript coordinate clicks, screenshots, or direct store mutation for a
  Tauri result.

## Prepare

1. Inspect `AGENTS.md`, `package.json`, the relevant diff, and the selected scenario.
2. Build `public/wasm` when it is absent or stale, and install the repository-local Playwright
   Chromium when needed.
3. Keep the source game and reference repository read-only. The runner copies each project to a
   temporary directory and writes artifacts below `.rustyera/test-runs` by default.
4. Leave `seed` absent for randomized exploration. Copy the effective seed from the `start` event
   into the reproduction before claiming that a failure is reproducible.

## Run fixed work

```sh
npm run test:game -- run --scenario SCENARIO [--project PROJECT]
```

For Emuera comparison, add one shell-quoted `--reference-command`; under Wine also add
`--reference-path-command`. Treat timeouts, missing capabilities, schema drift, browser crashes,
or an empty reference response as infrastructure failures.

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

For browser runs, report the scenario, command, exit code, effective seed, fixed clock, trace path,
checked DOM/state assertions, and the first difference or blocked check. For Tauri runs, report the
real project path, platform/WebView session, visible actions, and exact debugger/runtime outputs.
Screenshots may supplement a failure but cannot prove behavior. Traditional saves can be compared
with Emuera. VM snapshots are RustyEra-only unless the scenario supplies an equivalent reference
state.

## Validate changes

Run focused Vitest first, then `npm test`, typecheck, ESLint, Prettier check, build, WASM build, and
relevant browser/game scenarios. For Tauri-facing changes, also run `npm run test:tauri` against the
real eraTW checkout. Use the short reference fixture for browser CLI changes and eraTW for native
debugger and long-flow coverage. If the reference CLI changes, apply its repository's own
validation gates.
