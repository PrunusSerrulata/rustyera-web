# Tauri loading and runtime performance audit

The test-only Tauri performance audit is the single authoritative performance probe in this
repository for both project loading and steady runtime. It is compiled only with the
`performance-audit` Cargo feature and
`VITE_RUSTYERA_PERF_AUDIT=1`; normal Tauri and Web builds do not create telemetry buffers or run
the audit timing branches.

The former `rorona-settlement-performance.spec.mjs` probe and its
`rustyera:settlement-*` performance marks were removed. They required a visible focused window,
duplicated part of the native-to-paint timing chain, and cannot be used by the background-only
audit policy.

The former standalone `scripts/startup-benchmark.mjs` implementation and its private aggregation
schema were also removed. `benchmark:startup` is now only an alias for the same unified Tauri
runner, so it requires the same frozen trace, isolated project, background window policy and
evidence directory. The unified JSONL sample schema always includes `schemaVersion`, `epoch`,
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

The checked-in `tests/fixtures/snake-runtime-performance-trace.v1.json` is intentionally marked
`captureRequired: true`. It is a schema/template, not fabricated evidence. A future autonomous
background play session must record the real snake TW path, then freeze a versioned trace with:

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

Capture is driven by `audit:tauri-performance-capture -- capture`: a low-reasoning autonomous
player appends JSONL `action` records to an isolated inbox after each emitted observation. The same
background Tauri lifecycle executes each DOM input/click/hover and atomically updates a candidate;
manual editing is not a capture path. DOM clicks must include their `semanticInput`. After review,
`audit:tauri-performance-capture -- freeze` requires distinct `--output` and `--core-output` paths.
It writes the frozen Tauri trace plus a deterministic Core `perf-run` companion derived from that
one capture artifact. The Tauri trace schema and Core trace schema are independently versioned;
they share the scenario, Core-compatible project digest, seed, semantic protocol actions and
checkpoint content, not a coincidentally equal schema number. The template contains only null Core
identity placeholders. Capture exports the exact `era-web-bridge::client_hello`
features/capabilities for that native session—including negotiated fonts/audio—and combines them
with the actual pre-start frontend setup messages under a hashed capture identity. Freeze rejects
placeholders or a client missing the rich-text, HTML, graphics, mouse and storage capabilities
required by this workload. The candidate also stores full normalized Core checkpoints. Every non-hover Web action must
map to the exact captured `input`, `service_response` or `storage_response` protocol actions; freeze
rejects a click or service sequence that cannot be mapped losslessly. Hover-only steps remain
frontend-only. The emitted companion contains only fields accepted by Core's strict serde schema.

```text
npm run audit:tauri-performance-capture -- capture --project /absolute/snake-tw \
  --template tests/fixtures/snake-runtime-performance-trace.v1.json \
  --candidate /absolute/evidence/candidate.json --actions /absolute/evidence/actions.jsonl

npm run audit:tauri-performance-capture -- freeze \
  --candidate /absolute/evidence/candidate.json \
  --output /absolute/evidence/trace.v1.json \
  --core-output /absolute/evidence/core-trace.v1.json
```

Each inbox line is `{"type":"action","path":"…","action":{…},"watches":[…],
"evidence":{…},"coreSteps":[…]}`, a post-observation
`{"type":"core_steps","sourceWebStep":0,"coreSteps":[…]}`, or `{"type":"finish"}`. Supported actions are input, DOM click (with
`selector`, exact `expectedText`, and `semanticInput`) and DOM hover. The capture process emits the
canonical post-action observation and its resolved protocol-action delta before accepting the next
choice. Each `coreSteps` entry carries an exact Core action plus the corresponding full
`normalizedState`; the freezer derives `phase`, wait kind, service/storage expectations, variables
and `stateSignature` from that state. Candidate editing is not an accepted substitute for capture.

After capture is reviewed and frozen, use the isolated outer runner:

```text
npm run audit:tauri-performance -- --project /absolute/snake-tw-copy-source \
  --trace /absolute/frozen-trace.v1.json --output /absolute/empty-evidence-directory
```

The runner validates the snake profile, source/copy realpaths and the same project digest framing
used by Core `perf-run` (submitted-input classification, strict text decoding and raw resources).
Each measurement reports project loading separately from the four frozen action-path classes. It calibrates 100 actual frames
in both minimized and fully off-screen/unfocused modes, chooses off-screen when minimized timing
differs by more than 20% or has a non-business stall over 100 ms, performs one disposable warmup,
then five baselines in independent project copies. CPU and allocation rounds run separately at a
checkpoint using `sample`, `heap`, `vmmap`, `leaks` and `malloc_history`. Evidence files are hashed;
profiled timing with more than 5% overhead is retained only for hotspot attribution.
The outer runner owns one shared 60-minute deadline across calibration, warmup, five baselines and
both profiler rounds; child sessions receive that same deadline rather than starting new budgets.

The performance window starts hidden and non-focusable. Minimized mode minimizes before its first
show; off-screen mode moves beyond the union of all displays before show. The five-second watchdog
asserts placement, focus, foreground ownership and the exact launched PID tree. Telemetry,
profiler and process metadata are excluded from its progress signature, so instrumentation cannot
hide a frozen game. The audit never invokes native keyboard/mouse input or a system picker.
