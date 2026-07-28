# Page and frontend observation

The runner launches Chromium with `VITE_RUSTYERA_TEST=1`. Only that build installs
`window.__RUSTYERA_TEST__`; production builds do not expose it.

Use Playwright actions for gameplay and visible UI behavior. The runner may use the test global
only for lifecycle setup and observation:

- `configure({start, clock, monotonicStartNs})`: set explicit seed or restore bytes and deterministic
  services before opening the project.
- `waitForStableObservation(timeoutMs)`: wait for a stable input or terminal state.
- `snapshot()`: return a serializable projection containing phase, epoch, wait, full canonical
  presentation text/HTML island, status, fault/log tail, and debugger state.
- `inspect(watches)`: pause through debug protocol v4, read named/indexed variables, then continue
  if the call initiated the pause.

The Playwright-injected directory handle proxies an isolated project copy. It validates every path
against that root and implements the same project scan, resource, compiled-cache, and storage paths
as `BrowserBridge`. Never weaken this path boundary or enable the test global in a production build.

Canonical presentation text is the differential source of truth because virtual history means the
live DOM may contain only visible rows. DOM queries remain the source of truth for rendered
visibility, accessibility, attributes, HTML islands, menus, dialogs, focus, and enabled state.
