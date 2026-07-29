# RustyEra Vue frontend

`era-web` is one Vue 3 application with two runtime hosts:

- Tauri 2 runs `era-runtime` natively on Windows, macOS, and Linux.
- Desktop Chromium runs the same Rust bridge as WebAssembly in a dedicated Web Worker.

The Vue components, Pinia state, presentation renderer, media engines, dialogs, debugger,
storage request handling, and preferences UI are shared. Platform code is limited to project and
configuration I/O plus the runtime transport.

## Development

Node.js 24 and the Rust workspace toolchain are supported. Runtime and protocol crates are pinned
to the exact [rustyera-core](https://github.com/PrunusSerrulata/rustyera) commit recorded in
`rustyera-core.rev`; `npm run check:core-rev` rejects drift. Install the frontend dependencies and
build the WebAssembly package before browser development:

```sh
npm ci
npm run check:core-rev
npm run build:wasm
npm run dev
```

`wasm-pack` is required for `build:wasm`. On macOS, Apple clang does not ship a WebAssembly
backend; when Zig is installed, the build launcher automatically uses the included target adapter
for the bundled zstd dependency without changing its wire format. CI can set `RUSTYERA_WASM_PACK`
to an isolated `wasm-pack` executable instead of modifying `PATH`.

The generated `public/wasm` directory is a build artifact and must not be committed. For the native
application, run `npm run tauri dev`; release packages use `npm run tauri build`.

In the standard sibling checkout, the outer `.cargo/config.toml` patches the pinned Git crates to
`../rustyera-core` and shares `../target`. A standalone checkout uses the pinned Git revision and its
own ignored `target`, so neither build mode requires repository-local path dependencies.

## Testing

Install the E2E Chromium build once, then run the frontend checks:

```sh
npm run test:e2e:install
npm run check:core-rev
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run build:wasm
npm run test:e2e
```

Deterministic game-flow tests use the real Vue UI and browser WASM worker:

```sh
npm run test:game -- run --scenario tools/runtime-tester/scenarios/reference-fixture.json
npm run test:game -- serve --scenario tools/runtime-tester/scenarios/eratw-autonomous.json
```

`run` consumes a fixed action sequence. `serve` continues over NDJSON stdin after the fixed prefix,
allowing an agent to inspect state, query DOM elements, and choose later inputs. Omit `seed` for a
random seed recorded in the trace; set it to reproduce a run. Override long-test projects with
`--project`, and enable Emuera comparison with a scenario's `comparison.reference` plus
`--reference-command` (and `--reference-path-command` for Wine when required).

The Playwright wrapper stores Chromium in the fixed local directory `.playwright-browsers` under
this frontend. The directory is ignored by Git and survives ordinary `npm ci` runs, so subsequent
E2E tests do not download the browser again. Set `PLAYWRIGHT_BROWSERS_PATH` only when CI or another
isolated environment needs a different cache location. Re-run `npm run test:e2e:install` after a
Playwright upgrade requests a newer browser revision.

## Browser requirements

The complete browser experience targets current desktop Chromium over HTTPS or localhost. It uses
File System Access for direct project-directory I/O and Local Font Access for the session-fixed
font list. The user must grant read/write access; the application does not copy a game into
IndexedDB. IndexedDB stores only global preferences and the last directory handle.

Other browsers receive a clear unsupported-capability error rather than silently switching storage
semantics. Tauri remains the portable desktop option. Mobile, video, MIDI, and WMA are not
supported. Project source is normalized to UTF-8 at the frontend boundary from strict UTF-8,
Windows-31J, or GBK input.

## Rendering and media

Canonical presentation state remains complete while TanStack Virtual limits live history DOM.
Runtime work, project hashing, and WASM execution stay outside Vue's main rendering path. Deltas are
applied by revision, gaps request a runtime resynchronization, and stable line IDs preserve button
capabilities.

PNG, BMP, GIF, JPEG, and WebP are rendered from project resources. Runtime canvas replay uses
Canvas2D. WAV, MP3, Ogg/Opus, AAC/M4A, and FLAC use Web Audio when the platform decoder accepts the
file; unsupported codecs produce a frontend diagnostic. The global volume is a projection-only
master gain and never mutates script state.

All application-owned dialogs share the accessible `DraggableDialog` shell. System directory,
file, and permission pickers remain platform-owned and therefore are not draggable by the app.
