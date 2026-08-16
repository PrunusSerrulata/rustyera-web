# Web game-test protocol

## Browser matrix boundary

`npm run test:game` owns deterministic scenario actions, canonical observations, trace capture, and
Emuera comparison in Chromium. A browser/WASM acceptance also runs installed native Firefox on
every supported host and native Safari only on macOS through the real Vue UI, OPFS project import,
and WASM worker:

```sh
npm run test:browser-compat -- --browser firefox
# macOS only
npm run test:browser-compat -- --browser safari
```

When the host OS is not macOS, do not launch or require Safari; report Safari as not applicable
rather than skipped, passed, or failed. Do not use WebKit as a substitute.

Every `npm run test:game` and native-browser command must run outside the filesystem sandbox from
its first attempt with `sandbox_permissions=require_escalated`; explain that browser automation and
local server binding are required. Do not probe them in the sandbox first. Treat a
sandbox-originated listen `EPERM`, driver startup failure, or automation timeout as an invalid
infrastructure attempt and rerun outside the sandbox before diagnosing a product failure.

From launch through exit, long scenarios must poll and emit a complete snapshot every 5 seconds
instead of making one silent wait. The snapshot must enumerate every current HTML element with its
tag, attributes, text/value, and visibility, plus phase/status/wait/presentation/output/log state.
Abort immediately on `fault` or a terminal version/protocol rejection. Compare snapshots after
removing timestamps and reporting-only metadata; if two consecutive snapshots are identical,
terminate immediately as stalled without waiting for another timeout. Preserve the reference
output and DOM/layout assertions when repairing a timeout. All task tests share one 60-minute
wall-clock budget, and each full suite may start only once.

After clicking the native compatibility runner's visible project-open button, require the portable
directory-file fallback or project-open state to become observable within 10 seconds. On failure,
report every created file input's type, multiplicity, accept filter, and directory property/attribute
instead of waiting for the overall compile timeout or leaving a native file sheet open.

The native compatibility runner uses the short reference fixture and WebdriverIO. It must report the
actual browser version/UA, OPFS availability, compile completion, and reference output. Firefox runs
headless. On macOS, Safari requires **Allow remote automation** and uses a separate minimized window
when the driver supports minimization. Do not use Playwright Firefox or WebKit as substitutes for
the installed applications. A missing required browser, disabled Safari automation on macOS, empty
output, or browser crash is an infrastructure failure, not a skip.

## Scenario schema

Use JSON `schema_version: 1`. The format is a compatible superset of the TUI scenario format.

- `project`: Absolute path or path relative to the scenario. `--project` overrides it.
- `mode`: `fixed` or `autonomous`.
- `start.type`: `new_game`, `traditional_save`, or `vm_snapshot`; restores require `path` or CLI
  `--state`.
- `seed`: Optional unsigned 64-bit integer for `new_game`. Use a decimal string above JavaScript's
  safe integer range. If absent, the runner creates and records a random seed. Restored state owns
  its RNG and ignores `seed`.
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
- `click`: `locator`, optional `button` (`left`, `middle`, or `right`, default `left`); set
  `advances_game: true` and `semantic_input` when it advances a compared game.
- `hover`: `locator`; moves the pointer over an element without advancing the game.
- `scroll_key`: `locator`, optional `key` (default `PageUp`) and `settle_ms` (default 50); focuses
  the locator and scrolls it through Playwright's real keyboard input.
- `fill`: `locator`, `value`.
- `press`: `locator`, `key`; set `advances_game: true` and add `semantic_input` if it advances a
  compared game.
- `query`: `locator`, optional `fields` from `count`, `text`, `html`, `value`, `visible`,
  `enabled`, `attributes`, `scroll_top`, `scroll_height`, `client_height`, `at_scroll_bottom`, `box`,
  `content_signature`, and `image_loaded`. `box` returns the first match's viewport rectangle;
  `content_signature` hashes all matches' `outerHTML` without storing the full DOM in the trace.
  `image_loaded` requires a decoded image with positive natural dimensions, either at the locator
  itself or its first descendant `img`.
- `assert_dom`: same query fields plus an `expect` subset.
- `sample_queries`: `count` (at least 2), `interval_ms`, named `queries` with the same locator and
  field schema, and `expect.stable`/`expect.changes` dotted paths. It records every sample and fails
  unless stable fields remain identical and changing fields have at least two distinct values. Each
  sample also includes `runtime.presentation_revision`, `runtime.history_revision`, and
  `runtime.output_count`. Use it for animations that must update content without creating history
  or moving their layout anchor.
