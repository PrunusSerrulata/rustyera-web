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

Pass `--project-file PATH --startup-only` to either native-browser command when validating a real
packaged-project cache path rather than the default portable directory fixture.

Use `--full-project-export` with a source directory to export through the visible file menu,
check the streamed download header and length, and require restored interaction. The observer
reads only the header; it does not materialize a second complete project byte array.

For acceptance requiring native driver input, use `--native-driver-inputs` with a startup,
output-marker, or audio flow. It uses WebDriver clicks and file upload, retaining the production
file input and handler while suppressing the OS sheet. It never injects a FileList or change
event. Unsupported driver uploads fail explicitly; do not fall back to computer use or injected
files. `--traditional-state PATH` configures an ordinary save restore before the visible project
open action; `--expect-watches PATH` compares a JSON watch/value object through read-only debug
inspection after startup.

For the actual TW round trip, use `--snake-interop --expect-watches PATH` instead of
`--traditional-state`: it initializes the normal title and SQL connections, then clicks Continue,
slot 1000 and its load confirmation before comparing typed state and project storage traffic.
Typed values come from public variable descriptors and `read_variable` replies, including exact
Integer/String values and character addresses. Enumeration follows returned cursors only; the
independent five-second complete-state watchdog remains active during large symbol walks.
Project packages contain program/resources, not writable saves. For packaged interop runs, the
runner prepares both reference files in the fresh browser's real OPFS `sav` directory under the
package's BLAKE3 storage key before opening the project. It verifies SHA-256 against the fixture
manifest and reads the written bytes back, refuses existing project storage, and records this as
fixture preparation. Subsequent GLOBAL/slot reads still execute through the production host.
The WebDriver-only native host records storage request/response pairs in its isolated project.
Those operations finish inside Rust before reaching Vue; their native process/project context is
kept separate from frontend wire epochs. Bulk bytes are represented by length and BLAKE3 digest.

Audio acceptance can combine `--snake-audio` with an actual `--project-file` export when a native
driver cannot upload directories; retain `--project` to identify its source fixture. File upload
must still go through that browser's native WebDriver input, followed by every audio assertion.

When explicitly testing without foreground focus, `--background-dom` drives rendered, enabled
controls through their DOM handlers and records focus, visibility and untrusted-event evidence.
It does not establish native input coverage. Safari packaged-project imports use the isolated
file-picker adapter. `--webdriver-open` probes only the opening button with SafariDriver input.
For locked-session media semantics, Safari supports the opt-in `--safari-allow-autoplay` flag,
which supplies the documented `webkit:alwaysAllowAutoplay` capability to that automation session.
It changes no persistent user preferences. Report this mode separately: playback observations
remain real, but default-policy autoplay and trusted-gesture unlock are not verified by it.

For a deliberate compile rejection, a Chromium scenario may set
`expect_project_load_failure` to the exact protocol diagnostic code (for example
`compiler.invalidhir`). It must omit gameplay actions and reference comparison. The runner checks
the received failed `project_load_report`, settled loading state, bounded notifications and a
visible, enabled project-open menu. Tauri uses `tests/tauri/project-load-failure.spec.mjs` for the
same invalid-HIR path. The ordinary five-second complete-snapshot watchdog remains active.

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
terminate immediately as stalled without waiting for another timeout, except during the Android
Firefox native provider-copy handoff defined in the skill. In that interval, keep the 5-second
record with the last complete DOM plus Android hierarchy/process/RDP state and wait for Firefox to
surface its upload confirmation or `FileList`; resume ordinary identical-snapshot failure as soon
as it does. Preserve the reference output and DOM/layout assertions when repairing a timeout. All tests
in the current batch share one 60-minute wall-clock budget, and each full suite may start only once
per batch. Use the root rules to combine small items and give large items independent batches.
For iterative work, these limits apply to the current batch in one iteration, not the whole task.
A single iteration timeout does not end further iterations before the user's goal/deadline. Reserve
wrap-up time and retain test procedures, scripts, fixtures, temporary projects, and restart evidence
on pause; cleanup requires the user's explicit task-completed/aborted instruction. Follow the skill
for continuation, deadline handling, and resumption budgets.

