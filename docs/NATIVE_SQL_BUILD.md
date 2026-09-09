# Opt-in native SQL builds

`era-web-tauri` exposes the optional `native-sql` Cargo feature. It is not a default
feature; ordinary builds without it retain the existing product configuration and
do not prebuild SQLite. Current local integration uses the outer workspace Cargo
patch for actual core sources. The recorded core pin is
`b55f3a06d5683814311c10270895283d027e7135`; these local commits are not yet remotely
published. This does not establish a remotely reproducible release binding.

From `rustyera-web`, the official local launcher automatically prepares the exact
SQLite archive before Cargo resolves/builds the native dependency:

```sh
npm run cargo:local -- build -p era-web-tauri --features native-sql --target aarch64-apple-darwin
```

No extra environment switch is required for this feature invocation. The launcher
also recognizes comma/space separated or repeated `--features`, `--features=...`,
`-F`, `era-web-tauri/native-sql` and `--all-features`. Prebuilding applies to build,
check, clippy, test, run, bench and rustc; metadata/formatting do not prebuild.
Cargo arguments after its `--` separator do not enable features. The official
nested `npm run tauri -- build ...` command's forwarded feature list is recognized.
The launcher's lockfile backup and restoration preserve the existing local lockfile.

The existing exact builder supports native macOS arm64/x64 and Linux GNU arm64/x64
only. Target must equal the compiler host and supported local platform/ABI.
Cross compilation, Windows and Linux musl are not supported by this opt-in path.
No browser, SDK, compiler or replacement SQLite is downloaded. Use the appropriate
native target on those supported hosts; the example above is for macOS arm64.

`--target` selects the Rust target, followed by `CARGO_BUILD_TARGET`, then the
builder's `rustc -vV` host detection. `RUSTYERA_SQLITE_NATIVE_OUTPUT` selects an
isolated archive directory; otherwise the builder uses workspace
`target/sqlite-native/<target>`. Keep target, output, compiler, SDK and tuning
environment identical between preparation and cache lookup.

## Official Tauri performance/test runner

The runner's explicit `RUSTYERA_NATIVE_SQL_PROVIDER=1` opt-in now appends
`native-sql` to its actual Cargo feature list: `webdriver,native-sql`, or
`webdriver,performance-audit,native-sql` when performance instrumentation is
enabled. Absent or `0` leaves the original feature list unchanged. Set this
variable on the existing official fixed-replay/performance invocation to build
the experimental native handler. It does not change default production enablement
or establish performance acceptance.

The legacy environment opt-in still requests prebuilding through `cargo:local`.
For ordinary Cargo usage, enable the Cargo feature as shown above to select the
optional provider dependency; the environment variable alone is not a Cargo feature.

Cache inspection always calls the SQLite builder with `cacheOnly: true`, including
normal `--reuse-build` inspection. Prepare SQLite before entering that workflow:

```sh
node ../rustyera-core/tools/sqlite-native/build.mjs --target aarch64-apple-darwin
```

Use `RUSTYERA_NATIVE_SQL_PROVIDER=1` on both the runner's build and replay/cache-only
invocations. `--require-reuse-build` must find an existing matching application
artifact; a miss does not build or start the GUI. Setting
`RUSTYERA_SQLITE_NATIVE_CACHE_ONLY=1` also prohibits archive compilation by the Cargo
launcher. Missing or changed SQLite inputs stop before Cargo/lockfile mutation.

The application cache records explicit feature identity, actual verified archive
and header hashes, SQLite engine/source identity, target, all builder compile
flags and generated link environment, plus the actual patched core source inputs.
Feature toggles invalidate reuse even when the legacy environment switch stays
unchanged. Archive/source/compiler/flag changes cannot be accepted using only a
matching version string.

WASM/wasm-pack builds continue to clear inherited `SQLITE3_*`, `LIBSQLITE3_*`,
`RUSTYERA_SQLITE_*` and `RUSTYERA_NATIVE_SQL_PROVIDER`, and never prebuild native
SQLite, including when native feature arguments are present. Cargo still owns
feature validity; clearing native environment does not make a native-only feature
usable in WASM.

## Cancellation and storage deadlines

One native SQL request has a 30-second transport deadline; the independent SQLite
execution limit remains 5 seconds. The storage callback receives the remaining
request deadline and a shared cancellation signal. Project/session retirement
signals cancellation before waiting for the session, storage, project or SQL owner
locks. SQLite progress callbacks and storage checkpoints reject further work and
late continuations; a cancelled owner never falls back to the Web Worker or retries
publication automatically.

Storage checks cancellation before visible mutations, including after temporary
file writes/fsync and immediately before atomic replacement. A filesystem syscall
already in progress cannot be forcibly interrupted by this boundary. Consequently
30 seconds is **not** an end-to-end hard upper bound when the operating system or
filesystem is stalled: cancellation and destruction can remain pending until that
syscall returns. No new continuation is then accepted. An entered publication may
already have committed; transport failures conservatively retain an unknown
database-publication outcome instead of claiming rollback. Structured provider
responses retain their existing committed/not-committed/unknown classifications.

No detached storage task is allowed to keep writing to an old project after the
owner is retired. Retirement waits for the active callback and confirmed SQLite
owner shutdown before releasing/reusing its cancellation state.
