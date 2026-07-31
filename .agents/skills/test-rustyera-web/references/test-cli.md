# Web game-test protocol

## Browser matrix boundary

`npm run test:game` owns deterministic scenario actions, canonical observations, trace capture, and
Emuera comparison in Chromium. A browser/WASM acceptance also runs the installed native Firefox and
Safari through the real Vue UI, OPFS project import, and WASM worker:

```sh
npm run test:browser-compat -- --browser firefox
npm run test:browser-compat -- --browser safari
```

Both native-browser commands must run outside the filesystem sandbox from their first attempt with
`sandbox_permissions=require_escalated`; explain that installed-browser automation and local server
binding are required. Do not probe them in the sandbox first. Treat a sandbox-originated listen
`EPERM`, driver startup failure, or automation timeout as an invalid infrastructure attempt and
rerun outside the sandbox before diagnosing a product failure.

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
- `prepare_in_game_save`: In the isolated short reference fixture only, make `SYSTEM_TITLE` invoke
  `SAVEGAME` and provide `SAVEINFO`, so visible slot actions exercise production storage writes.
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
- `assert_layout`: `locator`, optional `relative_to`, and `expect`. It measures production DOM
  boxes and accepts `count`, `visible`, `same_left_within`, `same_top_within`, `no_overlap`,
  `above`/`below` gap ranges (`min`/`max`), `inside.tolerance`, `right_aligned_within`, and
  `top_aligned_within`/`bottom_aligned_within`. Prefer these relative checks over hard-coded
  viewport coordinates.
- `assert_canvas_pixels`: `locator` plus an `expect` subset such as `count`, `width`, `height`, or
  `nontransparent_at_least`. Use it to prove that a generated canvas contains rendered pixels, not
  merely that an empty canvas element has layout dimensions.
- `query_media_replay`: `resource_name`. Returns the test-only, read-only sprite and canvas replay
  graph for diagnosing a generated image without mutating Pinia or runtime state.
- `advance_enter_waits_until`: advances visible Enter and Enter-compatible one-input waits until
  `until.output_tail_contains` appears in the latest `until.tail_lines` (default 30) and/or
  `until.locator` is visible. When both are present, both must match; use that form to avoid stopping
  on an intermediate fade frame whose canonical text is already present. Set `auto_enter: false` on
  the preceding action and this action when layout must be inspected at the matched screen instead
  of after the runner's normal automatic Enter handling. Deadline waits are observed until the
  runtime advances them; the runner must not click through them.
- `assert_state`: an `expect` subset of the serialized frontend snapshot.

Locators accept exactly one of `role` (plus optional `name`/`exact`), `label`, `text`, `test_id`, or
`css`, plus optional zero-based `nth` (`-1` selects the last match). Prefer accessible role/name
locators. A compared click/press that advances the runtime must declare `semantic_input`; missing
it is a scenario error rather than an implicit reference step.

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