The snapshot cadence is independent from action pacing. Poll actionable browser state at roughly
100 ms and native Android hierarchy continuously (no extra delay after a completed dump, at most
250 ms when a small debounce is necessary). Act as soon as the exact expected control appears;
never insert a 5-second sleep between folder navigation, selection, confirmation, permission, and
page-load transitions.

When the user explicitly authorizes the temporary loading allowance, set
`RUSTYERA_TEST_LOADING_STALL_INTERVALS=4` for that run. Only `projectLoading=true` without
an active wait, interactive state or export may accumulate four unchanged five-second intervals
before failing. Actual progress resets the count. All captures still have a five-second deadline;
faults and protocol rejections still fail immediately. After loading, the first unchanged interval
fails again. This override does not resolve or waive the underlying loading performance problem.

After clicking the native compatibility runner's visible project-open button, require the portable
directory-file fallback or project-open state to become observable within 10 seconds. On failure,
report every created file input's type, multiplicity, accept filter, and directory property/attribute
instead of waiting for the overall compile timeout or leaving a native file sheet open. For Android
Firefox only, pause this 10-second clock during the identified post-DocumentsUI, pre-`FileList`
native provider-copy interval and record its duration separately.

The native compatibility runner uses the short reference fixture and WebdriverIO. It must report the
actual browser version/UA, OPFS availability, compile completion, and reference output. Firefox runs
headless. On macOS, Safari requires **Allow remote automation** and uses a separate minimized window
when the driver supports minimization. Do not use Playwright Firefox or WebKit as substitutes for
the installed applications. A missing required browser, disabled Safari automation on macOS, empty
output, or browser crash is an infrastructure failure, not a skip.

## Scenario schema

Use JSON `schema_version: 1`. The format is a compatible superset of the TUI scenario format.

- `project`: Absolute path or path relative to the scenario. `--project` overrides it.
- `project_file`: Optional `.reraproj` path relative to the scenario. Chromium opens it through the
  visible project-file picker while `project` remains the isolated support tree for test services.
- `summary_observations`: Optional boolean for large-project scenarios. It retains runtime,
  presentation and diagnostics in action observations without materializing the complete wire
  ledger. Use explicit typed/storage assertions for protocol evidence. Complete DOM/runtime
  watchdog snapshots and their five-second failure rule are unchanged. Action settling ignores
  the internal cooperative pump counter; actual wait, output, fault and other state changes still
  reset its stable-frame count.
- `mode`: `fixed` or `autonomous`.
- `start.type`: `new_game`, `traditional_save`, or `vm_snapshot`; restores require `path` or CLI
  `--state`.
- `seed`: Optional unsigned 64-bit integer for `new_game`. Use a decimal string above JavaScript's
  safe integer range. If absent, the runner creates and records a random seed. A VM snapshot owns
  its RNG and ignores `seed`; a standard snake traditional save preserves the runtime's current
  SFMT state and does not restore SQL state or the other variable scope.
- `clock`: Optional ISO timestamp; default `2026-01-01T00:00:00Z`.
- `compiled_cache`: Copy an existing v8 project cache into the isolated browser fixture and verify
  the browser import path; absent or false forces a cold source load.
- `has_touch`: Optional boolean passed to Chromium's real browser context. Use it only for UI that
  depends on the host advertising touch input; it does not emulate a mobile user agent.
- `clean_saves`: Omit the project's existing `sav/` directory from the isolated browser fixture so
  a `new_game` smoke test starts with fresh save storage.
- `prepare_traditional_save`: Export a valid traditional save from the stable test runtime and
  provide it as `generated.sav` to the next visible `.sav` file-picker action. This is test setup;
  the scenario must still exercise import/export through the production UI.
- `prepare_in_game_save`: In the isolated short reference fixture only, make `SYSTEM_TITLE` invoke
  `SAVEGAME` and provide `SAVEINFO`, so visible slot actions exercise production storage writes.
- `prepare_interaction_assist`: In the isolated short reference fixture only, expose a stable
  `ASSISTED_ACTION` text button before its input wait so interaction-assistance UI can activate a
  real runtime token.
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
  Set `force: true` only after separately asserting or revealing a virtualized target whose
  Playwright actionability wait is not part of the behavior under test.
  Set `dom_click: true` only for an already revealed, unique virtualized button when native DOM
  activation is required without pointer hit-testing.
  Set `expect_atomic_presentation: true` for a screen transition that must paint only its starting
  and next stable presentation revisions, never a runtime-running intermediate revision.
