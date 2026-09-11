# Original upstream 7b69 Web client fixture

This Japanese `emuera.em` fixture consumes original core semantic/policy 3. It saves
slot 0 through production storage, checks version 42 and missing-slot clearing,
observes first-wins aliases plus a later valid alias, and compares constant/runtime
UTF-16 legacy lengths and find positions. FLAG watches survive INPUT replacing RESULT.
Input 7 prints UPSTREAM_CONTINUED and waits again.

Use `tools/runtime-tester/scenarios/upstream-7b69.json` through `npm run test:game`
with an explicit existing Chromium executable. Native Firefox/Safari use
`npm run test:browser-compat` with `--project`, `--expect-output UPSTREAM_READY`
and `--expect-watches tests/fixtures/upstream-7b69-watches.json`. Tauri uses the
`upstream-compatibility.spec.mjs` profile and an isolated project copy; build once
with `--build-only --reuse-build`, then require the same verified artifact with
`--require-reuse-build`.

All runs require real production host paths and the independent five-second complete
DOM/runtime watchdog. This fixed Web matrix checks the three visible semantics;
old cache/snapshot rejection in batch C is separately exercised through TUI's real
C ABI with artifacts generated and successfully read by the old pinned core.
No Web rejection scenario or historical state container is supplied by this fixture.
Input files alone do not establish acceptance; final evidence belongs to the completed
core compatibility implementation record.