- `assert_layout`: `locator`, optional `relative_to`, and `expect`. It measures production DOM
  boxes and accepts `count`, `visible`, `same_left_within`, `same_top_within`, `no_overlap`,
  `above`/`below` gap ranges (`min`/`max`), `inside.tolerance`, `right_aligned_within`, and
  `horizontal_centered_within`, `top_aligned_within`/`bottom_aligned_within`. Prefer these relative
  checks over hard-coded viewport coordinates.
- `assert_canvas_pixels`: `locator` plus an `expect` subset such as `count`, `width`, `height`, or
  `nontransparent_at_least`. Use it to prove that a generated canvas contains rendered pixels, not
  merely that an empty canvas element has layout dimensions.
- `query_media_replay`: `resource_name`. Returns the test-only, read-only sprite and canvas replay
  graph for diagnosing a generated image without mutating Pinia or runtime state.
- `advance_intermediate_waits_until`: advances a variable number of visible integer, Enter,
  Enter-compatible one-input, and deadline waits until `until.media_sources_at_least` distinct
  presentation image sources exist. Use `integer_value` (default `0`) for repeated route/encounter
  choices; never encode a save-dependent number of intermediate prompts as repeated actions.
- `advance_enter_waits_until`: advances visible Enter and Enter-compatible one-input waits until
  `until.output_tail_contains` appears in the latest `until.tail_lines` (default 30) and/or
  `until.locator` is visible. When both are present, both must match; use that form to avoid stopping
  on an intermediate fade frame whose canonical text is already present. Set `auto_enter: false` on
  the preceding action and this action when layout must be inspected at the matched screen instead
  of after the runner's normal automatic Enter handling. When the action must click Enter internally
  but stop automatic Enter handling after reaching its target, set `settle_auto_enter: false` instead.
  Deadline waits are observed until the runtime advances them; the runner must not click through
  them.
- `assert_state`: an `expect` subset of the serialized frontend snapshot.
- `edit_project_source`: test setup for a hot-reload scenario; requires `relative_path`, `expected`,
  and `replacement`, and replaces exactly one fragment inside the isolated project.
- `reload_project`: invokes the production Browser/WASM reload path with `scope` (`all`, `folder`,
  or `script`) and an optional project-relative `path`, then waits for the accepted runtime epoch.
  Set `expect_success: false` only when testing rollback after a deliberately invalid reload; the
  runner then requires the runtime epoch to remain unchanged and the frontend to restore interaction.
- `export_diagnosis`: invokes the production diagnosis-export lifecycle and waits for its download.
- `assert_diagnosis_project_manifest`: hashes each declared UTF-8 `sources` value and compares it
  with the manifest decoded from the exported `.reraproj` by the real WASM worker.
- `wait_compiled_cache_saved`: waits until the production cache export has completed.

For cross-host cache handoff, set `RUSTYERA_TEST_COMPILED_CACHE_INPUT` and
`RUSTYERA_TEST_COMPILED_CACHE_OUTPUT` to explicit opaque cache paths. The runner installs/exports
`.rustyera/cache/compiled-project.reracache`. Set `RUSTYERA_TEST_SOURCE_INDEX_INPUT` and
`RUSTYERA_TEST_SOURCE_INDEX_OUTPUT` to transfer the matching portable source index and require the
consumer to report actual file reuse. `RUSTYERA_TEST_PROJECT_OUTPUT` may export the isolated source
tree, excluding `.rustyera`, for a following TUI run.

Set `allow_fault: true` on an action only when the scenario intentionally enters or operates on
the fatal-error UI. The runner otherwise stops at the first runtime fault.

Locators accept exactly one of `role` (plus optional `name`/`exact`), `label`, `text`, `test_id`, or
`css`, plus optional zero-based `nth` (`-1` selects the last match). Prefer accessible role/name
locators. A compared click/press that advances the runtime must declare `semantic_input`; missing
it is a scenario error rather than an implicit reference step.

## NDJSON and exit codes

Full events are written to `trace.ndjson`; stdout removes full output arrays and truncates large
deltas. Events include `start`, `observation`, `action`, `query`, `inspection`, `checkpoint`,
`error`, and `result`.

The mandatory 5-second progress event is not truncated: it contains the full HTML-element snapshot
and complete observable state needed for exact comparison and failure reporting.

- Exit `0`: passed or deliberately stopped.
- Exit `1`: semantic difference, failed DOM/frontend assertion, or unmet goal.
- Exit `2`: autonomous input/step budget exhausted.
- Exit `3`: scenario, browser, WASM, filesystem, or reference infrastructure failure.

Reference comparison checks normalized output added since the prior stable wait, wait kind, and
watches. DOM and frontend-only assertions are never projected onto Emuera.
