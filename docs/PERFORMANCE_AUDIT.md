# Tauri loading and runtime performance audit

The test-only Tauri performance audit is the single authoritative performance probe in this
repository for both project loading and steady runtime. It is compiled only with the
`performance-audit` Cargo feature and
`VITE_RUSTYERA_PERF_AUDIT=1`; normal Tauri and Web builds do not create telemetry buffers or run
the audit timing branches.

The audit defaults to a normal visible, focusable Tauri window and ordinary WebDriver element
operations. For an invisible run, use `--window-mode minimized`: this is the sole background path.
The outer capture and measurement runners add `--background-dom` for minimized children. After the
WebDriver minimize command completes, testing starts directly without minimized-state, focus or
foreground-owner verification. Background input uses the real Tauri WebView's DOM
handlers and does not require native input or an unlocked desktop.

The former `rorona-settlement-performance.spec.mjs` probe and its
`rustyera:settlement-*` performance marks were removed. They duplicated part of the native-to-paint
timing chain and cannot be used by the unified audit policy.

The former standalone `scripts/startup-benchmark.mjs` implementation and its private aggregation
schema were also removed. `benchmark:startup` is now only an alias for the same unified Tauri
runner, so it requires the same frozen trace, isolated project, explicit window policy and evidence
directory. The unified JSONL sample schema always includes `schemaVersion`, `epoch`,
`sequence`, `origin`, `segment`, `phase`, `operation` and timing fields. `segment` is `loading` or
`runtime`; both are emitted by the same run and retained in the same evidence stream.

## Compatibility state and non-performance counters

- `startupTelemetry` remains a compatibility projection for loading progress and cache assertions.
  Its bridge, Core-stage and lifecycle updates delegate audit samples into the unified `loading`
  phase; it does not own an audit buffer, epoch, sequence or benchmark report schema.
- Native memory snapshots and the resource memory counters are product diagnostics used by
  diagnosis/state reporting. They are observations, not latency probes or benchmark clocks.
- Animation, audio and canvas clocks are functional scheduling state. They must not be interpreted
  as performance samples.

## Frozen trace workflow

The checked-in `tests/fixtures/snake-runtime-performance-trace.v3.json` is intentionally marked
`captureRequired: true`. It is a schema/template, not fabricated evidence. A future autonomous
play session must record the real snake TW path, then freeze a versioned trace with:

- the exact `emuera.skia.snake` project identity, seed and clock;
- all four paths: loading/title-to-day-1, daily/long-output runtime, map hover/click/NF/scene/
  canvas/sprite/SQL, and ordinary save/load/stable return;
- each action's real `wait_id`, generation and wait kind;
- non-empty key-variable watches; and
- a SHA-256 checkpoint over output, scene, resources, variables and canonical service/storage
  summaries (volatile session/message/correlation identifiers are removed).

The replayer refuses a capture-required trace, missing coverage evidence, empty watches or a
missing/mismatched checkpoint hash. This prevents path labels or an inferred input list from being
reported as measured coverage.

