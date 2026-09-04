import {
  nativeWebdriverOption,
  validateNativeWebdriverSource,
} from "../scripts/tauri-native-webdriver-support.mjs";

import {
  compiledBuildInputs,
  fileIdentity,
  recordBuiltArtifact,
  reusableArtifact,
  reusableBuildEnvironment,
} from "../scripts/tauri-build-cache.mjs";

import {
  observePendingCanvas,
  assertCancelledLifecycle,
  lifecycleRestartReady,
  lifecycleSession,
} from "../scripts/snake-service-lifecycle-races.mjs";

import {
  assertLifecyclePointer,
  assertSampledLifecyclePointer,
  assertBlurPointer,
  hoverLifecycleTarget,
  installPointerObservation,
  observeRealWindowBlur,
  setLifecyclePrompt,
  lifecycleViewport,
  pageUpLifecycleViewport,
} from "../scripts/snake-service-lifecycle-test-support.mjs";

import {
  assertSnakeServiceState,
  runSnakeServicesClient,
  SNAKE_SERVICE_MARKERS,
} from "../scripts/snake-services-test-support.mjs";

import path from "node:path";

import { Buffer } from "node:buffer";

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { gunzipSync } from "node:zlib";

import { Encoder } from "cbor-x";

import {
  CaptureWriter,
  hashFile,
  inventory,
  selectCaptureCase,
  sha256,
} from "../scripts/snake-service-capture-io.mjs";

import {
  captureTerminal,
  runServiceOracleCapture,
  serviceOracleReady,
  serviceOracleExportReady,
  serviceOracleReadyMarker,
} from "../scripts/snake-service-capture-client.mjs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSnakeDisplayState,
  assertSnakeDataState,
  runSnakeDataClient,
  SNAKE_DATA_MARKERS,
  SNAKE_DATA_START,
} from "../scripts/snake-data-test-support.mjs";

import {
  assertSnapshotProgress,
  captureCompleteTauriSnapshot,
  expandCompleteTauriSnapshot,
  focusCurrentTauriWindow,
  resolveTauriBinary,
  snapshotCaptureTimeout,
  snapshotProgressSignature,
  startTauriSessionMonitor,
} from "../scripts/tauri-test-support.mjs";

import { assertStructuredSnakeProfileNotifications } from "./tauri/structured-profile-notifications.mjs";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
  delete window.__RUSTYERA_TEST__;
});

export {
  Buffer,
  CaptureWriter,
  Encoder,
  SNAKE_DATA_MARKERS,
  SNAKE_DATA_START,
  SNAKE_SERVICE_MARKERS,
  afterEach,
  assertBlurPointer,
  assertCancelledLifecycle,
  assertLifecyclePointer,
  assertSampledLifecyclePointer,
  assertSnakeDataState,
  assertSnakeDisplayState,
  assertSnakeServiceState,
  assertSnapshotProgress,
  assertStructuredSnakeProfileNotifications,
  captureCompleteTauriSnapshot,
  captureTerminal,
  compiledBuildInputs,
  describe,
  expandCompleteTauriSnapshot,
  expect,
  fileIdentity,
  focusCurrentTauriWindow,
  gunzipSync,
  hashFile,
  hoverLifecycleTarget,
  installPointerObservation,
  inventory,
  it,
  lifecycleRestartReady,
  lifecycleSession,
  lifecycleViewport,
  mkdir,
  mkdtemp,
  nativeWebdriverOption,
  observePendingCanvas,
  observeRealWindowBlur,
  pageUpLifecycleViewport,
  path,
  readFile,
  recordBuiltArtifact,
  resolveTauriBinary,
  reusableArtifact,
  reusableBuildEnvironment,
  rm,
  runServiceOracleCapture,
  runSnakeDataClient,
  runSnakeServicesClient,
  selectCaptureCase,
  serviceOracleExportReady,
  serviceOracleReady,
  serviceOracleReadyMarker,
  setLifecyclePrompt,
  sha256,
  snapshotCaptureTimeout,
  snapshotProgressSignature,
  startTauriSessionMonitor,
  symlink,
  tmpdir,
  validateNativeWebdriverSource,
  vi,
  writeFile,
};
