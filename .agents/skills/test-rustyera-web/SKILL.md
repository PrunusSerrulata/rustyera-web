---
name: test-rustyera-web
description: Drive rustyera-web through its real Vue UI, Chromium, and WASM worker for deterministic fixed-sequence, agent-directed, save/snapshot restore, DOM interaction, internal-state inspection, trace capture, and Emuera reference differential tests. Use after Web/runtime-facing changes, when reproducing browser game-flow failures, when checking HTML behavior or frontend state, or when an agent must explore an Era game interactively.
---

# Test RustyEra Web

Use `npm run test:game`; do not replace the runner with direct Pinia mutation or a second runtime
state machine. Read [test-cli.md](references/test-cli.md) before changing a scenario. Read
[page-api.md](references/page-api.md) before adding DOM or frontend-state actions.

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

## Report

Report the scenario, command, exit code, effective seed, fixed clock, trace path, checked DOM/state
assertions, and the first difference or blocked check. A full trace owns all input/output records;
failure artifacts include a screenshot, HTML, and browser console. Traditional saves can be
compared with Emuera. VM snapshots are RustyEra-only unless the scenario supplies an equivalent
reference state.

## Validate changes

Run focused Vitest first, then `npm test`, typecheck, ESLint, Prettier check, build, WASM build, and
relevant Playwright/game scenarios. Use the short reference fixture for CLI changes and eraTW only
for long-flow coverage. If the reference CLI changes, apply its repository's own validation gates.