Capture is driven by `audit:tauri-performance-capture -- capture`: the primary agent selects each
action from the emitted observation and provides complete commands to append its JSONL `action`
record to the isolated inbox. The test subagent only executes these commands and collects results;
it never infers parameters, timeouts, paths, or recovery steps. Only when the user explicitly requests
autonomous play and the primary confirms its prerequisites may the subagent choose in-game actions
through the supplied interface; all other execution decisions remain with the primary. The same
Tauri lifecycle executes each input/click/hover and atomically updates a candidate; manual editing
is not a capture path. Visible runs use ordinary WebDriver element operations. The minimized WebView uses DOM handlers without claiming trusted native
input. DOM clicks must include their `semanticInput`; `button: "right"` records the real
message-skip gesture through the background DOM handlers. After review,
`audit:tauri-performance-capture -- freeze` requires distinct `--output` and `--core-output` paths.
It writes the frozen Tauri trace plus a deterministic Core `perf-run` companion derived from that
one capture artifact. The Tauri trace schema and Core trace schema are independently versioned;
they share the scenario, Core-compatible project digest, seed, semantic protocol actions and
checkpoint signatures, not a coincidentally equal schema number. The template contains only null Core
identity placeholders. Capture exports the exact `era-web-bridge::client_hello`
features/capabilities for that native session—including negotiated fonts/audio—and combines them
with the actual pre-start frontend setup messages under a hashed capture identity. Freeze rejects
placeholders or a client missing the rich-text, HTML, graphics, mouse and storage capabilities
required by this workload. Capture hashes full normalized Core checkpoints and stores only compact
expectations plus the signature. Every non-hover Web action must
map to the exact captured `input`, `service_response` or `storage_response` protocol actions; freeze
rejects a click or service sequence that cannot be mapped losslessly. Hover-only steps remain
frontend-only. The emitted companion contains only fields accepted by Core's strict serde schema.
Selector lookup, exact-label/enabled assertions, and prompt preparation complete before the action
clock starts; their costs remain in the harness wall clock. Action latency starts immediately before the real WebDriver/DOM action and stops after the target
change reaches the client's existing consecutive-stable-frame observation boundary. The full
post-action checkpoint is captured after that boundary for semantic verification, so debug
inspection and checkpoint serialization do not inflate the reported response time. Capture
observations use the same boundary as frozen replay. `summary.byPath` aggregates these response
samples; `summary.harnessByPath` separately reports the path wall clock including checkpoint and
callback overhead. The stability signature excludes the performance observer counters and live
memory counters that sampling itself changes. Performance-audit builds also use a separately bounded 256 MiB/262,144-record
protocol ledger so long service-heavy traces remain lossless; ordinary test builds retain the
64 MiB/8,192-record limits. Checkpoints read that ledger through a monotonic cursor instead of
cloning the cumulative history. In performance builds, incoming presentation snapshots and deltas
retain only their envelope metadata and message type in the protocol ledger: checkpoint projection
uses those tags and separately observes the authoritative presentation after timing. Their payloads
are not traversed or serialized again by that ledger. Ordinary E2E evidence remains complete;
service/storage/debug/setup records and explicit runtime exports keep their existing behavior.
Repeated service/storage results are stored once in a
content-addressed `protocolResults` table and actions retain only the SHA-256 reference. Candidate
and frozen trace writers use compact JSON and reject files above 256 MiB; the unique result table
has its own 64 MiB/65,536-entry limit, so growth fails before a multi-gigabyte artifact is written.

Performance runs persist lightweight progress observations every five seconds; the sixth unchanged
interval fails, giving a 30-second watchdog. The observation reads authoritative runtime/wait,
presentation/history/scene revisions, fault and bounded log/transfer state. It does not enumerate DOM,
read geometry, flatten output, traverse resources/debug values, compute memory statistics, or copy
protocol records. The same lightweight observer drives action and stable-frame polling. Full output,
variables, scene/resources and protocol deltas remain verified by the pre/post checkpoints outside
the action clock. Ordinary Tauri E2E keeps its complete five-second snapshot and first-unchanged
failure policy; this performance measurement exception does not weaken ordinary E2E coverage.

For explicitly requested heavy diagnosis, set `RUSTYERA_TAURI_PERF_HEAVY_DIAGNOSTICS=1`. This restores
complete periodic DOM/runtime snapshots in the performance run, with the same 30-second bounds.
The runner emits `tauri-performance-observer-policy` with `absoluteTimingAllowed: false`; these
samples are diagnostic evidence, never a production latency baseline. Do not estimate and subtract
snapshot/profiler costs from a contaminated sample. Performance sessions use WebDriver error-level
logging; canonical capture observations, semantic checkpoints and telemetry samples still persist.
The lightweight mode reports `absoluteTimingAllowed: null` and `probeOverheadValidated: false`
until the independent matched-input overhead comparison has been reviewed; choosing the lightweight
path alone is not proof of negligible instrumentation cost.

Both capture and frozen replay give requests and debug-backed checkpoint commands the same bounded
30-second WebDriver window. The runner selects this and the lightweight watchdog explicitly from
`perfAudit.enabled`, not the capture environment variable. Ordinary native commands retain five
seconds and complete snapshots, even when capture environment variables are present.

The audit pump never awaits an extra Vue flush. It schedules at most one pending flush observer,
only after a presentation publication; ordinary SQL-only batches add no flush observer. Paint
observers are coalesced, and both their timer and outstanding animation callback are cancelled when
they finish or time out. `dom_flush/coalesced_vue_next_tick` describes an observed flush, not a
per-batch paint. Native timing records remain bounded O(1) inserts; snapshot export is outside action
timing. The checkpoint implementation normalizes each tree once and hashes the canonical result
without repeated whole-tree clones/sorts. Typed watch descriptors may be cached for the same program,
but values are always read at the current stop. Do not reuse a preceding post-checkpoint as the next
pre-checkpoint without proving that no runtime/storage/background state could change between them.

