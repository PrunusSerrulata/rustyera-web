# Native input for the macOS test host

The pinned `tauri-plugin-wdio-webdriver` 1.2.0 provider normally synthesizes DOM
input. This opt-in overlay routes WebdriverIO selector/actions through the
session's actual WKWebView and NSWindow, so tests can observe trusted pointer,
keyboard and window-focus events. It never posts global input or invokes a
RustyEra test-global to submit input.

Pointer commands synchronize the actual system cursor with the verified window
point before delivering the window event. This prevents later native hit testing
from observing an old cursor position after layout changes. The mapping uses
logical screen points, including displays above or left of the primary display;
off-screen positions and CoreGraphics failures are rejected. These tests require
an available desktop: do not run them while someone uses the mouse or keyboard.

`original-inventory.json` binds the immutable upstream source to registry checksum
`30c5bffe978c41b06ad44a5f4b5b543405918cf316b98756c678a6431061f2e9`.
`overlay-manifest.json` and `overrides/` define the replacement files;
`native-input.patch` records their delta. `LICENSE.upstream` preserves the MIT
license. The executor changes replace two integer casts unavailable at the
provider's declared Rust 1.77 minimum with equivalent same-width casts.

## Materialize and use

Use an already installed, unchanged upstream source. No download is performed:

```sh
python3 tools/tauri-native-webdriver/prepare_provider.py \
  --source /path/to/tauri-plugin-wdio-webdriver-1.2.0 \
  --output /new/task-output/native-provider
npm run test:tauri -- --spec tests/tauri/native-input.spec.mjs \
  --project /path/to/fixed-fixture \
  --native-webdriver-source /new/task-output/native-provider
```

The runner validates the complete materialized inventory before and after the
build, records its identity, and passes a temporary Cargo patch only to the
test host. Existing lock restoration remains in force. Ordinary builds, product
manifests, core pins and the registry are unchanged. Do not commit the generated
provider or reuse a binary built without this override.

The independent native probe must pass before service scenarios use the provider.
Compilation alone does not establish trusted events. The probe observes native
clicks, Unicode input/clear, Enter, PageUp and real window blur, with the ordinary
complete DOM/runtime watchdog. It does not run a replacement game/runtime.

## Limits

Native input supports the primary mouse button, Unicode characters and the
explicitly mapped WebDriver navigation/modifier keys. Unknown keys, other
buttons, wheel actions and nested-frame native input fail explicitly. Selector
scrolling and geometry remain DOM reads/actions; input is native. Native down/up
generates the click, so the upstream extra synthetic click is suppressed.

At most two independent `about:blank` focus probes may exist. Only those probe
windows can be closed through this provider; the main application window is
protected. Focus switching validates the handle and focuses the actual window
before updating the session. Cursor synchronization does not generate an event;
there is no global event-posting or permission fallback.
