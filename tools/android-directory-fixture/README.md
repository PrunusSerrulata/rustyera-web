# Android directory-picker fixture

This fixture keeps Android directory-picker checks independent from full games. It contains 21
small files (about 100 KiB) and exercises source/config discovery plus resource-manifest parsing,
PNG and WebP metadata/decoding, deferred resource reads, and MP3 playback.

## Device setup

Use a unique destination so the test never overwrites an existing download:

```sh
adb shell test ! -e /sdcard/Download/rustyera-android-media-fixture
adb push tools/android-directory-fixture/fixture /sdcard/Download/rustyera-android-media-fixture
adb reverse tcp:5173 tcp:5173
VITE_RUSTYERA_TEST=1 npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://localhost:5173` on the device. The reversed localhost URL is required so browsers
treat the page as a secure context and expose directory APIs.

For browser inspection, forward only the browser being tested:

```sh
adb forward tcp:9222 localabstract:chrome_devtools_remote
adb forward tcp:6000 localabstract:org.mozilla.firefox/firefox-debugger-socket
```

Chrome DevTools may then inspect the exact localhost test tab through port 9222. Firefox requires
**Remote debugging via USB** to be enabled in its developer settings before the RDP socket is
available. Turn that setting off and remove both forwards after the run. Firefox 153 and later may
show its onboarding pages again when GeckoDriver creates a session; dismiss **Continue** and
**Not now** through the visible UI before attaching RDP. Do not treat profile preferences as proof
that onboarding was skipped.

## Picker cases

- Chromium: select `rustyera-android-media-fixture`, accept Android's **Use this folder** dialog,
  then accept the browser's **Allow this site to edit files?** dialog. Confirm that the native
  directory-handle path is used.
- Firefox: select the same folder and accept both native dialogs. Confirm that the fallback
  directory input supplies a `FileList`; do not substitute a packaged project file.
- Repeat from both the Downloads root and from inside the previously selected folder. Locate
  controls by their current text and bounds because DocumentsUI remembers its last location.

At the Downloads root, select the folder itself before pressing **Use this folder**. If DocumentsUI
has already entered the folder, use the current-folder action instead; do not select one of the
fixture's child directories. A Chromium run is not authorized until all three layers have completed:
DocumentsUI selection, Android's folder confirmation, and Chrome's edit-files confirmation. A
Firefox fallback run must retain the hidden directory input until all selected provider-backed
resources have been read.

Successful loading must show `TITLE_CHARANUM=0`, `ORACLE_READY`, and
`ANDROID_DIRECTORY_MEDIA_READY`. The runtime snapshot must contain both image placements and an
audio channel for `sound/fixture.mp3`; browser resource requests must complete without missing-file
or decode errors.

During automation, capture a complete DOM/runtime snapshot every five seconds and abort as soon as
two normalized snapshots are identical. The only exception is Firefox's native handoff after
DocumentsUI confirms a directory but before Firefox displays its upload confirmation or delivers
the `FileList`: provider-backed files are copied outside the page during this interval, so identical
black/native snapshots are expected. Continue recording the last complete DOM, full Android UI
hierarchy, Firefox process/foreground state, and RDP target; wait until Firefox returns, unless the
process/target disappears, a native error/cancellation appears, or the test budget expires. Resume
the ordinary identical-snapshot failure rule immediately after Firefox returns.

Do not serialize picker actions behind the five-second snapshot loop. Poll CDP/RDP page state about
every 100 ms and run the next UIAutomator hierarchy dump as soon as the prior one finishes (with at
most a 250 ms debounce). Click the exact expected control as soon as it appears. In particular, do
not sleep five seconds between project-loss confirmation, Downloads navigation, folder selection,
**Use this folder**, Android permission, and the browser confirmation. Use ADB pointer input for the
Web button that opens the picker; JavaScript `element.click()` loses the required user activation.

Clean up only the uniquely named fixture and port mappings:

```sh
adb shell rm -r /sdcard/Download/rustyera-android-media-fixture
adb reverse --remove tcp:5173
adb forward --remove tcp:9222
adb forward --remove tcp:6000
```

The fixture is the correctness smoke test. Use a full project only after it passes, and only for the
large-directory regression or a measured performance baseline. For Chrome SAF profiling, keep the
real directory handle, cancel the application's scan deliberately, and publish actual enumeration,
`getFile()`, and content-read completion in the inspected page. The resulting **cancelled opening
project** state is expected for that diagnostic flow; it is not a successful load. Stop audio or
close the exact test tab immediately after the terminal assertions so the fixture MP3 does not loop.

## Firefox depth-limit regression

`firefox-depth-limit-fixture` is a separate negative fixture for Firefox's Android directory-input
fallback. It contains one source at directory depth five and another at depth six, plus a portable
source index that records both. Select the fixture directory itself from Downloads. Android Firefox
must reject the incomplete `FileList` before import and name
`erb/a/b/c/d/e/depth-overflow.erb` as missing; it must not continue into compiler errors. Chromium
must enumerate both files. This fixture intentionally stays separate from the media fixture so the
ordinary correctness smoke test remains loadable in every supported browser.