Consecutive stable-frame verification still takes multiple observation frames (with the existing
16 ms fallback when the WebView suppresses animation callbacks). This is a declared endpoint cost,
not VM compute time or a measured paint in a suppressed WebView. `checkpoint_change` actions still
require debug-backed change verification and are suitable for semantic coverage/hotspot diagnosis,
not an uncontaminated action-latency claim. Keep them separate from `wait_change` latency targets.

## Capture timing evidence without replaying full buffers

For authorized function-frequency diagnosis, set `RUSTYERA_TAURI_PERF_VM_SAMPLE=1` on the
official build and capture commands. This selects the separate `vm-instruction-profile` Cargo
feature; ordinary production and timing builds contain no dispatch sampling branch or counters.
Capture is labelled `acceptanceTiming: false`. Every 1,024 physical VM dispatches records the
current generation/function in a per-VM map capped at 4,096 keys. This is periodic frequency
sampling, not CPU time: short/periodic paths can be underrepresented and bulk/memo logical
instructions are not expanded. Dropped keys appear in `droppedSamples`; counter or identity
exhaustion sets `incomplete` (identity exhaustion uses reserved instance `0` without reuse).
VM replacement/fork starts a new instance identity; counters are not persisted.
Before and after actions, outside their clocks, the audit reads cumulative counters and resolves
at most 128 hot names (64 Unicode scalars each). It writes `<candidate>.vm-profile.jsonl` using
exclusive creation, bounded scalar WebDriver transport, 1 MiB per record, 16 MiB per file and
64 boundaries. No DOM, variable values, per-instruction trace, or source contents are collected.
Compare before/after only for matching VM instances and generations; keep this evidence separate
from the unprofiled latency baseline and verify the same semantic checkpoints.

For a separately labelled native CPU diagnostic, `RUSTYERA_TAURI_PERF_CPU_SAMPLE` may name a fresh
absolute output file. The fixed capture samples the runner-owned Tauri PID for ten seconds before
action six, using the installed macOS `sample` executable. A 16 MiB process file-size limit bounds
writes, and the helper validates the final nonempty file and actual exit status. Its 30-second
timeout terminates only that sampler. Capture failure remains the primary error if sampler cleanup
or result logging also fails. These observations and timing boundaries carry
`acceptanceTiming: false` and `timingBasis: "diagnostic-only"`; they are excluded from acceptance
aggregation. Bounded post-action presentation inventory counts metadata, never image byte payloads,
under one shared 100,000-entry traversal cap. Neither diagnostic runs in ordinary capture.

Native pump samples additionally distinguish `nativeSetupMs` (the initial interval containing
host lock acquisition and, on fused input, message submission) and `nativeThreadCpuMs`. The latter
uses two safe in-process thread-clock reads on macOS/Linux and is `null` elsewhere; there are no
subprocesses, memory/DOM snapshots, allocations or changes to scheduling policy in that path.
It excludes time descheduled or blocked and work performed on the separate SQL owner thread.
Therefore wall time minus thread CPU is not exclusively lock contention or scheduler delay.
The CPU endpoint is read just after the wall endpoint; tiny samples need not satisfy CPU <= wall.
Both fields overlap `nativeDriveMs`, not additional latency. Old captures without these fields
remain readable: unavailable counters have zero samples, never fabricated zero-duration values.
These counters do not measure total probe overhead; that remains explicitly unmeasured.

Capture writes a fresh directory beside its candidate: `<candidate-path>.timings/`. The existing
frontend ring and native `PerformanceAuditTelemetry` expose bounded destructive reads; each call
moves at most 512 timing records per origin and 512 long-task records, leaving epoch, next-sequence
and cumulative dropped counters unchanged. No independent sampler or telemetry authority is added.
The native accessor is `performance_audit_take`; the test control is `takePerformanceAudit`.

Large checkpoints, audit pages and replay byte pages cross WebDriver as a single JSON string,
encoded inside the WebView and parsed with byte bounds in Node. This avoids macOS WebDriver's
recursive conversion of the complete object graph into Foundation objects. Undefined properties
remain explicit `null`, matching the previous object transport; u64 strings, schema checks,
sequence checks and raw evidence are unchanged. No conversion is added to the timed action.
Performance sessions set `WDIO_LOG_LEVEL=error` before importing the standalone service: that
service does not forward its `logLevel` option to `remote()`. Otherwise WebDriver logs and retains
entire returned strings, duplicating potentially large checkpoints. Ordinary sessions are unchanged.

