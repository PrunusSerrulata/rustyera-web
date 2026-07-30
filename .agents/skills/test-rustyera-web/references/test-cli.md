# Web game-test protocol

## Browser matrix boundary

`npm run test:game` owns deterministic scenario actions, canonical observations, trace capture, and
Emuera comparison in Chromium. A browser/WASM acceptance also runs the installed native Firefox and
Safari through the real Vue UI, OPFS project import, and WASM worker:

```sh
npm run test:browser-compat -- --browser firefox
npm run test:browser-compat -- --browser safari
```

The native compatibility runner uses the short reference fixture and WebdriverIO. It must report the
actual browser version/UA, OPFS availability, compile completion, and reference output. Firefox runs
headless. Safari requires **Allow remote automation** and uses a separate minimized window when the
driver supports minimization. Do not use Playwright Firefox or WebKit as substitutes for the
installed applications. A missing browser, disabled Safari automation, empty output, or browser
crash is an infrastructure failure, not a skip.

## Scenario schema

Use JSON `schema_version: 1`. The format is a compatible superset of the TUI scenario format.

- `project`: Absolute path or path relative to the scenario. `--project` overrides it.
- `mode`: `fixed` or `autonomous`.
- `start.type`: `new_game`, `traditional_save`, or `vm_snapshot`; restores require `path` or CLI
  `--state`.
- `seed`: Optional non-negative signed 32-bit integer for `new_game`. If absent, the runner creates
  and records a random seed. Restored state owns its RNG and ignores `seed`.
- `clock`: Optional ISO timestamp; default `2026-01-01T00:00:00Z`.
- `compiled_cache`: Copy an existing v8 project cache into the isolated browser fixture and verify
  the browser import path; absent or false forces a cold source load.
- `clean_saves`: Omit the project's existing `sav/` directory from the isolated browser fixture so
  a `new_game` smoke test starts with fresh save storage.
- `prepare_traditional_save`: Export a valid traditional save from the stable test runtime and
  provide it as `generated.sav` to the next visible `.sav` file-picker action. This is test setup;
  the scenario must still exercise import/export through the production UI.
- `inputs`: TUI-compatible semantic input prefix. Each value is submitted through the real form.
- `actions`: Ordered Web action prefix; it is mutually exclusive with `inputs`.
- `watches`: Debug expressions such as `RESULT` or `FLAG:0,1`, sampled at stable waits.
- `goal`: AND-combined `output_contains`, `wait_kind`, `termination`, `watch_equals`,
  `line_count_lte`, and `status_contains` checks.
- `limits`: Positive `max_steps` and `timeout_seconds`.
- `comparison.reference`: Enable persistent Emuera Reference CLI schema 2 comparison.
- `comparison.ignore_output`: Explicit regular expressions removed from both output deltas.
- `comparison.wait_kind_map`: Intentional overrides to the built-in Web-to-Emuera wait map.
- `checkpoint`: Download at the first observed stable state; optional `path` is scenario-relative.

Relative paths resolve from the scenario, never from the caller's working directory.

## Web actions

An action has `type`:

- `input`: `value`; fills `.prompt-bar input` and clicks the submit button.
- `click`: `locator`; set `advances_game: true` and `semantic_input` when it advances a compared
  game.
- `hover`: `locator`; moves the pointer over an element without advancing the game.
- `fill`: `locator`, `value`.
- `press`: `locator`, `key`; set `advances_game: true` and add `semantic_input` if it advances a
  compared game.
- `query`: `locator`, optional `fields` from `count`, `text`, `html`, `value`, `visible`,
  `enabled`, `attributes`.
- `assert_dom`: same query fields plus an `expect` subset.
- `assert_state`: an `expect` subset of the serialized frontend snapshot.

Locators accept exactly one of `role` (plus optional `name`/`exact`), `label`, `text`, `test_id`, or
`css`. Prefer accessible role/name locators. A compared click/press that advances the runtime must
declare `semantic_input`; missing it is a scenario error rather than an implicit reference step.

## NDJSON and exit codes

Full events are written to `trace.ndjson`; stdout removes full output arrays and truncates large
deltas. Events include `start`, `observation`, `action`, `query`, `inspection`, `checkpoint`,
`error`, and `result`.

- Exit `0`: passed or deliberately stopped.
- Exit `1`: semantic difference, failed DOM/frontend assertion, or unmet goal.
- Exit `2`: autonomous input/step budget exhausted.
- Exit `3`: scenario, browser, WASM, filesystem, or reference infrastructure failure.

Reference comparison checks normalized output added since the prior stable wait, wait kind, and
watches. DOM and frontend-only assertions are never projected onto Emuera.
