# Page and frontend observation

The runner launches Chromium with `VITE_RUSTYERA_TEST=1`. Only that build installs
`window.__RUSTYERA_TEST__`; production builds do not expose it.

Use Playwright actions for gameplay and visible UI behavior. The runner may use the test global
only for lifecycle setup and observation:

- `configure({start, clock, monotonicStartNs})`: set explicit seed or restore bytes and deterministic
  services before opening the project.
- `waitForStableObservation(timeoutMs)`: wait for a stable input or terminal state.
- `snapshot()`: return a serializable projection containing phase, epoch, wait, full canonical
  presentation text/HTML island and recoverable audio channels, test-only audio playback start/active
  counters, status, fault/log tail, and debugger state.
- `inspect(watches)`: pause through debug protocol v4, read named/indexed variables, then continue
  if the call initiated the pause.
- `replaceProjectSource`, `reloadProject`, and `exportDiagnosis`: test-only lifecycle controls for
  real isolated-project hot reload and diagnosis scenarios. They delegate to the injected bounded
  filesystem and the production store methods; they do not mutate Pinia state directly.

The Playwright-injected directory handle proxies an isolated project copy. It validates every path
against that root and implements the same project scan, resource, compiled-cache, and storage paths
as `BrowserBridge`. Never weaken this path boundary or enable the test global in a production build.

End-to-end progress reporting must call the observation surface every 5 seconds from launch through
exit and combine it with a full `document.querySelectorAll("*")` enumeration. For every element,
record tag, attributes, text/value, and visibility. Compare canonical snapshots after excluding
timestamps and other reporting-only metadata. If a snapshot equals the preceding 5-second
snapshot, immediately terminate the run as stalled; do not wait for a longer action, stage, or
scenario timeout. Android Firefox's post-DocumentsUI, pre-`FileList` provider-copy interval is the
only exception: the page may temporarily be black or inaccessible, so retain the last complete DOM
alongside native hierarchy/process/RDP evidence until Firefox returns. This exception ends before
project importing or runtime loading begins.

Run picker actions and complete-snapshot capture on independent schedules. Picker/page state should
normally be polled about every 100 ms, and Android UI hierarchy should be dumped again immediately
after each prior dump completes; do not make the mandatory 5-second observation interval a minimum
wait between actions.

Canonical presentation text is the differential source of truth because virtual history means the
live DOM may contain only visible rows. DOM queries remain the source of truth for rendered
visibility, accessibility, attributes, HTML islands, menus, dialogs, focus, and enabled state.