The opt-in native SQL route retains typed completion evidence during runtime submission, without
serializing its JSON representation in the action. Checkpoint collection encodes and drains the
bounded native ledger outside the action clock using versioned CBOR and hex pages. Native evidence
pages are limited to 512 KiB and cumulative retained evidence to 64 MiB; failure is sticky and
cannot undo an already submitted runtime response. Large replay byte arrays use bounded byte
references across WebDriver and are reconstructed and digest-checked in Node. Raw records retain
their identities and transport route; only the separate semantic comparison removes transport
metadata. These paths do not enlarge the timing directory or trace limits below.

Collection occurs only at startup, immediately before the action clock (after preparation), after
the action clock stops and before the post-checkpoint, and at the final tail. There is no periodic
sample export in the watchdog. Finalization first waits outside the action clock for the flush/paint
observers already scheduled at entry, including a flush's paint child, not ongoing background pumps.
Observation timeout/rejection makes evidence incomplete; the final drain still preserves available
samples. Each collection has a 30-second bound covering reads, raw/summary/index writes and success
marking, and at most 128 pages. Expiry forbids another destructive read or a successful result;
already started writes remain observed and their files are retained. Failure-manifest errors cannot
replace the original failure. Each
raw/summary file is limited to 1 MiB, the whole timing evidence directory to 64 MiB, and raw pages
to 2,048. A fresh directory and exclusive page writes prevent accidental overwrite. Samples from
completed earlier actions are already on disk when the next action runs; pages never repeat the
previous 20,000-element array. A single action can still exceed the existing ring capacity: that
produces explicit dropped/gap failure, not a falsely complete report or silently enlarged buffer.

Files and exact fields:

- `manifest.json`: `status` (`open`, `complete`, `failed`), `streams.{frontend,native,longTasks}`
  with `epoch`, consumed `next`, cumulative `dropped`; source identity, limits and
  `probeOverhead: "unmeasured"`.
- `index.jsonl`: each boundary's summary filename, byte count, SHA-256 and completeness flag.
- `NNNN.page-NNN.json`: exact `raw.frontend.timings[]` (`epoch`, `sequence`, `phase`, `operation`,
  `startedAtMs`, `elapsedMs`, optional `detail`), `raw.frontend.longTasks[]` (own epoch/sequence,
  start/duration), and `raw.native.pumps[]` (`epoch`, `sequence`, `operation`, `requestDecodeMs`,
  `nativeDriveMs`, `jsonSerializeMs`, `responseBytes`, `events`, `vmInstructions`,
  `runtimeTransitions`). Each origin retains next-sequence, remaining-record and dropped counters.
  `raw.frontend.observedAtMs` uses the existing frontend audit clock; it is not synchronized with
  Node or a native wall clock. The initial page retains actual ClientHello/setup identity.
- `NNNN.summary.json`: `boundary` names startup/setup/action/final plus command/sourceWebStep/path
  when applicable; action boundaries carry the existing `inputElapsedMs` and `timingBasis`.
  `frontendStages[].durationMs` and each `nativeStages[]` metric contain `count`, `total`, `minimum`,
  `maximum`; long-task durations are separate. `rawPages` holds file hashes. `streamStart`,
  `streamEnd`, `issues` and `complete` make loss/reset/gaps explicit.

Raw pages are written before identity/gap validation. A transfer, write, counter or sequence failure
marks the manifest failed and stops capture; no destructive read is silently retried. Existing pages
are preserved. The origins are not an atomic cross-host snapshot: asynchronous completions and
delayed paint callbacks can arrive in a later segment. Segments describe record arrival between
drains, not proof that every sample began inside that action. Frontend `invoke` includes native
execution/serialization and transport; do not sum these overlapping layers or add long-task time
as a separate wall-clock component. No synthetic transport samples are inserted into the authority's
sequence stream. Instrumentation overhead remains unmeasured until a matched-input comparison;
these files improve attribution, not certify a production latency.

Frontend and native epochs are independent. `originEpochs` records their initial pair; each origin
must then retain its own epoch and contiguous sequence without drop changes. Long tasks have their
own sequence within the frontend epoch. Replay summaries report `timingSamplesDropped` and
`longTasksDropped` from the frontend authority and mark any nonzero loss incomplete.