- `touch_gesture`: Chromium-only real touch input with `locator` and `gesture` set to
  `two_finger_tap` or `long_press`; set `advances_game: true` when it advances the runtime.
- `hover`: `locator`; moves the pointer over an element without advancing the game.
- `scroll_key`: `locator`, optional `key` (default `PageUp`) and `settle_ms` (default 50); focuses
  the locator and scrolls it through Playwright's real keyboard input.
- `fill`: `locator`, `value`.
- `set_viewport`: positive integer `width` and `height`; resizes Chromium's layout viewport so
  responsive production behavior can be checked without overriding media-query state.
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
  `horizontal_centered_within`, `vertical_centered_within`, and
  `top_aligned_within`/`bottom_aligned_within`. Prefer these relative checks over hard-coded viewport
  coordinates.
  `left_aligned_within` is also available for controls that must share a leading edge with their
  label or container.
- `assert_canvas_pixels`: `locator` plus an `expect` subset such as `count`, `width`, `height`, or
  `nontransparent_at_least`. Use it to prove that a generated canvas contains rendered pixels, not
  merely that an empty canvas element has layout dimensions.
- `query_media_replay`: `resource_name`, optional `expect` subset. Returns the test-only, read-only
  sprite and canvas replay graph for diagnosing a generated image without mutating Pinia or runtime
  state.
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
- `assert_interop`: compare a nonempty `expect` map of `{type: "integer" | "string", value: "..."}` through `inspectTyped`, including character watches such as `NO@0`. Requires an absolute, unused `evidence_path`; raw typed and storage observations are saved before assertions. It checks successful project GLOBAL reads and rejects private save fallback. A lifecycle file import does not establish a production ordinary-slot read.
- `edit_project_source`: test setup for a hot-reload scenario; requires `relative_path`, `expected`,
  and `replacement`, and replaces exactly one fragment inside the isolated project.
- `reload_project`: invokes the production Browser/WASM reload path with `scope` (`all`, `folder`,
  or `script`) and an optional project-relative `path`, then waits for the accepted runtime epoch.
  Set `expect_success: false` only when testing rollback after a deliberately invalid reload; the
  runner then requires the runtime epoch to remain unchanged and the frontend to restore interaction.
- `export_diagnosis`: invokes the production diagnosis-export lifecycle and waits for its download.
- `save_download`: arms a native Playwright download event, then clicks the visible export control
  at `selector` and saves the actual bytes to an unused absolute `path`. Requires its filename to
  end in `name_suffix`. Use to retain a streamed artifact for another native client.
- `cancel_project_export`: clicks the export control at `selector`, waits for at least 8 MiB of
  actual manifest submissions, then clicks the visible cancellation button. Requires an unused
  absolute `evidence_path`; records memory, transfer state and cancellation protocol evidence.
  Use a project whose full manifest exceeds 8 MiB, followed by `save_download` to prove retry.
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

To use a previously installed Chromium without downloading a browser, add
`--chromium-executable /absolute/path/to/chromium` to `npm run test:game -- run ...`
(or `serve`). The default browser selection is unchanged when the option is absent.

### Explicit background DOM acceptance

When the task authorizes DOM-driven background coverage, `test:browser-compat` accepts
`--background-dom` for startup/output/audio flows. `test:tauri` accepts it for the compiler-error,
snake interop, and audio specs. This mode skips foreground/window restoration and invokes real
rendered, enabled DOM controls through the existing WebDriver script channel. The ordinary mode
keeps native input. The modes are exclusive; neither grants computer-use permissions.

Background evidence records document focus/visibility, script activation, and untrusted DOM input.
Keep runtime results, provider errors, storage effects, and the five-second watchdog authoritative.
Verify OS lock status separately before claiming locked-session coverage. Successful DOM input does
not cover native pointer/key delivery, IME, system file sheets, or real user-gesture audio unlock.
Do not patch visibility, animation frames, activation, Pinia state, or runtime results.

For bounded protocol diagnosis, `test:game` accepts `--protocol-types TYPE,TYPE`. The watchdog reads
only those immutable wire records, filtering before parsing large unrelated payloads. Raw records
retain their original indices and the selection is explicit in the evidence.
