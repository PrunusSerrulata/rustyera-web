import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { TextEncoder } from "node:util";

import { runInNewContext } from "node:vm";

import { blake3 } from "@noble/hashes/blake3.js";

import { describe, expect, it, vi } from "vitest";

import {
  assertAtomicPresentationTransition,
  browserProjectProgressErrors,
  packagedProjectProgressErrors,
  compactTraceEvent,
  compareObservations,
  goalStatus,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  isolatedProject,
  installRemoteFileSystem,
  loadScenario,
  nativeFirefoxCapabilities,
  focusNativeBrowser,
  publishCrossHostArtifacts,
  resolveLocator,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  runAction,
  TraceWriter,
  terminalRuntimeRejection,
  waitForWebDriverDocument,
  waitForRuntimeObservation,
  waitForAutomaticWaitChange,
} from "../scripts/web-test-lib.mjs";

import { SNAKE_DATA_MARKERS } from "../scripts/snake-data-test-support.mjs";

import { snakeAudioRelations, snakeAudioStressRelations } from "../scripts/web-test-runtime.mjs";

export {
  SNAKE_DATA_MARKERS,
  TextEncoder,
  TraceWriter,
  access,
  assertAtomicPresentationTransition,
  blake3,
  browserProjectProgressErrors,
  compactTraceEvent,
  compareObservations,
  describe,
  expect,
  focusNativeBrowser,
  goalStatus,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  installRemoteFileSystem,
  isolatedProject,
  it,
  loadScenario,
  mkdir,
  mkdtemp,
  nativeFirefoxCapabilities,
  packagedProjectProgressErrors,
  path,
  publishCrossHostArtifacts,
  readFile,
  resolveLocator,
  rm,
  runAction,
  runInNewContext,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  snakeAudioRelations,
  snakeAudioStressRelations,
  stat,
  terminalRuntimeRejection,
  tmpdir,
  vi,
  waitForAutomaticWaitChange,
  waitForRuntimeObservation,
  waitForWebDriverDocument,
  writeFile,
};
