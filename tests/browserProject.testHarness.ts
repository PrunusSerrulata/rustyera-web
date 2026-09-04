import storagePatternVectors from "./fixtures/snake-storage-patterns.json";

import { storagePattern } from "@/platform/storagePattern";

import { referenceCompatibility, snakeCompatibility } from "./compatibilityTestSupport";

import { describe, expect, it, vi } from "vitest";

import { blake3 } from "@noble/hashes/blake3.js";

import { compatibilityCbor } from "@/core/compatibility";

import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";

import {
  BrowserProject,
  cacheIdentityManifest,
  decodeProtocolBytes,
  decodeProjectSource,
  normalizeResourceManifest,
  runBounded,
  saveSlotName,
  scanBrowserProjectFile,
} from "../src/platform/browserProject";

import { dispatchBrowserStorage } from "@/platform/browserProjectStorage";

import { createProjectProgressReporter } from "@/platform/browserProjectUtilities";

import {
  FailingIndexDirectoryHandle,
  SaveDirectoryHandle,
  SaveFileHandle,
  writeFixtureFile,
} from "./browserProjectTestSupport";

function referenceProject(...args: ConstructorParameters<typeof BrowserProject>): BrowserProject {
  const project = new BrowserProject(...args);
  project.bindResolvedCompatibility(referenceCompatibility(), null);
  return project;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function manifestIdentityHex(manifest: {
  files: Array<{ relative_path: string; category: string; content_hash: Uint8Array }>;
}): string {
  const categoryCodes: Record<string, number> = {
    csv: 0,
    erh: 1,
    erb: 2,
    resource_manifest: 3,
    resource: 4,
    configuration: 5,
    als: 6,
    erd: 7,
  };
  const encoder = new TextEncoder();
  const identity: number[] = [];
  for (const file of manifest.files) {
    const category = categoryCodes[file.category];
    if (category === undefined) throw new Error(`unknown test category ${file.category}`);
    const path = encoder.encode(file.relative_path);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(path.byteLength), true);
    identity.push(...length, ...path, category, ...file.content_hash);
  }
  return Array.from(
    blake3(Uint8Array.from(identity), {
      context: encoder.encode("rustyera.project-source-identity.v1"),
    }),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

export {
  BrowserProject,
  FailingIndexDirectoryHandle,
  SaveDirectoryHandle,
  SaveFileHandle,
  blake3,
  cacheIdentityManifest,
  compatibilityCbor,
  createProjectProgressReporter,
  decodeProjectSource,
  decodeProtocolBytes,
  decodeServicePayload,
  deferred,
  describe,
  dispatchBrowserStorage,
  encodeServicePayload,
  expect,
  it,
  manifestIdentityHex,
  normalizeResourceManifest,
  pngHeader,
  referenceCompatibility,
  referenceProject,
  runBounded,
  saveSlotName,
  scanBrowserProjectFile,
  snakeCompatibility,
  storagePattern,
  storagePatternVectors,
  vi,
  writeFixtureFile,
};