```text
npm run audit:tauri-performance-capture -- capture --project /absolute/snake-tw \
  --project-copy /absolute/evidence/project-copy/snake-tw \
  --template tests/fixtures/snake-runtime-performance-trace.v3.json \
  --candidate /absolute/evidence/candidate.json --actions /absolute/evidence/actions.jsonl \
  --window-mode minimized

npm run audit:tauri-performance-capture -- freeze \
  --candidate /absolute/evidence/candidate.json \
  --output /absolute/evidence/trace.v3.json \
  --core-output /absolute/evidence/core-trace.v2.json
```

Each inbox line is `{"type":"action","path":"…","action":{…},"watches":[…],
"evidence":{…},"coreSteps":[…]}`, a post-observation
`{"type":"core_steps","sourceWebStep":0,"coreSteps":[…]}`, or `{"type":"finish"}`. Supported actions are input, DOM click (with
`selector`, exact `expectedText`, and `semanticInput`) and DOM hover. The capture process emits the
canonical post-action observation and its resolved protocol-action delta before accepting the next
choice. Each `coreSteps` entry carries an exact Core action plus the corresponding full
`normalizedState`; capture immediately derives `phase`, wait kind, service/storage expectations,
variables and `stateSignature`, then discards the large state body. Web checkpoints likewise retain
only their SHA-256 signature. This avoids duplicating immutable resource replay in every step while
preserving exact replay verification. Candidate editing is not an accepted substitute for capture.
Because the large body is discarded after hashing, candidate validation checks the compact schema;
the frozen digest prevents later edits and replay recomputes the full live checkpoint signature.

After capture is reviewed and frozen, use the isolated outer runner:

```text
npm run audit:tauri-performance -- --project /absolute/snake-tw-copy-source \
  --project-copy /absolute/evidence/project-copy/snake-tw \
  --trace /absolute/frozen-trace.v3.json --output /absolute/empty-evidence-directory \
  --window-mode minimized
```

The capture and runner create `--project-copy` at most once, write a source/digest marker into it,
and require every later Tauri child to reuse that exact directory. A missing or changed marker is
an error rather than permission to copy the game again. The runner validates the snake profile,
source/copy realpaths and the same project digest framing
used by Core `perf-run` (submitted-input classification, strict text decoding and raw resources).
Each measurement reports project loading separately from the four frozen action-path classes. It
calibrates 100 actual frames in the selected mode and rejects a run that does not produce all 100
frames. It performs one disposable warmup, then five baselines against the one reusable project
copy. CPU and allocation rounds run separately at a checkpoint using `sample`, `heap`, `vmmap`,
`leaks` and `malloc_history`. Evidence files are hashed; child stdout/stderr are streamed directly
into `.txt.gz` archives while only bounded summary records remain in memory. This compression
applies after the trace's structural cursor and deduplication limits and is not used to make an
oversized trace acceptable. Profiled timing with more than 5% overhead is retained only for hotspot
attribution.
The outer runner owns one shared 60-minute deadline across calibration, warmup, five baselines and
both profiler rounds; child sessions receive that same deadline rather than starting new budgets.

The default visible mode remains unchanged. In minimized mode, after WebDriver connects, the runner
issues the standard WebDriver minimize command and starts testing directly. Do not add safe-state
waits or startup/periodic minimized-state, focus or foreground-owner assertions in either mode.
Minimized is the only invisible path. Lightweight runtime progress observations remain available
while minimized. Telemetry, profiler and
process metadata are excluded from the progress signature, so instrumentation cannot hide a frozen
game. The audit never invokes native OS keyboard/mouse injection or a system picker.

On macOS, an explicitly enabled minimized audit holds a Foundation
`UserInitiatedAllowingIdleSystemSleep` activity for its event-loop lifetime. In a recorded replay,
semantic DOM input did not prevent every native thread dropping to scheduling priority 4 mid-run;
the priority observation alone does not identify the exact responsible macOS policy. The activity
marks the whole replay as user-requested work and is released when
the synchronous activity block returns (or the test process exits). It does not prevent display or
system sleep, change a global preference, or manually raise thread priority. Production builds and
the default visible audit path do not acquire this activity. Startup emits
`tauri-performance-activity` with the activity mode so evidence can distinguish this environment
from older potentially throttled runs. Do not label a latency improvement caused by this scheduling
correction as a core/game optimization, or compare the two environments as identical baselines.
